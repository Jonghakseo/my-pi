import type { ExtensionAPI, ExtensionContext, InputEventResult } from "@mariozechner/pi-coding-agent";
import { copyToClipboard } from "@mariozechner/pi-coding-agent";

import { buildCatalogHint, buildFirstTurnInjection, isFirstTurn, markFirstTurnDone, resetFirstTurn } from "./inject.ts";
import { extractKeywords } from "./keyword.ts";
import { resolveProjectId } from "./project-id.ts";
import {
	archiveMemory,
	ensureDir,
	findMemoryById,
	generateId,
	getAllActiveMemories,
	loadMemories,
	purgeMemory,
	saveMemory,
	searchMemories,
} from "./storage.ts";
import type { MemoryRecord, MemoryScope } from "./types.ts";
import { ForgetParams, MemoryListParams, RecallParams, RememberParams } from "./types.ts";
import {
	MemoryActionMenuComponent,
	MemoryArchiveConfirmComponent,
	MemoryDetailOverlayComponent,
	type MemoryMenuAction,
	MemoryPurgeConfirmComponent,
	MemorySelectorComponent,
} from "./ui.ts";

// ── Extension Entry Point ────────────────────────────────────────────────────

export default function memoryLayerExtension(pi: ExtensionAPI) {
	let currentProjectId: string | undefined;

	// ── Helpers ────────────────────────────────────────────────────────────

	function resolveCurrentProjectId(cwd: string): string | undefined {
		try {
			const result = resolveProjectId(cwd);
			return result.id;
		} catch {
			return undefined;
		}
	}

	function truncateTitle(content: string, maxLen = 60): string {
		const firstLine = content.split("\n")[0]?.trim() ?? content.trim();
		if (firstLine.length <= maxLen) return firstLine;
		return `${firstLine.slice(0, maxLen - 1)}…`;
	}

	/**
	 * Prompt user to select scope for saving.
	 * Shows a preview of what will be saved, then asks for scope.
	 * Returns the chosen scope or null to cancel.
	 */
	async function promptScope(
		ctx: ExtensionContext,
		title: string,
		content: string,
		keywords: string[],
	): Promise<MemoryScope | null> {
		const contentPreview = content.length > 200 ? `${content.slice(0, 200)}…` : content;
		const prompt = [
			"📝 기억할 내용:",
			`제목: ${title}`,
			`내용: ${contentPreview}`,
			`키워드: ${keywords.join(", ")}`,
			"",
			"저장 스코프를 선택하세요:",
		].join("\n");

		const options = ["1. 유저 (모든 프로젝트에 적용)", "2. 프로젝트 (현재 프로젝트에만 적용)", "3. 기억하지 않는다"];
		const choice = await ctx.ui.select(prompt, options);
		if (!choice) return null;
		if (choice.startsWith("1")) return "user";
		if (choice.startsWith("2")) return "project";
		return null;
	}

	/**
	 * Core save logic shared by /remember command and remember tool.
	 */
	async function saveContent(
		content: string,
		title: string | undefined,
		ctx: ExtensionContext,
	): Promise<{ record: MemoryRecord } | { cancelled: true } | { error: string }> {
		try {
			// Compute keywords & title early so we can show preview
			const keywords = extractKeywords(`${title ?? ""} ${content}`);
			const displayTitle = title ?? truncateTitle(content);

			const scope = await promptScope(ctx, displayTitle, content, keywords);
			if (!scope) return { cancelled: true };

			// Refresh project ID
			currentProjectId = resolveCurrentProjectId(ctx.cwd);

			if (scope === "project" && !currentProjectId) {
				return { error: "프로젝트를 식별할 수 없습니다. git 저장소에서 실행해주세요." };
			}

			const now = new Date().toISOString();

			const record: MemoryRecord = {
				id: generateId(),
				title: displayTitle,
				content,
				keywords,
				scope,
				projectId: scope === "project" ? currentProjectId : undefined,
				status: "active",
				createdAt: now,
				updatedAt: now,
			};

			await saveMemory(record);
			return { record };
		} catch (err: unknown) {
			return { error: `저장 실패: ${err instanceof Error ? err.message : "unknown error"}` };
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
			const r = result.record;
			ctx.ui.notify(
				`📝 기억 저장 완료: [${r.id}] "${r.title}" (${r.scope}, keywords: ${r.keywords.join(", ")})`,
				"info",
			);
		}

		return { action: "handled" };
	});

	// also register as a command for autocomplete
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
				const r = result.record;
				ctx.ui.notify(
					`📝 기억 저장 완료: [${r.id}] "${r.title}" (${r.scope}, keywords: ${r.keywords.join(", ")})`,
					"info",
				);
			}
		},
	});

	// ── /memory Command (Overlay UI) ──────────────────────────────────────

	pi.registerCommand("memory", {
		description: "Browse and manage stored memories",
		handler: async (args, ctx) => {
			try {
				currentProjectId = resolveCurrentProjectId(ctx.cwd);
			} catch {
				// ignore
			}

			// Load memories: user scope (all) + project scope (current project only)
			const userMemories = await loadMemories("user");
			const projectMemories = currentProjectId
				? (await loadMemories("project", currentProjectId)).filter((m) => m.projectId === currentProjectId)
				: [];
			const allMemories = [...userMemories, ...projectMemories];

			if (!ctx.hasUI) {
				// Fallback for non-interactive mode
				const active = allMemories.filter((m) => m.status === "active");
				if (!active.length) {
					console.log("No active memories.");
					return;
				}
				for (const m of active) {
					console.log(`[${m.id}] ${m.title} (${m.scope}) — ${m.keywords.join(", ")}`);
				}
				return;
			}

			await ctx.ui.custom<void>((tui, theme, _kb, done) => {
				let selector: MemorySelectorComponent | null = null;
				let actionMenu: MemoryActionMenuComponent | null = null;
				let archiveConfirm: MemoryArchiveConfirmComponent | null = null;
				let purgeConfirm: MemoryPurgeConfirmComponent | null = null;
				let activeComponent: {
					render: (width: number) => string[];
					invalidate: () => void;
					handleInput?: (data: string) => void;
					focused?: boolean;
				} | null = null;
				let wrapperFocused = false;

				const setActiveComponent = (
					component: {
						render: (width: number) => string[];
						invalidate: () => void;
						handleInput?: (data: string) => void;
						focused?: boolean;
					} | null,
				) => {
					if (activeComponent && "focused" in activeComponent) {
						activeComponent.focused = false;
					}
					activeComponent = component;
					if (activeComponent && "focused" in activeComponent) {
						activeComponent.focused = wrapperFocused;
					}
					tui.requestRender();
				};

				const refreshMemories = async (): Promise<MemoryRecord[]> => {
					const user = await loadMemories("user");
					const project = currentProjectId
						? (await loadMemories("project", currentProjectId)).filter((m) => m.projectId === currentProjectId)
						: [];
					return [...user, ...project];
				};

				const openDetailOverlay = async (memory: MemoryRecord) => {
					await ctx.ui.custom<void>(
						(overlayTui, overlayTheme, _overlayKb, overlayDone) =>
							new MemoryDetailOverlayComponent(overlayTui, overlayTheme, memory, (_action) => {
								overlayDone();
							}),
						{
							overlay: true,
							overlayOptions: { width: "80%", maxHeight: "80%", anchor: "center" },
						},
					);
				};

				const handleAction = async (memory: MemoryRecord, action: MemoryMenuAction) => {
					if (action === "view") {
						await openDetailOverlay(memory);
						if (actionMenu) setActiveComponent(actionMenu);
						return;
					}

					if (action === "copyContent") {
						const text = `[${memory.id}] ${memory.title}\n\n${memory.content}\n\nKeywords: ${memory.keywords.join(", ")}\nScope: ${memory.scope}`;
						try {
							copyToClipboard(text);
							ctx.ui.notify("Copied memory content to clipboard", "info");
						} catch (e) {
							ctx.ui.notify(`Copy failed: ${e instanceof Error ? e.message : "unknown"}`, "error");
						}
						setActiveComponent(selector);
						return;
					}

					if (action === "copyId") {
						try {
							copyToClipboard(memory.id);
							ctx.ui.notify(`Copied ${memory.id} to clipboard`, "info");
						} catch (e) {
							ctx.ui.notify(`Copy failed: ${e instanceof Error ? e.message : "unknown"}`, "error");
						}
						setActiveComponent(selector);
						return;
					}

					if (action === "archive") {
						const message = `Archive memory ${memory.id} "${memory.title}"?\nIt will no longer appear in search or be injected.`;
						archiveConfirm = new MemoryArchiveConfirmComponent(theme, message, (confirmed) => {
							if (!confirmed) {
								setActiveComponent(actionMenu);
								return;
							}
							void (async () => {
								try {
									const result = await archiveMemory(memory.id, memory.scope, memory.projectId);
									if (!result) {
										ctx.ui.notify(`Failed to archive ${memory.id}`, "error");
									} else {
										ctx.ui.notify(`Archived ${memory.id} "${memory.title}"`, "info");
									}
								} catch (e) {
									ctx.ui.notify(`Archive error: ${e instanceof Error ? e.message : "unknown"}`, "error");
								}
								const updated = await refreshMemories();
								selector?.setMemories(updated);
								setActiveComponent(selector);
							})();
						});
						setActiveComponent(archiveConfirm);
						return;
					}

					if (action === "purge") {
						const message = `영구 삭제하시겠습니까? 이 작업은 되돌릴 수 없습니다.\n${memory.id} "${memory.title}"`;
						purgeConfirm = new MemoryPurgeConfirmComponent(theme, message, (confirmed) => {
							if (!confirmed) {
								setActiveComponent(actionMenu);
								return;
							}
							void (async () => {
								try {
									const result = await purgeMemory(memory.id, memory.scope, memory.projectId);
									if (!result) {
										ctx.ui.notify(`Failed to purge ${memory.id}`, "error");
									} else {
										ctx.ui.notify(`Permanently deleted ${memory.id} "${memory.title}"`, "info");
									}
								} catch (e) {
									ctx.ui.notify(`Purge error: ${e instanceof Error ? e.message : "unknown"}`, "error");
								}
								const updated = await refreshMemories();
								selector?.setMemories(updated);
								setActiveComponent(selector);
							})();
						});
						setActiveComponent(purgeConfirm);
						return;
					}
				};

				const showActionMenu = (memory: MemoryRecord) => {
					actionMenu = new MemoryActionMenuComponent(
						theme,
						memory,
						(action) => void handleAction(memory, action),
						() => setActiveComponent(selector),
					);
					setActiveComponent(actionMenu);
				};

				selector = new MemorySelectorComponent(
					tui,
					theme,
					allMemories,
					(memory) => showActionMenu(memory),
					() => done(),
					(args ?? "").trim() || undefined,
				);
				setActiveComponent(selector);

				const rootComponent = {
					get focused() {
						return wrapperFocused;
					},
					set focused(value: boolean) {
						wrapperFocused = value;
						if (activeComponent && "focused" in activeComponent) {
							activeComponent.focused = value;
						}
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

				return rootComponent;
			});
		},
	});

	// ── remember Tool (LLM-callable) ──────────────────────────────────────

	pi.registerTool({
		name: "remember",
		label: "Remember",
		description:
			"Save a fact, rule, or lesson to the user's long-term memory. " +
			"Call this when the user says '기억해', '앞으로 이렇게 해', '이 규칙 적용해', 'remember this', etc. " +
			"The user will be asked to choose the storage scope (user-wide or project-specific).",
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

			const result = await saveContent(content, title, ctx);

			if ("cancelled" in result) {
				return {
					content: [{ type: "text" as const, text: "사용자가 기억 저장을 취소했습니다." }],
					details: undefined,
				};
			}
			if ("error" in result) {
				return {
					content: [{ type: "text" as const, text: result.error }],
					details: undefined,
					isError: true,
				};
			}

			const r = result.record;
			return {
				content: [
					{
						type: "text" as const,
						text:
							`Memory saved successfully.\n` +
							`ID: ${r.id}\nTitle: ${r.title}\nScope: ${r.scope}\n` +
							`Keywords: ${r.keywords.join(", ")}`,
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
			"related to the current task. You can search by keywords, filter by scope, or retrieve by ID.",
		parameters: RecallParams,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			try {
				const { query, scope, id } = params as { query?: string; scope?: MemoryScope; id?: string };
				currentProjectId = resolveCurrentProjectId(ctx.cwd);

				// By ID
				if (id) {
					const found = await findMemoryById(id, currentProjectId);
					if (!found) {
						return {
							content: [{ type: "text" as const, text: `Memory not found: ${id}` }],
							details: undefined,
						};
					}
					return {
						content: [{ type: "text" as const, text: formatMemoryDetail(found.memory) }],
						details: undefined,
					};
				}

				// By query
				if (query) {
					const words = query
						.toLowerCase()
						.split(/\s+/)
						.filter((w) => w.length >= 2 || /^[\uAC00-\uD7AF]$/.test(w));
					const scored = await searchMemories(words, scope, currentProjectId);
					if (!scored.length) {
						return {
							content: [{ type: "text" as const, text: "No matching memories found." }],
							details: undefined,
						};
					}
					const lines = scored
						.slice(0, 5)
						.map(
							({ memory, score }) =>
								`[${memory.id}] (score:${score}) ${memory.title}\n  ${memory.content}\n  scope:${memory.scope} | keywords:${memory.keywords.join(", ")}`,
						);
					return {
						content: [{ type: "text" as const, text: `Found ${scored.length} memories:\n\n${lines.join("\n\n")}` }],
						details: undefined,
					};
				}

				// No query — list all active
				const all = await getAllActiveMemories(currentProjectId);
				const filtered = scope ? all.filter((m) => m.scope === scope) : all;
				if (!filtered.length) {
					return {
						content: [{ type: "text" as const, text: "No memories stored." }],
						details: undefined,
					};
				}

				const lines = filtered.map((m) => `[${m.id}] ${m.title} (${m.scope}) — keywords: ${m.keywords.join(", ")}`);
				return {
					content: [{ type: "text" as const, text: `${filtered.length} memories:\n${lines.join("\n")}` }],
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

	// ── forget Tool ───────────────────────────────────────────────────────

	pi.registerTool({
		name: "forget",
		label: "Forget",
		description:
			"Archive a memory so it no longer appears in search results. " +
			"Use when the user says '잊어줘', 'forget this', or a stored rule is no longer valid.",
		parameters: ForgetParams,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			try {
				const { id } = params as { id: string };
				currentProjectId = resolveCurrentProjectId(ctx.cwd);

				const found = await findMemoryById(id, currentProjectId);
				if (!found) {
					return {
						content: [{ type: "text" as const, text: `Memory not found: ${id}` }],
						details: undefined,
						isError: true,
					};
				}

				const archived = await archiveMemory(id, found.scope, found.memory.projectId);
				if (!archived) {
					return {
						content: [{ type: "text" as const, text: `Failed to archive memory: ${id}` }],
						details: undefined,
						isError: true,
					};
				}

				return {
					content: [
						{
							type: "text" as const,
							text: `Memory archived: [${archived.id}] "${archived.title}"`,
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

				const all = await getAllActiveMemories(currentProjectId);
				const filtered = scope ? all.filter((m) => m.scope === scope) : all;

				if (!filtered.length) {
					return {
						content: [{ type: "text" as const, text: "No active memories." }],
						details: undefined,
					};
				}

				const lines = filtered.map(
					(m) => `[${m.id}] ${m.title}\n  scope:${m.scope} | keywords:${m.keywords.join(", ")}\n  ${m.content}`,
				);
				return {
					content: [
						{
							type: "text" as const,
							text: `${filtered.length} active memories:\n\n${lines.join("\n\n")}`,
						},
					],
					details: undefined,
				};
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
			resetFirstTurn();
			currentProjectId = resolveCurrentProjectId(ctx.cwd);
		} catch {
			// Graceful degradation: memory features disabled
		}
	});

	pi.on("session_switch", async (_event, ctx) => {
		try {
			resetFirstTurn();
			currentProjectId = resolveCurrentProjectId(ctx.cwd);
		} catch {
			// Graceful degradation
		}
	});

	pi.on("session_fork", async (_event, ctx) => {
		try {
			resetFirstTurn();
			currentProjectId = resolveCurrentProjectId(ctx.cwd);
		} catch {
			// Graceful degradation
		}
	});

	// ── before_agent_start: Memory Injection ──────────────────────────────

	pi.on("before_agent_start", async (event, ctx) => {
		try {
			currentProjectId = resolveCurrentProjectId(ctx.cwd);

			if (isFirstTurn()) {
				markFirstTurnDone();

				// First turn: keyword-match → inject top 2-3 memories
				const injection = await buildFirstTurnInjection(event.prompt, currentProjectId);
				if (injection) {
					// Also append catalog hint to system prompt
					const hint = await buildCatalogHint(currentProjectId);
					return {
						message: {
							customType: "memory-layer",
							content: injection.content,
							display: true,
						},
						systemPrompt: hint ? event.systemPrompt + hint : undefined,
					};
				}

				// No match on first turn — still add catalog hint if memories exist
				const hint = await buildCatalogHint(currentProjectId);
				if (hint) {
					return { systemPrompt: event.systemPrompt + hint };
				}
			} else {
				// Subsequent turns: catalog hint only
				const hint = await buildCatalogHint(currentProjectId);
				if (hint) {
					return { systemPrompt: event.systemPrompt + hint };
				}
			}
		} catch {
			// Graceful degradation: no injection on error
		}
		return undefined;
	});
}

// ── Formatting Helpers ───────────────────────────────────────────────────────

function formatMemoryDetail(memory: MemoryRecord): string {
	return [
		`ID: ${memory.id}`,
		`Title: ${memory.title}`,
		`Content: ${memory.content}`,
		`Scope: ${memory.scope}`,
		memory.projectId ? `Project: ${memory.projectId}` : null,
		`Keywords: ${memory.keywords.join(", ")}`,
		`Status: ${memory.status}`,
		`Created: ${memory.createdAt}`,
		`Updated: ${memory.updatedAt}`,
	]
		.filter(Boolean)
		.join("\n");
}
