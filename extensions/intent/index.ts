/**
 * Intent Tool — Category-based dispatch for subagent orchestration
 *
 * Instead of selecting agents by name, the master agent specifies
 * purpose + difficulty, and the Intent tool automatically dispatches
 * to the best-fit subagent.
 *
 * Supports two usage patterns:
 *
 * 1. **Single Intent** (mode: "run")
 *    Quick one-off dispatch: intent → agent resolution → async execution
 *
 * 2. **Blueprint** (mode: "create_blueprint" → "run_next")
 *    DAG of intent nodes: create → user confirm → step-by-step execution
 *    Master calls run_next repeatedly; nodes run async and notify on completion.
 *
 * Architecture:
 *   types.ts     — TypeBox schemas, Blueprint/Node interfaces
 *   mapping.ts   — Purpose+Difficulty → Agent mapping table
 *   blueprint.ts — Blueprint CRUD, validation, DAG traversal
 *   executor.ts  — Execution engine (runSingleAgent integration)
 *   index.ts     — Tool registration (this file)
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { parse as parseYaml } from "yaml";
import {
	deleteBlueprint,
	generateBlueprintId,
	injectChallengerGates,
	listBlueprints,
	loadBlueprint,
	resetNodeStatus,
	saveBlueprint,
	validateBlueprint,
} from "./blueprint.js";
import { abortAllBlueprintRuns, cancelSingleRun, listSingleRuns, runNext, runSingleIntent } from "./executor.js";
import { getMappingDescription, resolveAgent } from "./mapping.js";
import type { Blueprint, BlueprintNode } from "./types.js";
import { IntentParams, type IntentParamsType } from "./types.js";
import { BlueprintDagViewer, type BlueprintDagViewerOptions, renderBlueprintDAGText } from "./viewer.js";
import { clearIntentWidget } from "./widget.js";

export default function (pi: ExtensionAPI) {
	// ─── Intent Tool Failure Auto-Retry ──────────────────────────────────────
	// When intent tool call fails (e.g. JSON parse error in LLM-generated params),
	// append retry instructions to the error so the master LLM retries automatically.
	const MAX_INTENT_RETRIES_PER_TURN = 2;
	let intentErrorsThisTurn = 0;

	pi.on("turn_start", async () => {
		intentErrorsThisTurn = 0;
	});

	pi.on("tool_result", async (event) => {
		if (event.toolName !== "intent" || !event.isError) return;

		intentErrorsThisTurn++;
		const errorText = event.content
			.map((c) => (c.type === "text" ? (c as { type: "text"; text: string }).text : ""))
			.join("");

		if (intentErrorsThisTurn <= MAX_INTENT_RETRIES_PER_TURN) {
			return {
				content: [
					{
						type: "text" as const,
						text:
							`${errorText}\n\n` +
							`⚠️ [Intent 자동 재시도 ${intentErrorsThisTurn}/${MAX_INTENT_RETRIES_PER_TURN}] ` +
							`intent 호출이 실패했습니다. 동일한 파라미터로 다시 호출하세요. ` +
							`task/context 내 백슬래시(\\\\) 또는 특수 문자가 있다면 JSON에서 올바르게 이스케이프하세요.`,
					},
				],
			};
		}
		// Max retries reached — leave error unchanged, let master escalate to user
	});

	pi.registerTool({
		name: "intent",
		label: "Intent",
		description: [
			"Category-based task dispatch tool. Automatically selects the best subagent based on purpose and difficulty.",
			"",
			"Modes:",
			"  create_blueprint — Create a DAG of tasks as a Blueprint. Automatically shows confirm UI to user (set need_confirm=false to skip for small/low-risk blueprints).",
			"  run_next — Execute next runnable node(s) in a confirmed Blueprint. Call repeatedly until complete.",
			"  run — Execute a single intent directly (no Blueprint needed).",
			"  status — Show current Blueprint progress.",
			"  abort — Abort a running Blueprint and its active nodes.",
			"  abort_run — Cancel a single intent run by runId. Omit runId to list running intents.",
			"  retry_node — Reset a failed/skipped node to pending and re-run it immediately.",
			"  edit_blueprint — Edit pending nodes in a confirmed/running Blueprint.",
			"",
			"Purpose options: explore, search, plan, challenge, decide, implement, review, verify, browse",
			"Difficulty options: low, medium, high",
			"",
			"Agent auto-selection:",
			"  explore→finder, search→searcher, plan→planner, challenge→challenger, decide→decider",
			"  review→reviewer, verify→verifier, browse→browser",
			"  implement: low/medium→worker-fast, high→worker",
			"",
			"Note: commit/PR/execute 작업은 implement/low 로 표현하세요.",
			"",
			"Note: 비동기 실행된 intent는 완료 시 자동으로 결과가 전달됩니다. 같은 작업을 반복 호출하지 마세요.",
		].join("\n"),
		parameters: IntentParams,

		execute: async (toolCallId, rawParams, signal, onUpdate, ctx) => {
			const params = rawParams as IntentParamsType;

			switch (params.mode) {
				// ─── Create Blueprint ─────────────────────────────────────
				case "create_blueprint": {
					if (!params.title || !params.nodes || (params.nodes as string).trim() === "") {
						return {
							content: [
								{ type: "text" as const, text: "Error: create_blueprint requires title and at least one node." },
							],
							details: undefined,
						};
					}

					let parsedNodes: BlueprintNode[];
					try {
						parsedNodes = parseYaml(params.nodes as string);
					} catch (e) {
						return {
							content: [{ type: "text" as const, text: `❌ nodes YAML 파싱 실패: ${e}` }],
							details: undefined,
						};
					}
					if (!Array.isArray(parsedNodes) || parsedNodes.length === 0) {
						return {
							content: [{ type: "text" as const, text: "Error: nodes YAML must be a non-empty array." }],
							details: undefined,
						};
					}

					const blueprint: Blueprint = {
						id: generateBlueprintId(),
						title: params.title,
						description: params.description,
						createdAt: new Date().toISOString(),
						status: "pending_confirm",
						nodes: parsedNodes.map((n) => ({
							id: n.id,
							purpose: n.purpose as any,
							difficulty: n.difficulty as any,
							task: n.task,
							context: n.context,
							dependsOn: n.dependsOn ?? [],
							chainFrom: n.chainFrom,
							status: "pending" as const,
						})),
					};

					// Auto-normalize: chainFrom implies dependsOn
					for (const node of blueprint.nodes) {
						if (node.chainFrom && !node.dependsOn.includes(node.chainFrom)) {
							node.dependsOn.push(node.chainFrom);
						}
					}

					// Auto-inject challenger gates (plan→challenge→impl, impl→challenge→review)
					injectChallengerGates(blueprint);

					// Validate DAG
					const errors = validateBlueprint(blueprint);
					if (errors.length > 0) {
						return {
							content: [
								{
									type: "text" as const,
									text: `Blueprint validation failed:\n${errors.map((e) => `- ${e}`).join("\n")}`,
								},
							],
							details: undefined,
						};
					}

					// Annotate nodes with resolved agent names for display
					for (const node of blueprint.nodes) {
						node.agent = resolveAgent(node.purpose, node.difficulty);
					}

					// Store creation cwd for project-scoped filtering
					blueprint.cwd = ctx.cwd;

					saveBlueprint(blueprint);

					// need_confirm=false OR non-interactive mode → auto-confirm without UI
					if (params.need_confirm === false || !ctx.hasUI) {
						blueprint.status = "confirmed";
						saveBlueprint(blueprint);
						if (ctx.hasUI) {
							ctx.ui.notify(`Blueprint "${blueprint.title}" 생성됨`, "info");
						}
						return {
							content: [
								{
									type: "text" as const,
									text: `Blueprint "${blueprint.title}" (${blueprint.id}) 생성 완료 (자동 확인).\n\`intent({ mode: "run_next", blueprintId: "${blueprint.id}" })\`를 호출해 실행을 시작하세요.`,
								},
							],
							details: { blueprintId: blueprint.id },
						};
					}

					// Show confirm UI overlay — block until user confirms or cancels
					const confirmed = await ctx.ui.custom<boolean>(
						(tui, theme, _kb, done) => {
							const viewerOpts: BlueprintDagViewerOptions = {
								confirmMode: true,
								onConfirm: () => done(true),
								onCancel: () => done(false),
							};
							const viewer = new BlueprintDagViewer(blueprint, () => done(false), viewerOpts);
							return {
								render: (w: number) => viewer.render(w, theme),
								handleInput: (data: string) => viewer.handleInput(data, tui),
								invalidate: () => {},
							};
						},
						{ overlay: true, overlayOptions: { width: "90%", maxHeight: "85%", anchor: "center" } },
					);

					if (!confirmed) {
						deleteBlueprint(blueprint.id);
						return {
							content: [{ type: "text" as const, text: "Blueprint 생성 취소됨 (사용자 취소)." }],
							details: { cancelled: true },
						};
					}

					// User confirmed
					blueprint.status = "confirmed";
					saveBlueprint(blueprint);
					return {
						content: [
							{
								type: "text" as const,
								text: `Blueprint "${blueprint.title}" (${blueprint.id}) 확인됨.\n\`intent({ mode: "run_next", blueprintId: "${blueprint.id}" })\`를 호출해 실행을 시작하세요.`,
							},
						],
						details: { blueprintId: blueprint.id },
					};
				}

				// ─── Run Next Nodes ──────────────────────────────────────
				case "run_next": {
					if (!params.blueprintId) {
						return {
							content: [{ type: "text" as const, text: "Error: run_next requires blueprintId." }],
							details: undefined,
						};
					}

					const result = await runNext(pi, params.blueprintId, ctx, signal);
					return {
						content: [{ type: "text" as const, text: result }],
						details: undefined,
					};
				}

				// ─── Single Intent ───────────────────────────────────────
				case "run": {
					if (!params.purpose || !params.difficulty || !params.task) {
						return {
							content: [
								{
									type: "text" as const,
									text: "Error: run mode requires purpose, difficulty, and task.",
								},
							],
							details: undefined,
						};
					}

					const result = await runSingleIntent(pi, params.purpose, params.difficulty, params.task, params.context, ctx, signal);
					return {
						content: [{ type: "text" as const, text: result }],
						details: undefined,
					};
				}

				// ─── Status ──────────────────────────────────────────────
				case "status": {
					if (!params.blueprintId) {
						// List single intents + blueprints
						const singles = listSingleRuns();
						const bps = listBlueprints();
						const sections: string[] = [];

						if (singles.length > 0) {
							const singleLines = singles.map((s) => {
								const icon = s.status === "running" ? "🔄" : s.status === "completed" ? "✅" : "❌";
								const elapsedMs = s.completedAt
									? new Date(s.completedAt).getTime() - new Date(s.startedAt).getTime()
									: Date.now() - new Date(s.startedAt).getTime();
								const elapsedSec = Math.floor(Math.max(0, elapsedMs) / 1000);
								const elapsed = elapsedSec < 60 ? `${elapsedSec}초` : `${Math.floor(elapsedSec / 60)}분`;
								return `${icon} ${s.id} ${s.purpose}/${s.difficulty} → ${s.agent} (${elapsed})`;
							});
							sections.push(`## 실행 중인 Intent (단발)\n${singleLines.join("\n")}`);
						}

						if (bps.length > 0) {
							const dagViews = bps.slice(0, 5).map((bp) => `\`\`\`\n${renderBlueprintDAGText(bp)}\n\`\`\``);
							sections.push(`## Blueprints\n${dagViews.join("\n\n---\n\n")}`);
						}

						if (sections.length === 0) {
							return {
								content: [{ type: "text" as const, text: "실행 중인 Intent나 Blueprint가 없습니다." }],
								details: undefined,
							};
						}

						return {
							content: [{ type: "text" as const, text: sections.join("\n\n") }],
							details: undefined,
						};
					}

					const bp = loadBlueprint(params.blueprintId);
					if (!bp) {
						return {
							content: [{ type: "text" as const, text: `Blueprint "${params.blueprintId}" not found.` }],
							details: undefined,
						};
					}
					return {
						content: [{ type: "text" as const, text: `\`\`\`\n${renderBlueprintDAGText(bp)}\n\`\`\`` }],
						details: undefined,
					};
				}

				// ─── Abort ───────────────────────────────────────────────
				case "abort": {
					if (!params.blueprintId) {
						return {
							content: [{ type: "text" as const, text: "Error: abort requires blueprintId." }],
							details: undefined,
						};
					}

					const bp = loadBlueprint(params.blueprintId);
					if (!bp) {
						return {
							content: [{ type: "text" as const, text: `Blueprint "${params.blueprintId}" not found.` }],
							details: undefined,
						};
					}

					// Abort active runs
					const aborted = abortAllBlueprintRuns(params.blueprintId);

					// Mark running nodes as failed
					for (const node of bp.nodes) {
						if (node.status === "running") {
							node.status = "failed";
							node.error = "Aborted by user";
							node.completedAt = new Date().toISOString();
						}
						if (node.status === "pending") {
							node.status = "skipped";
						}
					}
					bp.status = "aborted";
					saveBlueprint(bp);

					// Clear the widget immediately
					clearIntentWidget();

					return {
						content: [
							{
								type: "text" as const,
								text: `Blueprint "${bp.title}" aborted. ${aborted} active run(s) cancelled.\n\n\`\`\`\n${renderBlueprintDAGText(bp)}\n\`\`\``,
							},
						],
						details: undefined,
					};
				}

				// ─── Abort Single Run ────────────────────────────────────────
				case "abort_run": {
					if (!params.runId) {
						// No runId → list currently running single intents
						const running = listSingleRuns().filter((r) => r.status === "running");
						if (running.length === 0) {
							return {
								content: [{ type: "text" as const, text: "실행 중인 단발 intent가 없습니다." }],
								details: undefined,
							};
						}
						const lines = running.map(
							(r) => `- \`${r.id}\`: ${r.purpose}/${r.difficulty} → ${r.agent} (시작: ${r.startedAt})`,
						);
						return {
							content: [
								{
									type: "text" as const,
									text: `실행 중인 Intent:\n${lines.join("\n")}\n\nrunId를 지정해서 취소하세요:\n\`intent({ mode: "abort_run", runId: "intent-xxx" })\``,
								},
							],
							details: undefined,
						};
					}

					const cancelled = cancelSingleRun(params.runId);
					return {
						content: [
							{
								type: "text" as const,
								text: cancelled
									? `Intent \`${params.runId}\` 취소됨.`
									: `Intent \`${params.runId}\`를 찾을 수 없거나 이미 완료된 상태입니다.`,
							},
						],
						details: undefined,
					};
				}

				// ─── Retry Node ──────────────────────────────────────────
				case "retry_node": {
					if (!params.blueprintId || !params.nodeId) {
						return {
							content: [{ type: "text" as const, text: "Error: retry_node requires blueprintId and nodeId." }],
							details: undefined,
						};
					}

					const bp = resetNodeStatus(params.blueprintId, params.nodeId);
					if (!bp) {
						return {
							content: [
								{
									type: "text" as const,
									text: `노드 "${params.nodeId}"를 찾을 수 없거나 failed/skipped/escalated 상태가 아닙니다.`,
								},
							],
							details: undefined,
						};
					}

					// Immediately dispatch run_next so the retried node starts executing
					const runResult = await runNext(pi, params.blueprintId, ctx, signal);
					return {
						content: [
							{
								type: "text" as const,
								text: `노드 "${params.nodeId}" 재실행 시작.\n\n${runResult}`,
							},
						],
						details: undefined,
					};
				}

				// ─── Edit Blueprint ──────────────────────────────────
				case "edit_blueprint": {
					if (!params.blueprintId) {
						return {
							content: [{ type: "text" as const, text: "Error: edit_blueprint requires blueprintId." }],
							details: undefined,
						};
					}

					const bp = loadBlueprint(params.blueprintId);
					if (!bp) {
						return {
							content: [{ type: "text" as const, text: `Error: Blueprint "${params.blueprintId}" not found.` }],
							details: undefined,
						};
					}

					if (bp.status === "pending_confirm" || bp.status === "completed" || bp.status === "aborted") {
						return {
							content: [
								{
									type: "text" as const,
									text: `Error: Blueprint "${params.blueprintId}" status is "${bp.status}" — edit_blueprint requires confirmed or running status.`,
								},
							],
							details: undefined,
						};
					}

					if (!params.nodeUpdates || (params.nodeUpdates as string).trim() === "") {
						return {
							content: [{ type: "text" as const, text: "Error: edit_blueprint requires at least one nodeUpdate." }],
							details: undefined,
						};
					}

					let parsedNodeUpdates: Array<{
						id: string;
						task?: string;
						context?: string;
						purpose?: string;
						difficulty?: string;
						dependsOn?: string[];
						chainFrom?: string;
					}>;
					try {
						parsedNodeUpdates = parseYaml(params.nodeUpdates as string);
					} catch (e) {
						return {
							content: [{ type: "text" as const, text: `❌ nodeUpdates YAML 파싱 실패: ${e}` }],
							details: undefined,
						};
					}
					if (!Array.isArray(parsedNodeUpdates) || parsedNodeUpdates.length === 0) {
						return {
							content: [{ type: "text" as const, text: "Error: nodeUpdates YAML must be a non-empty array." }],
							details: undefined,
						};
					}

					const updatedNodeIds: string[] = [];
					const skippedNodes: Array<{ id: string; status: string }> = [];

					for (const update of parsedNodeUpdates) {
						const node = bp.nodes.find((n) => n.id === update.id);
						if (!node) {
							return {
								content: [
									{
										type: "text" as const,
										text: `Error: Node "${update.id}" not found in Blueprint "${params.blueprintId}".`,
									},
								],
								details: undefined,
							};
						}

						if (node.status !== "pending") {
							skippedNodes.push({ id: node.id, status: node.status });
							continue;
						}

						// Track old chainFrom before any updates
						const oldChainFrom = node.chainFrom;

						// Apply scalar field updates (only defined fields)
						if (update.task !== undefined) node.task = update.task;
						if (update.context !== undefined) node.context = update.context;

						// Apply purpose/difficulty and update agent if changed
						const purposeChanged = update.purpose !== undefined && update.purpose !== node.purpose;
						const difficultyChanged = update.difficulty !== undefined && update.difficulty !== node.difficulty;
						if (update.purpose !== undefined) node.purpose = update.purpose as any;
						if (update.difficulty !== undefined) node.difficulty = update.difficulty as any;
						if (purposeChanged || difficultyChanged) {
							node.agent = resolveAgent(node.purpose, node.difficulty);
						}

						// Apply explicit dependsOn if provided
						if (update.dependsOn !== undefined) node.dependsOn = update.dependsOn;

						// Handle chainFrom change → sync dependsOn
						if (update.chainFrom !== undefined) {
							node.chainFrom = update.chainFrom;
							if (update.chainFrom !== oldChainFrom) {
								// Remove old chainFrom from dependsOn
								if (oldChainFrom) {
									node.dependsOn = node.dependsOn.filter((dep) => dep !== oldChainFrom);
								}
								// Add new chainFrom to dependsOn
								if (update.chainFrom && !node.dependsOn.includes(update.chainFrom)) {
									node.dependsOn.push(update.chainFrom);
								}
							}
						}

						updatedNodeIds.push(node.id);
					}

					// Validate — if fails, do NOT save (in-memory changes are discarded)
					const errors = validateBlueprint(bp);
					if (errors.length > 0) {
						return {
							content: [
								{
									type: "text" as const,
									text: `Blueprint validation failed (변경 사항 롤백):\n${errors.map((e) => `- ${e}`).join("\n")}`,
								},
							],
							details: undefined,
						};
					}

					saveBlueprint(bp);

					// Build result message
					const lines: string[] = [`Blueprint "${bp.title}" 수정 완료`];
					if (updatedNodeIds.length > 0) {
						lines.push(`\n✅ 수정된 노드 (${updatedNodeIds.length}개): ${updatedNodeIds.join(", ")}`);
					} else {
						lines.push("\n(수정된 노드 없음)");
					}
					if (skippedNodes.length > 0) {
						const skippedDescs = skippedNodes.map((s) => `${s.id} (status: ${s.status} — pending 노드만 수정 가능)`);
						lines.push(`⚠️ skip된 노드 (${skippedNodes.length}개): ${skippedDescs.join(", ")}`);
					}

					return {
						content: [{ type: "text" as const, text: lines.join("\n") }],
						details: undefined,
					};
				}

				default:
					return {
						content: [{ type: "text" as const, text: `Unknown mode: "${(params as any).mode}"` }],
						details: undefined,
					};
			}
		},

		renderResult(result, _options, theme) {
			const details = result.details as any;
			const text = (result.content.find((c: any) => c.type === "text") as any)?.text ?? "";

			// Blueprint creation result → show DAG visually
			if (details?.blueprintId) {
				const bp = loadBlueprint(details.blueprintId);
				if (bp) {
					const fullText = renderBlueprintDAGText(bp);
					const lines = fullText.split("\n");
					// Show only the DAG portion (skip node-summary list after ─── separator)
					const sepIdx = lines.findIndex((l, i) => i >= 2 && /^─+/.test(l));
					const dagLines = sepIdx > 0 ? lines.slice(0, sepIdx) : lines;
					return new Text(dagLines.join("\n").trim(), 1, 0);
				}
			}

			// Cancelled → show brief message
			if (details?.cancelled) {
				return new Text(theme.fg("muted", "Blueprint 취소됨"), 1, 0);
			}

			// All other modes (run, run_next, status, etc.) → default text
			return new Text(text, 1, 0);
		},
	});

	// ─── /blueprint Command — DAG Viewer Overlay ─────────────────────────

	pi.registerCommand("blueprint", {
		description: "Blueprint DAG viewer — visualize execution flow",
		handler: async (args, ctx) => {
			let bp: Blueprint | null = null;

			if (args.trim()) {
				// Direct blueprint ID provided
				bp = loadBlueprint(args.trim());
				if (!bp) {
					ctx.ui.notify(`Blueprint "${args.trim()}" not found.`, "warning");
					return;
				}
			} else {
				// List available blueprints — scoped to current project (cwd)
				const bps = listBlueprints(ctx.cwd);
				if (bps.length === 0) {
					ctx.ui.notify("No blueprints found for current project.", "warning");
					return;
				}
				if (bps.length === 1) {
					bp = bps[0];
				} else {
					// Let user pick from list
					// ctx.ui.select accepts string[] and returns the selected string
					const labelToId = new Map<string, string>();
					const labels = bps.slice(0, 20).map((b) => {
						const completed = b.nodes.filter((n) => n.status === "completed").length;
						const total = b.nodes.length;
						const statusIcon =
							b.status === "completed" ? "✅" : b.status === "running" ? "🔄" : b.status === "failed" ? "❌" : "⬜";
						const label = `${statusIcon} ${b.title} [${completed}/${total}] ${b.status}`;
						labelToId.set(label, b.id);
						return label;
					});

					const selectedLabel = await ctx.ui.select("Blueprint 선택", labels);
					if (!selectedLabel) return;
					const selectedId = labelToId.get(selectedLabel);
					if (!selectedId) return;
					bp = loadBlueprint(selectedId);
				}
			}

			if (!bp) return;

			await ctx.ui.custom(
				(tui, theme, _kb, done) => {
					const viewer = new BlueprintDagViewer(bp!, () => done(undefined));
					return {
						render: (w: number) => viewer.render(w, theme),
						handleInput: (data: string) => viewer.handleInput(data, tui),
						invalidate: () => {},
					};
				},
				{
					overlay: true,
					overlayOptions: { width: "90%", maxHeight: "85%", anchor: "center" },
				},
			);
		},
	});
}
