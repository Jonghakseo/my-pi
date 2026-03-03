import type { ExtensionAPI, ExtensionContext, InputEventResult } from "@mariozechner/pi-coding-agent";
import { copyToClipboard } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";

import { buildMemoryPrompt } from "./inject.ts";
import { resolveProjectId } from "./project-id.ts";
import {
	ensureDir,
	listTopics,
	loadTopicEntries,
	memoryExistsInScope,
	migrateFromJson,
	readMemoryMd,
	readTopicFile,
	removeMemory,
	type SearchResult,
	sanitizeTopic,
	saveMemory,
	searchMemories,
} from "./storage.ts";
import type { MemoryScope } from "./types.ts";
import { ForgetParams, MemoryListParams, RecallParams, RememberParams } from "./types.ts";
import {
	MemoryActionMenuComponent,
	MemoryDeleteConfirmComponent,
	MemoryDetailOverlayComponent,
	type MemoryMenuAction,
	MemorySelectorComponent,
} from "./ui.ts";

// ── Extension Entry Point ────────────────────────────────────────────────────

export default function memoryLayerExtension(pi: ExtensionAPI) {
	let currentProjectId: string | undefined;
	let migrationDone = false;

	// ── Helpers ────────────────────────────────────────────────────────────

	function resolveCurrentProjectId(cwd: string): string | undefined {
		try {
			return resolveProjectId(cwd).id;
		} catch {
			return undefined;
		}
	}

	function truncateTitle(content: string, maxLen = 60): string {
		const firstLine = content.split("\n")[0]?.trim() ?? content.trim();
		if (firstLine.length <= maxLen) return firstLine;
		return `${firstLine.slice(0, maxLen - 1)}…`;
	}

	/** Convert slug to a human-readable heading. */
	function slugToHeading(slug: string): string {
		return slug
			.split("-")
			.map((w) => w.charAt(0).toUpperCase() + w.slice(1))
			.join(" ");
	}

	async function promptTopic(
		ctx: ExtensionContext,
		scope: MemoryScope,
		projectId: string | undefined,
	): Promise<{ slug: string; heading: string } | null> {
		const existing = await listTopics(scope, projectId);

		const options: string[] = [];
		for (const t of existing) {
			options.push(t);
		}
		options.push("📝 새 주제 만들기");
		options.push("취소");

		const choice = await ctx.ui.select("주제를 선택하세요:", options);
		if (!choice || choice === "취소") return null;

		if (choice === "📝 새 주제 만들기") {
			const name = await ctx.ui.input("새 주제 이름 (영문 slug 또는 한글):");
			if (!name?.trim()) return null;
			try {
				const slug = sanitizeTopic(name.trim());
				return { slug, heading: name.trim() };
			} catch {
				return null;
			}
		}

		// Selected existing topic
		return { slug: choice, heading: slugToHeading(choice) };
	}

	/**
	 * Core save logic shared by /remember command and remember tool.
	 *
	 * @param scope - Explicit storage scope ("user" | "project").
	 * @param interactive - If true (default), prompts for topic selection.
	 *   If false, auto-selects "general" topic with no UI prompts.
	 */
	async function saveContent(
		content: string,
		title: string | undefined,
		scope: MemoryScope,
		ctx: ExtensionContext,
		interactive = true,
	): Promise<{ topic: string; title: string; scope: MemoryScope } | { cancelled: true } | { error: string }> {
		try {
			const displayTitle = title ?? truncateTitle(content);

			currentProjectId = resolveCurrentProjectId(ctx.cwd);

			// Fail-fast: project scope requires a resolved projectId
			if (scope === "project" && !currentProjectId) {
				return { error: "project scope memory requires project context (projectId not resolved)" };
			}

			let topicSlug: string;
			let topicHeading: string;

			if (interactive) {
				// /remember command path: show topic selection UI
				const topicChoice = await promptTopic(ctx, scope, scope === "project" ? currentProjectId : undefined);
				if (!topicChoice) return { cancelled: true };
				topicSlug = topicChoice.slug;
				topicHeading = topicChoice.heading;
			} else {
				// remember tool path: auto-select "general" — NO UI prompts
				topicSlug = "general";
				topicHeading = "General";
			}

			await saveMemory(
				scope,
				scope === "project" ? currentProjectId : undefined,
				topicSlug,
				topicHeading,
				displayTitle,
				content,
			);

			return { topic: topicSlug, title: displayTitle, scope };
		} catch (err: unknown) {
			return { error: `저장 실패: ${err instanceof Error ? err.message : "unknown"}` };
		}
	}

	// ── /remember Command ─────────────────────────────────────────────────

	/**
	 * Parse `/remember` args: `/remember [user|project] <content>`
	 * Returns { scope, content }. Defaults scope to "project" if not specified.
	 */
	function parseRememberArgs(raw: string): { scope: MemoryScope; content: string } {
		const scopeMatch = raw.match(/^(user|project)\s+([\s\S]+)$/);
		if (scopeMatch) {
			return { scope: scopeMatch[1] as MemoryScope, content: scopeMatch[2].trim() };
		}
		return { scope: "project", content: raw };
	}

	pi.on("input", async (event, ctx): Promise<InputEventResult | undefined> => {
		const text = event.text.trim();
		if (!text.startsWith("/remember")) return;

		const raw = text.replace(/^\/remember\s*/, "").trim();
		if (!raw) {
			ctx.ui.notify("사용법: /remember [user|project] <기억할 내용>", "warning");
			return { action: "handled" };
		}

		const { scope, content } = parseRememberArgs(raw);
		const result = await saveContent(content, undefined, scope, ctx);

		if ("cancelled" in result) {
			ctx.ui.notify("기억 저장을 취소했습니다.", "info");
		} else if ("error" in result) {
			ctx.ui.notify(result.error, "error");
		} else {
			ctx.ui.notify(
				`📝 저장: "${result.title}" → ${result.topic}.md (scope: ${result.scope}) — /memory에서 이동/정리 가능`,
				"info",
			);
		}

		return { action: "handled" };
	});

	pi.registerCommand("remember", {
		description: "Store a memory. Usage: /remember [user|project] <content>",
		handler: async (args, ctx) => {
			const raw = args.trim();
			if (!raw) {
				ctx.ui.notify("사용법: /remember [user|project] <기억할 내용>", "warning");
				return;
			}
			const { scope, content } = parseRememberArgs(raw);
			const result = await saveContent(content, undefined, scope, ctx);
			if ("cancelled" in result) {
				ctx.ui.notify("기억 저장을 취소했습니다.", "info");
			} else if ("error" in result) {
				ctx.ui.notify(result.error, "error");
			} else {
				ctx.ui.notify(
					`📝 저장: "${result.title}" → ${result.topic}.md (scope: ${result.scope}) — /memory에서 이동/정리 가능`,
					"info",
				);
			}
		},
	});

	// ── /memory Command (Overlay UI) ──────────────────────────────────────

	pi.registerCommand("memory", {
		description: "Browse and manage stored memories",
		handler: async (args, ctx) => {
			currentProjectId = resolveCurrentProjectId(ctx.cwd);

			// Collect all entries for display
			const displayEntries = await collectDisplayEntries(currentProjectId);

			if (!ctx.hasUI) {
				if (!displayEntries.length) {
					console.log("No memories stored.");
					return;
				}
				for (const e of displayEntries) {
					console.log(`[${e.scope}] ${e.topic} / ${e.title}`);
				}
				return;
			}

			await ctx.ui.custom<void>((tui, theme, _kb, done) => {
				let selector: MemorySelectorComponent | null = null;
				let actionMenu: MemoryActionMenuComponent | null = null;
				let deleteConfirm: MemoryDeleteConfirmComponent | null = null;
				let activeComponent: {
					render: (width: number) => string[];
					invalidate: () => void;
					handleInput?: (data: string) => void;
					focused?: boolean;
				} | null = null;
				let wrapperFocused = false;

				const setActive = (
					c: {
						render: (w: number) => string[];
						invalidate: () => void;
						handleInput?: (data: string) => void;
						focused?: boolean;
					} | null,
				) => {
					if (activeComponent && "focused" in activeComponent) activeComponent.focused = false;
					activeComponent = c;
					if (activeComponent && "focused" in activeComponent) activeComponent.focused = wrapperFocused;
					tui.requestRender();
				};

				const refresh = async () => {
					const updated = await collectDisplayEntries(currentProjectId);
					selector?.setEntries(updated);
				};

				const openDetail = async (entry: SearchResult) => {
					await ctx.ui.custom<void>(
						(oTui, oTheme, _oKb, oDone) => new MemoryDetailOverlayComponent(oTui, oTheme, entry, () => oDone()),
						{ overlay: true, overlayOptions: { width: "80%", maxHeight: "80%", anchor: "center" } },
					);
				};

				const handleAction = async (entry: SearchResult, action: MemoryMenuAction) => {
					if (action === "view") {
						await openDetail(entry);
						if (actionMenu) setActive(actionMenu);
						return;
					}
					if (action === "viewTopic") {
						const fullTopic = await readTopicFile(entry.scope, entry.projectId, entry.topic);
						const topicEntry: SearchResult = {
							...entry,
							title: `📁 ${entry.topic}.md (full)`,
							content: fullTopic || "(empty)",
						};
						await ctx.ui.custom<void>(
							(oTui, oTheme, _oKb, oDone) => new MemoryDetailOverlayComponent(oTui, oTheme, topicEntry, () => oDone()),
							{ overlay: true, overlayOptions: { width: "80%", maxHeight: "80%", anchor: "center" } },
						);
						if (actionMenu) setActive(actionMenu);
						return;
					}
					if (action === "copyContent") {
						try {
							copyToClipboard(`${entry.title}\n\n${entry.content}`);
							ctx.ui.notify("Copied to clipboard", "info");
						} catch (e) {
							ctx.ui.notify(`Copy failed: ${e instanceof Error ? e.message : "unknown"}`, "error");
						}
						setActive(selector);
						return;
					}
					if (action === "delete") {
						const msg = `삭제하시겠습니까?\n[${entry.scope}] ${entry.topic} / "${entry.title}"`;
						deleteConfirm = new MemoryDeleteConfirmComponent(theme, msg, (confirmed) => {
							if (!confirmed) {
								setActive(actionMenu);
								return;
							}
							void (async () => {
								try {
									const ok = await removeMemory(entry.scope, entry.projectId, entry.topic, entry.title);
									if (ok) {
										ctx.ui.notify(`Deleted: "${entry.title}"`, "info");
									} else {
										ctx.ui.notify("Not found", "error");
									}
								} catch (e) {
									ctx.ui.notify(`Error: ${e instanceof Error ? e.message : "unknown"}`, "error");
								}
								await refresh();
								setActive(selector);
							})();
						});
						setActive(deleteConfirm);
						return;
					}
				};

				selector = new MemorySelectorComponent(
					tui,
					theme,
					displayEntries,
					(entry) => showActionMenu(entry),
					() => done(),
					(args ?? "").trim() || undefined,
				);
				setActive(selector);

				const showActionMenu = (entry: SearchResult) => {
					actionMenu = new MemoryActionMenuComponent(
						theme,
						entry,
						(action) => void handleAction(entry, action),
						() => setActive(selector),
					);
					setActive(actionMenu);
				};

				return {
					get focused() {
						return wrapperFocused;
					},
					set focused(value: boolean) {
						wrapperFocused = value;
						if (activeComponent && "focused" in activeComponent) activeComponent.focused = value;
					},
					render(width: number) {
						return activeComponent ? activeComponent.render(width) : [];
					},
					invalidate() {
						activeComponent?.invalidate();
					},
					handleInput(data: string) {
						activeComponent?.handleInput?.(data);
					},
				};
			});
		},
	});

	// ── remember Tool (LLM-callable, fully non-interactive) ───────────────

	pi.registerTool({
		name: "remember",
		label: "Remember",
		description:
			"Save a fact, rule, or lesson to the user's long-term memory. " +
			"Call this when the user says '기억해', '앞으로 이렇게 해', '이 규칙 적용해', 'remember this', etc. " +
			"You must choose the appropriate scope: " +
			"'user' for personal profile, global preferences, or cross-project rules; " +
			"'project' for repo-specific tech decisions, env, tooling, configs. " +
			"Defaults to 'project' when ambiguous.",
		parameters: RememberParams,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const { content, title, scope } = params as { content: string; title?: string; scope: MemoryScope };

			if (!content?.trim()) {
				return {
					content: [{ type: "text" as const, text: "content가 비어 있습니다." }],
					details: undefined,
					isError: true,
				};
			}

			const result = await saveContent(content, title, scope, ctx, false);

			if ("cancelled" in result) {
				return { content: [{ type: "text" as const, text: "사용자가 기억 저장을 취소했습니다." }], details: undefined };
			}
			if ("error" in result) {
				return { content: [{ type: "text" as const, text: result.error }], details: undefined, isError: true };
			}

			return {
				content: [
					{
						type: "text" as const,
						text: `Memory saved.\nScope: ${result.scope}\nTopic: ${result.topic}.md\nTitle: ${result.title}`,
					},
				],
				details: undefined,
			};
		},
	});

	// ── recall Tool ───────────────────────────────────────────────────────

	pi.registerTool({
		name: "recall",
		label: "Recall",
		description:
			"Search the user's long-term memory for relevant information. " +
			"Use this when you need to check if there are stored rules, preferences, or lessons " +
			"related to the current task. You can search by keywords, or retrieve a full topic file by name.",
		parameters: RecallParams,

		renderCall(args, theme) {
			const query = typeof args.query === "string" ? args.query : undefined;
			const topic = typeof args.topic === "string" ? args.topic : undefined;
			let text = theme.fg("toolTitle", theme.bold("recall"));
			if (query) text += " " + theme.fg("accent", `"${query}"`);
			if (topic) text += " " + theme.fg("accent", `topic:${topic}`);
			if (!query && !topic) text += " " + theme.fg("muted", "(index)");
			return new Text(text, 0, 0);
		},

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			try {
				const { query, topic } = params as { query?: string; topic?: string };
				currentProjectId = resolveCurrentProjectId(ctx.cwd);

				// By topic — return full topic file
				if (topic) {
					// Try user scope first, then project
					let content = await readTopicFile("user", undefined, topic);
					if (!content && currentProjectId) {
						content = await readTopicFile("project", currentProjectId, topic);
					}
					if (!content) {
						return {
							content: [{ type: "text" as const, text: `Topic not found: ${topic}` }],
							details: undefined,
						};
					}
					return {
						content: [{ type: "text" as const, text: content }],
						details: undefined,
					};
				}

				// By query — search across all memories
				if (query) {
					const results = await searchMemories(query, currentProjectId);
					if (!results.length) {
						return {
							content: [{ type: "text" as const, text: "No matching memories found." }],
							details: undefined,
						};
					}
					const lines = results.slice(0, 8).map((r) => `[${r.scope}] ${r.topic}.md / ${r.title}\n  ${r.content}`);
					return {
						content: [{ type: "text" as const, text: `Found ${results.length} memories:\n\n${lines.join("\n\n")}` }],
						details: undefined,
					};
				}

				// No params — return full index
				const userIndex = (await readMemoryMd("user")).trim();
				const projectIndex = currentProjectId ? (await readMemoryMd("project", currentProjectId)).trim() : "";
				const combined = [userIndex, projectIndex].filter(Boolean).join("\n\n");
				return {
					content: [{ type: "text" as const, text: combined || "No memories stored." }],
					details: undefined,
				};
			} catch (err: unknown) {
				return {
					content: [
						{ type: "text" as const, text: `Recall failed: ${err instanceof Error ? err.message : "unknown"}` },
					],
					details: undefined,
					isError: true,
				};
			}
		},
	});

	// ── P2-2: forget Tool (scope ambiguity check) ─────────────────────────

	pi.registerTool({
		name: "forget",
		label: "Forget",
		description:
			"Archive a memory so it no longer appears in search results. " +
			"Use when the user says '잊어줘', 'forget this', or a stored rule is no longer valid.",
		parameters: ForgetParams,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			try {
				const { topic, title, scope } = params as { topic: string; title: string; scope?: MemoryScope };
				currentProjectId = resolveCurrentProjectId(ctx.cwd);

				// Explicit scope: delete directly from that scope
				if (scope) {
					const pid = scope === "project" ? currentProjectId : undefined;
					const removed = await removeMemory(scope, pid, topic, title);
					if (!removed) {
						return {
							content: [
								{
									type: "text" as const,
									text: `Memory not found in ${scope} scope: ${topic} / "${title}"`,
								},
							],
							details: undefined,
							isError: true,
						};
					}
					return {
						content: [{ type: "text" as const, text: `Deleted from ${scope}: ${topic} / "${title}"` }],
						details: undefined,
					};
				}

				// No scope specified: check both for ambiguity
				const existsInUser = await memoryExistsInScope("user", undefined, topic, title);
				const existsInProject = currentProjectId
					? await memoryExistsInScope("project", currentProjectId, topic, title)
					: false;

				if (existsInUser && existsInProject) {
					return {
						content: [
							{
								type: "text" as const,
								text:
									`Ambiguous: "${title}" exists in both user and project scopes for topic "${topic}". ` +
									'Specify scope parameter: scope="user" or scope="project" to resolve.',
							},
						],
						details: undefined,
						isError: true,
					};
				}

				if (!existsInUser && !existsInProject) {
					return {
						content: [{ type: "text" as const, text: `Memory not found: ${topic} / "${title}"` }],
						details: undefined,
						isError: true,
					};
				}

				// Exists in exactly one scope — safe to delete
				const targetScope: MemoryScope = existsInUser ? "user" : "project";
				const pid = targetScope === "project" ? currentProjectId : undefined;
				const removed = await removeMemory(targetScope, pid, topic, title);

				if (!removed) {
					return {
						content: [{ type: "text" as const, text: `Memory not found: ${topic} / "${title}"` }],
						details: undefined,
						isError: true,
					};
				}

				return {
					content: [
						{
							type: "text" as const,
							text: `Deleted from ${targetScope}: ${topic} / "${title}"`,
						},
					],
					details: undefined,
				};
			} catch (err: unknown) {
				return {
					content: [
						{ type: "text" as const, text: `Forget failed: ${err instanceof Error ? err.message : "unknown"}` },
					],
					details: undefined,
					isError: true,
				};
			}
		},
	});

	// ── memory_list Tool ──────────────────────────────────────────────────

	pi.registerTool({
		name: "memory_list",
		label: "Memory List",
		description: "List all active memories. Optionally filter by scope (user or project).",
		parameters: MemoryListParams,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			try {
				const { scope } = params as { scope?: MemoryScope };
				currentProjectId = resolveCurrentProjectId(ctx.cwd);

				const parts: string[] = [];

				if (!scope || scope === "user") {
					const idx = (await readMemoryMd("user")).trim();
					if (idx) {
						parts.push("[User Memory]");
						parts.push(idx);
					}
				}

				if ((!scope || scope === "project") && currentProjectId) {
					const idx = (await readMemoryMd("project", currentProjectId)).trim();
					if (idx) {
						if (parts.length) parts.push("");
						parts.push("[Project Memory]");
						parts.push(idx);
					}
				}

				const text = parts.join("\n") || "No active memories.";
				return { content: [{ type: "text" as const, text }], details: undefined };
			} catch (err: unknown) {
				return {
					content: [{ type: "text" as const, text: `List failed: ${err instanceof Error ? err.message : "unknown"}` }],
					details: undefined,
					isError: true,
				};
			}
		},
	});

	// ── Lifecycle Events ──────────────────────────────────────────────────

	pi.on("session_start", async (_event, ctx) => {
		try {
			await ensureDir();
			currentProjectId = resolveCurrentProjectId(ctx.cwd);

			// One-time migration from JSON
			if (!migrationDone) {
				migrationDone = true;
				const { migrated, errors } = await migrateFromJson();
				if (migrated > 0) {
					ctx.ui.notify(`Memory: migrated ${migrated} entries to markdown.`, "info");
				}
				if (errors.length > 0) {
					ctx.ui.notify(`Memory migration errors: ${errors.join("; ")}`, "warning");
				}
			}
		} catch {
			// Graceful degradation
		}
	});

	pi.on("session_switch", async (_event, ctx) => {
		try {
			currentProjectId = resolveCurrentProjectId(ctx.cwd);
		} catch {
			// Graceful degradation
		}
	});

	pi.on("session_fork", async (_event, ctx) => {
		try {
			currentProjectId = resolveCurrentProjectId(ctx.cwd);
		} catch {
			// Graceful degradation
		}
	});

	// ── before_agent_start: Memory Injection ──────────────────────────────

	pi.on("before_agent_start", async (event, ctx) => {
		try {
			currentProjectId = resolveCurrentProjectId(ctx.cwd);
			const hint = await buildMemoryPrompt(currentProjectId);
			if (hint) {
				return { systemPrompt: event.systemPrompt + hint };
			}
		} catch {
			// Graceful degradation
		}
		return undefined;
	});
}

// ── Helpers ──────────────────────────────────────────────────────────────────

async function collectDisplayEntries(projectId?: string): Promise<SearchResult[]> {
	const results: SearchResult[] = [];
	const scopes: Array<{ scope: MemoryScope; pid?: string }> = [
		{ scope: "user" },
		...(projectId ? [{ scope: "project" as MemoryScope, pid: projectId }] : []),
	];
	for (const { scope, pid } of scopes) {
		const topics = await listTopics(scope, pid);
		for (const topic of topics) {
			const entries = await loadTopicEntries(scope, pid, topic);
			for (const entry of entries) {
				results.push({ scope, projectId: pid, topic, title: entry.title, content: entry.content });
			}
		}
	}
	return results;
}
