import type { ExtensionAPI, ExtensionContext, InputEventResult } from "@mariozechner/pi-coding-agent";
import { copyToClipboard } from "@mariozechner/pi-coding-agent";

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

	// ── P2-1: Scope Auto-Inference (token-based matching) ─────────────────

	const USER_HINTS = [
		"앞으로 항상",
		"모든 프로젝트",
		"내 선호",
		"내 프로필",
		"이메일",
		"전역",
		"global",
		"always",
		"every project",
		"all projects",
		"개인",
		"슬랙 id",
		"slack id",
		"github 계정",
		"계정",
		"my preference",
		"my profile",
	];

	const PROJECT_HINTS = [
		"이 프로젝트",
		"이 레포",
		"레포",
		"repo",
		"this project",
		"build",
		"lint",
		"test",
		"테스트",
		"tailwind",
		"next",
		"nuxt",
		"tsconfig",
		"eslint",
		"prettier",
		"biome",
		"vite",
		"webpack",
		"db",
		"database",
		"schema",
		"migration",
		"prisma",
		"drizzle",
		"mcp",
		"docker",
		"ci",
		"cd",
		"deploy",
		"배포",
		"env",
		"환경변수",
		".env",
		"api key",
		"endpoint",
		"컴포넌트",
		"component",
		"모듈",
		"module",
		"pnpm",
		"npm",
		"yarn",
		"bun",
	];

	/**
	 * Match a hint against text using word-boundary awareness.
	 * - ASCII-only hints: non-alphanumeric boundary matching (prevents "ci" matching "specific").
	 * - Non-ASCII hints (Korean, etc.): simple substring match (safe for CJK).
	 */
	function matchesHint(text: string, hint: string): boolean {
		const lh = hint.toLowerCase();

		// ASCII-only hints: word-boundary matching via lookbehind/lookahead
		if (/^[\x20-\x7E]+$/.test(lh)) {
			const escaped = lh.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
			return new RegExp(`(?<![a-zA-Z0-9])${escaped}(?![a-zA-Z0-9])`, "i").test(text);
		}

		// Non-ASCII (Korean, etc.): substring match
		return text.includes(lh);
	}

	/**
	 * Infer the storage scope from content and title using keyword heuristics.
	 * - user: personal profile, global preferences, cross-project rules
	 * - project: repo-specific tech decisions, env, tooling, configs
	 * - Defaults to "project" when ambiguous (safer for isolation).
	 */
	function inferScope(content: string, title?: string): MemoryScope {
		const text = `${title ?? ""} ${content}`.toLowerCase();

		let userScore = 0;
		let projectScore = 0;

		for (const hint of USER_HINTS) {
			if (matchesHint(text, hint)) userScore++;
		}
		for (const hint of PROJECT_HINTS) {
			if (matchesHint(text, hint)) projectScore++;
		}

		// User scope only when user signals clearly dominate
		if (userScore > 0 && userScore > projectScore) return "user";

		// Default to project (safer isolation)
		return "project";
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
	 * @param interactive - If true (default), prompts for topic selection.
	 *   If false, auto-selects "general" topic with no UI prompts.
	 */
	async function saveContent(
		content: string,
		title: string | undefined,
		ctx: ExtensionContext,
		interactive = true,
	): Promise<{ topic: string; title: string; scope: MemoryScope } | { cancelled: true } | { error: string }> {
		try {
			const displayTitle = title ?? truncateTitle(content);

			// Auto-determine scope (no UI prompt)
			currentProjectId = resolveCurrentProjectId(ctx.cwd);
			const scope = inferScope(content, title);

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

	pi.on("input", async (event, ctx): Promise<InputEventResult | undefined> => {
		const text = event.text.trim();
		if (!text.startsWith("/remember")) return;

		const content = text.replace(/^\/remember\s*/, "").trim();
		if (!content) {
			ctx.ui.notify("사용법: /remember <기억할 내용>", "warning");
			return { action: "handled" };
		}

		const result = await saveContent(content, undefined, ctx);

		if ("cancelled" in result) {
			ctx.ui.notify("기억 저장을 취소했습니다.", "info");
		} else if ("error" in result) {
			ctx.ui.notify(result.error, "error");
		} else {
			ctx.ui.notify(
				`📝 저장: "${result.title}" → ${result.topic}.md (선택된 스코프: ${result.scope}) — /memory에서 이동/정리 가능`,
				"info",
			);
		}

		return { action: "handled" };
	});

	pi.registerCommand("remember", {
		description: "Store a memory. Usage: /remember <content>",
		handler: async (args, ctx) => {
			const content = args.trim();
			if (!content) {
				ctx.ui.notify("사용법: /remember <기억할 내용>", "warning");
				return;
			}
			const result = await saveContent(content, undefined, ctx);
			if ("cancelled" in result) {
				ctx.ui.notify("기억 저장을 취소했습니다.", "info");
			} else if ("error" in result) {
				ctx.ui.notify(result.error, "error");
			} else {
				ctx.ui.notify(
					`📝 저장: "${result.title}" → ${result.topic}.md (선택된 스코프: ${result.scope}) — /memory에서 이동/정리 가능`,
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
			"The storage scope is auto-determined: " +
			"personal profile, global preferences, or cross-project rules → user scope; " +
			"repo-specific tech decisions, env, tooling, configs → project scope. " +
			"Defaults to project when ambiguous.",
		parameters: RememberParams,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const content = (params as { content: string }).content;
			const title = (params as { title?: string }).title;

			if (!content?.trim()) {
				return {
					content: [{ type: "text" as const, text: "content가 비어 있습니다." }],
					details: undefined,
					isError: true,
				};
			}

			// Non-interactive: auto-determine scope + auto "general" topic
			const result = await saveContent(content, title, ctx, false);

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
						text:
							`Memory saved.\nTopic: ${result.topic}.md\nTitle: ${result.title}\n` +
							`Auto-selected scope: ${result.scope}\n` +
							`(스코프가 잘못 분류된 경우 /memory에서 이동/정리 가능)`,
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
