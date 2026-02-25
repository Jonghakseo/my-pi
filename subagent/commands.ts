/**
 * Tool handler, slash-command handlers, and event handlers for the Subagent extension.
 *
 * All handlers receive the shared SubagentStore and ExtensionAPI as parameters
 * instead of capturing closure variables — making dependencies explicit.
 */

import * as fs from "node:fs";
import type { AgentConfig, AgentScope } from "./agents.js";
import { discoverAgents } from "./agents.js";
import { formatToolCall, formatUsageStats } from "./format.js";
import { SubagentSessionReplayOverlay, readSessionReplayItems } from "./replay.js";
import {
	getDisplayItems,
	getFinalOutput,
	getLastNonEmptyLine,
	getSubCommandAgentCompletions,
	mapWithConcurrencyLimit,
	matchSubCommandAgent,
	runSingleAgent,
} from "./runner.js";
import { buildMainContextText, makeSubagentSessionFile, wrapTaskWithMainContext } from "./session.js";
import { COLLAPSED_ITEM_COUNT, MAX_CONCURRENCY, MAX_PARALLEL_TASKS, type SubagentStore, truncateText, updateRunFromResult } from "./store.js";
import type { ChainItemFields, CommandRunState, DisplayItem, OnUpdateCallback, SingleResult, SubagentDetails, TaskItemFields } from "./types.js";
import { SubagentParams } from "./types.js";
import { updateCommandRunsWidget } from "./widget.js";

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { getMarkdownTheme } from "@mariozechner/pi-coding-agent";
import { Container, Markdown, Spacer, Text } from "@mariozechner/pi-tui";

export function registerAll(pi: ExtensionAPI, store: SubagentStore): void {
	pi.registerTool({
		name: "subagent",
		label: "Subagent",
		description: [
			"Delegate tasks to specialized subagents with isolated context.",
			"Modes: single (agent + task), parallel (tasks array), chain (sequential with {previous} placeholder).",
			"Supports background async jobs via runAsync + asyncAction (list/status/abort/remove).",
			"Use contextMode: \"main\" to inherit current main-session context, or \"isolated\" for dedicated sub-session.",
			"Default agent scope is \"user\" (from ~/.pi/agent/agents).",
			"To enable project-local agents in .pi/agents, set agentScope: \"both\" (or \"project\").",
			"Important: Do NOT keep calling subagent for polling. Async runs push completion/failure/error updates automatically as follow-up messages; status/list is for occasional manual checks only.",
		].join(" "),
		parameters: SubagentParams,

		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const agentScope: AgentScope = params.agentScope ?? "user";
			const contextMode = params.contextMode ?? "isolated";
			let inheritMainContext = contextMode === "main";
			const discovery = discoverAgents(ctx.cwd, agentScope);
			const agents = discovery.agents;
			const confirmProjectAgents = params.confirmProjectAgents ?? true;
			const asyncActionRequested = params.asyncAction ?? "run";
			const mainSessionFile = inheritMainContext ? (ctx.sessionManager.getSessionFile() ?? undefined) : undefined;

			if (inheritMainContext && !mainSessionFile && asyncActionRequested === "run") {
				return {
					content: [
						{
							type: "text",
							text: "contextMode=main requires an active main session. Current session is unavailable (e.g. --no-session).",
						},
					],
					details: {
						mode: "single",
						agentScope,
						inheritMainContext,
						projectAgentsDir: discovery.projectAgentsDir,
						results: [],
					},
					isError: true,
				};
			}

			// Extract main session context as text instead of copying session file.
			// This prevents subagents from inheriting the main agent's persona.
			const mainContextText = inheritMainContext ? buildMainContextText(ctx) : "";

			const hasChain = (params.chain?.length ?? 0) > 0;
			const hasTasks = (params.tasks?.length ?? 0) > 0;
			const hasSingle = Boolean(params.agent && params.task);
			const modeCount = Number(hasChain) + Number(hasTasks) + Number(hasSingle);

			const makeDetails =
				(mode: "single" | "parallel" | "chain") =>
				(results: SingleResult[]): SubagentDetails => ({
					mode,
					agentScope,
					inheritMainContext,
					projectAgentsDir: discovery.projectAgentsDir,
					results,
				});

			const asyncAction = asyncActionRequested;

			const formatRunSummary = (run: CommandRunState): string => {
				const elapsedSec = Math.max(0, Math.round(run.elapsedMs / 1000));
				return `#${run.id} [${run.status}] ${run.agent} ctx:${run.contextMode ?? "sub"} turn:${run.turnCount ?? 1} ${elapsedSec}s tools:${run.toolCalls}`;
			};

			if (asyncAction !== "run") {
				if (asyncAction === "list") {
					const runs = Array.from(store.commandRuns.values()).sort((a, b) => b.id - a.id);
					if (runs.length === 0) {
						return {
							content: [{ type: "text", text: "No subagent runs found." }],
							details: makeDetails("single")([]),
						};
					}
					const lines = runs.map((run) => `${formatRunSummary(run)}\n  task: ${run.task}`);
					return {
						content: [{ type: "text", text: `Subagent runs\n\n${lines.join("\n\n")}` }],
						details: makeDetails("single")([]),
					};
				}

				if (params.runId === undefined) {
					return {
						content: [{ type: "text", text: `asyncAction=${asyncAction} requires runId.` }],
						details: makeDetails("single")([]),
						isError: true,
					};
				}

				const run = store.commandRuns.get(params.runId);
				if (!run) {
					return {
						content: [{ type: "text", text: `Unknown subagent run #${params.runId}.` }],
						details: makeDetails("single")([]),
						isError: true,
					};
				}

				if (asyncAction === "status") {
					const output = run.lastOutput ?? run.lastLine ?? "(no output yet)";
					const preview = output.length > 4000 ? `${output.slice(0, 4000)}\n\n... [truncated]` : output;
					return {
						content: [
							{
								type: "text",
								text: `${formatRunSummary(run)}\nTask: ${run.task}\n\n${preview}`,
							},
						],
						details: makeDetails("single")([]),
					};
				}

				if (asyncAction === "abort") {
					if (run.status !== "running" || !run.abortController) {
						return {
							content: [{ type: "text", text: `Subagent run #${run.id} is not running.` }],
							details: makeDetails("single")([]),
						};
					}
					run.lastLine = "Aborting by subagent tool...";
					run.lastOutput = run.lastLine;
					run.abortController.abort();
					updateCommandRunsWidget(store, ctx);
					return {
						content: [{ type: "text", text: `Aborting subagent run #${run.id}...` }],
						details: makeDetails("single")([]),
					};
				}

				if (asyncAction === "remove") {
					run.removed = true;
					if (run.status === "running" && run.abortController) {
						run.lastLine = "Aborting by subagent tool remove...";
						run.lastOutput = run.lastLine;
						run.abortController.abort();
					}
					run.abortController = undefined;
					store.commandRuns.delete(run.id);
					updateCommandRunsWidget(store, ctx);
					return {
						content: [{ type: "text", text: `Removed subagent run #${run.id}.` }],
						details: makeDetails("single")([]),
					};
				}
			}

			if (modeCount !== 1) {
				const available = agents.map((a) => `${a.name} (${a.source})`).join(", ") || "none";
				return {
					content: [
						{
							type: "text",
							text: `Invalid parameters. Provide exactly one mode.\nAvailable agents: ${available}`,
						},
					],
					details: makeDetails("single")([]),
				};
			}

			if ((agentScope === "project" || agentScope === "both") && confirmProjectAgents && ctx.hasUI) {
				const requestedAgentNames = new Set<string>();
				if (params.chain) for (const step of params.chain as ChainItemFields[]) requestedAgentNames.add(step.agent);
				if (params.tasks) for (const t of params.tasks as TaskItemFields[]) requestedAgentNames.add(t.agent);
				if (params.agent) requestedAgentNames.add(params.agent);

				const projectAgentsRequested = Array.from(requestedAgentNames)
					.map((name) => agents.find((a) => a.name === name))
					.filter((a): a is AgentConfig => a?.source === "project");

				if (projectAgentsRequested.length > 0) {
					const names = projectAgentsRequested.map((a) => a.name).join(", ");
					const dir = discovery.projectAgentsDir ?? "(unknown)";
					const ok = await ctx.ui.confirm(
						"Run project-local agents?",
						`Agents: ${names}\nSource: ${dir}\n\nProject agents are repo-controlled. Only continue for trusted repositories.`,
					);
					if (!ok)
						return {
							content: [{ type: "text", text: "Canceled: project-local agents not approved." }],
							details: makeDetails(hasChain ? "chain" : hasTasks ? "parallel" : "single")([]),
						};
				}
			}

			const runAsync = params.runAsync ?? true;

			if (runAsync) {
				if (!hasSingle || hasChain || hasTasks || !params.task) {
					return {
						content: [{ type: "text", text: "runAsync currently supports single mode only (agent + task)." }],
						details: makeDetails("single")([]),
						isError: true,
					};
				}

				// Async runs always use a dedicated session file (not a copy of
				// the main session) to avoid contamination.  The "B" approach is
				// used: mainContextText was already extracted above and will be
				// injected into the task via wrapTaskWithMainContext.
				// inheritMainContext is intentionally kept so that contextMode
				// metadata correctly reflects "main" when the caller requested it.

				// --- continueRunId: resume an existing completed/error run ---
				let continueFromRun: CommandRunState | undefined;
				if (params.continueRunId !== undefined) {
					continueFromRun = store.commandRuns.get(params.continueRunId);
					if (!continueFromRun) {
						return {
							content: [{ type: "text", text: `Unknown subagent run #${params.continueRunId}. Use asyncAction:"list" to see available runs.` }],
							details: makeDetails("single")([]),
							isError: true,
						};
					}
					if (continueFromRun.status === "running") {
						return {
							content: [{ type: "text", text: `Subagent #${params.continueRunId} is still running. Wait for it to finish or abort it first.` }],
							details: makeDetails("single")([]),
							isError: true,
						};
					}
				}

				const resolvedAgent = params.agent ?? continueFromRun?.agent ?? "worker";
				let runId: number;
				let runState: CommandRunState;
				let taskForDisplay: string;
				let sessionFileForRun: string | undefined;

				if (continueFromRun) {
					// Reuse existing run — same pattern as /sub command continuation
					runId = continueFromRun.id;
					taskForDisplay = `[continue #${runId}] ${params.task}`;
					sessionFileForRun = continueFromRun.sessionFile;

					runState = continueFromRun;
					runState.agent = resolvedAgent;
					runState.task = taskForDisplay;
					runState.status = "running";
					runState.startedAt = Date.now();
					runState.elapsedMs = 0;
					runState.toolCalls = 0;
					runState.lastLine = "";
					runState.lastOutput = "";
					runState.continuedFromRunId = params.continueRunId;
					runState.usage = undefined;
					runState.model = undefined;
					runState.removed = false;
					runState.turnCount = Math.max(1, runState.turnCount || 1) + 1;
					runState.contextMode = runState.contextMode ?? (inheritMainContext ? "main" : "sub");
					runState.sessionFile = runState.sessionFile ?? makeSubagentSessionFile(runId);
					sessionFileForRun = runState.sessionFile;
				} else {
					runId = store.nextCommandRunId++;
					taskForDisplay = params.task!;
					sessionFileForRun = makeSubagentSessionFile(runId);

					runState = {
						id: runId,
						agent: resolvedAgent,
						task: taskForDisplay,
						status: "running",
						startedAt: Date.now(),
						elapsedMs: 0,
						toolCalls: 0,
						lastLine: "",
						lastOutput: "",
						turnCount: 1,
						sessionFile: sessionFileForRun,
						removed: false,
						contextMode: inheritMainContext ? "main" : "sub",
					};
					store.commandRuns.set(runId, runState);
				}

				const abortController = new AbortController();
				runState.abortController = abortController;
				store.commandWidgetCtx = ctx;
				updateCommandRunsWidget(store, ctx);

				const startedState = continueFromRun ? "resumed" : "started";

				void (async () => {
					try {
						const result = await runSingleAgent(
							ctx.cwd,
							agents,
							resolvedAgent,
							wrapTaskWithMainContext(params.task!, mainContextText),
							params.cwd,
							undefined,
							abortController.signal,
							(partial) => {
								if (runState.removed) return;
								const current = partial.details?.results?.[0];
								if (!current) return;
								updateRunFromResult(runState, current);
								updateCommandRunsWidget(store);
							},
							makeDetails("single"),
							runState.sessionFile,
						);

						if (runState.removed) return;

						updateRunFromResult(runState, result);
						const isError =
							result.exitCode !== 0 || result.stopReason === "error" || result.stopReason === "aborted";
						runState.status = isError ? "error" : "done";
						runState.elapsedMs = Date.now() - runState.startedAt;
						updateCommandRunsWidget(store);

						const rawOutput = isError
							? result.errorMessage || result.stderr || getFinalOutput(result.messages) || "(no output)"
							: getFinalOutput(result.messages) || "(no output)";
						const output = rawOutput.length > 8000 ? `${rawOutput.slice(0, 8000)}\n\n... [truncated]` : rawOutput;
						const usage = formatUsageStats(result.usage, result.model);

						runState.lastOutput = rawOutput;
						if (rawOutput) runState.lastLine = getLastNonEmptyLine(rawOutput);

						pi.sendMessage(
							{
								customType: "subagent-tool",
								content:
									`[subagent:${resolvedAgent}#${runId}] ${isError ? "failed" : "completed"}` +
									`\nTask: ${taskForDisplay}` +
									(continueFromRun ? `\nContinued from: #${params.continueRunId}` : "") +
									(usage ? `\nUsage: ${usage}` : "") +
									`\n\n${output}`,
								display: true,
								details: {
									runId,
									agent: resolvedAgent,
									task: taskForDisplay,
									continuedFromRunId: params.continueRunId,
									turnCount: runState.turnCount,
									contextMode: runState.contextMode,
									sessionFile: runState.sessionFile,
									exitCode: result.exitCode,
									usage: result.usage,
									model: result.model,
									source: result.agentSource,
								},
							},
							{ deliverAs: "followUp", triggerTurn: true },
						);

						if (ctx.hasUI) {
							ctx.ui.notify(
								isError
									? `subagent tool run #${runId} (${resolvedAgent}) failed`
									: `subagent tool run #${runId} (${resolvedAgent}) completed`,
								isError ? "error" : "info",
							);
						}
					} catch (error: any) {
						if (runState.removed) return;
						runState.status = "error";
						runState.elapsedMs = Date.now() - runState.startedAt;
						runState.lastLine = error?.message ? String(error.message) : "Subagent execution failed";
						runState.lastOutput = runState.lastLine;
						pi.sendMessage(
							{
								customType: "subagent-tool",
								content:
									`[subagent:${resolvedAgent}#${runId}] failed` +
									`\nTask: ${taskForDisplay}` +
									(continueFromRun ? `\nContinued from: #${params.continueRunId}` : "") +
									`\n\n${runState.lastLine}`,
								display: true,
								details: {
									runId,
									agent: resolvedAgent,
									task: taskForDisplay,
									continuedFromRunId: params.continueRunId,
									turnCount: runState.turnCount,
									contextMode: runState.contextMode,
									sessionFile: runState.sessionFile,
									error: runState.lastLine,
								},
							},
							{ deliverAs: "followUp", triggerTurn: true },
						);
						if (ctx.hasUI) ctx.ui.notify(`subagent tool run #${runId} failed: ${runState.lastLine}`, "error");
						updateCommandRunsWidget(store);
					} finally {
						runState.abortController = undefined;
						const completed = Array.from(store.commandRuns.values())
							.filter((run) => run.status !== "running")
							.sort((a, b) => a.id - b.id);
						while (store.commandRuns.size > 10 && completed.length > 0) {
							const oldest = completed.shift();
							if (oldest) store.commandRuns.delete(oldest.id);
						}
						updateCommandRunsWidget(store);
					}
				})();

				return {
					content: [
						{
							type: "text",
							text: continueFromRun
								? `Resumed async subagent run #${runId} (${resolvedAgent}) turn ${runState.turnCount}. ` +
								  `Use asyncAction=status/list/abort/remove to monitor/control it.`
								: `Started async subagent run #${runId} (${resolvedAgent}). ` +
								  `Use asyncAction=status/list/abort/remove to monitor/control it.`,
						},
					],
					details: makeDetails("single")([]),
				};
			}

			if (params.chain && params.chain.length > 0) {
				const chainSteps = params.chain as ChainItemFields[];
				const results: SingleResult[] = [];
				let previousOutput = "";

				for (let i = 0; i < chainSteps.length; i++) {
					const step = chainSteps[i];
					const taskWithContext = step.task.replace(/\{previous\}/g, previousOutput);

					// Create update callback that includes all previous results
					const chainUpdate: OnUpdateCallback | undefined = onUpdate
						? (partial) => {
								// Combine completed results with current streaming result
								const currentResult = partial.details?.results[0];
								if (currentResult) {
									const allResults = [...results, currentResult];
									onUpdate({
										content: partial.content,
										details: makeDetails("chain")(allResults),
									});
								}
							}
						: undefined;

					const result = await runSingleAgent(
						ctx.cwd,
						agents,
						step.agent,
						wrapTaskWithMainContext(taskWithContext, mainContextText),
						step.cwd,
						i + 1,
						signal,
						chainUpdate,
						makeDetails("chain"),
						undefined,
					);
					results.push(result);

					const isError =
						result.exitCode !== 0 || result.stopReason === "error" || result.stopReason === "aborted";
					if (isError) {
						const errorMsg =
							result.errorMessage || result.stderr || getFinalOutput(result.messages) || "(no output)";
						return {
							content: [{ type: "text", text: `Chain stopped at step ${i + 1} (${step.agent}): ${errorMsg}` }],
							details: makeDetails("chain")(results),
							isError: true,
						};
					}
					previousOutput = getFinalOutput(result.messages);
				}
				return {
					content: [{ type: "text", text: getFinalOutput(results[results.length - 1].messages) || "(no output)" }],
					details: makeDetails("chain")(results),
				};
			}

			if (params.tasks && params.tasks.length > 0) {
				const parallelTasks = params.tasks as TaskItemFields[];
				if (parallelTasks.length > MAX_PARALLEL_TASKS)
					return {
						content: [
							{
								type: "text",
								text: `Too many parallel tasks (${parallelTasks.length}). Max is ${MAX_PARALLEL_TASKS}.`,
							},
						],
						details: makeDetails("parallel")([]),
					};

				// Track all results for streaming updates
				const allResults: SingleResult[] = new Array(parallelTasks.length);

				// Initialize placeholder results
				for (let i = 0; i < parallelTasks.length; i++) {
					allResults[i] = {
						agent: parallelTasks[i].agent,
						agentSource: "unknown",
						task: parallelTasks[i].task,
						exitCode: -1, // -1 = still running
						messages: [],
						stderr: "",
						usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
					};
				}

				const emitParallelUpdate = () => {
					if (onUpdate) {
						const running = allResults.filter((r) => r.exitCode === -1).length;
						const done = allResults.filter((r) => r.exitCode !== -1).length;
						onUpdate({
							content: [
								{ type: "text", text: `Parallel: ${done}/${allResults.length} done, ${running} running...` },
							],
							details: makeDetails("parallel")([...allResults]),
						});
					}
				};

				const results = await mapWithConcurrencyLimit(parallelTasks, MAX_CONCURRENCY, async (t, index) => {
					const result = await runSingleAgent(
						ctx.cwd,
						agents,
						t.agent,
						wrapTaskWithMainContext(t.task, mainContextText),
						t.cwd,
						undefined,
						signal,
						// Per-task update callback
						(partial) => {
							if (partial.details?.results[0]) {
								allResults[index] = partial.details.results[0];
								emitParallelUpdate();
							}
						},
						makeDetails("parallel"),
						undefined,
					);
					allResults[index] = result;
					emitParallelUpdate();
					return result;
				});

				const successCount = results.filter((r) => r.exitCode === 0).length;
				const summaries = results.map((r) => {
					const output = getFinalOutput(r.messages);
					return `[${r.agent}] ${r.exitCode === 0 ? "completed" : "failed"}:\n${output || "(no output)"}`;
				});
				return {
					content: [
						{
							type: "text",
							text: `Parallel: ${successCount}/${results.length} succeeded\n\n${summaries.join("\n\n")}`,
						},
					],
					details: makeDetails("parallel")(results),
				};
			}

			if (params.agent && params.task) {
				const result = await runSingleAgent(
					ctx.cwd,
					agents,
					params.agent,
					wrapTaskWithMainContext(params.task, mainContextText),
					params.cwd,
					undefined,
					signal,
					onUpdate,
					makeDetails("single"),
					undefined,
				);
				const isError = result.exitCode !== 0 || result.stopReason === "error" || result.stopReason === "aborted";
				if (isError) {
					const errorMsg =
						result.errorMessage || result.stderr || getFinalOutput(result.messages) || "(no output)";
					return {
						content: [{ type: "text", text: `Agent ${result.stopReason || "failed"}: ${errorMsg}` }],
						details: makeDetails("single")([result]),
						isError: true,
					};
				}
				return {
					content: [{ type: "text", text: getFinalOutput(result.messages) || "(no output)" }],
					details: makeDetails("single")([result]),
				};
			}

			const available = agents.map((a) => `${a.name} (${a.source})`).join(", ") || "none";
			return {
				content: [{ type: "text", text: `Invalid parameters. Available agents: ${available}` }],
				details: makeDetails("single")([]),
			};
		},

		renderCall(args, theme) {
			const scope: AgentScope = args.agentScope ?? "user";
			if (args.chain && args.chain.length > 0) {
				let text =
					theme.fg("toolTitle", theme.bold("subagent ")) +
					theme.fg("accent", `chain (${args.chain.length} steps)`) +
					theme.fg("muted", ` [${scope}]`);
				for (let i = 0; i < Math.min(args.chain.length, 3); i++) {
					const step = args.chain[i];
					// Clean up {previous} placeholder for display
					const cleanTask = step.task.replace(/\{previous\}/g, "").trim();
					const preview = cleanTask.length > 40 ? `${cleanTask.slice(0, 40)}...` : cleanTask;
					text +=
						"\n  " +
						theme.fg("muted", `${i + 1}.`) +
						" " +
						theme.fg("accent", step.agent) +
						theme.fg("dim", ` ${preview}`);
				}
				if (args.chain.length > 3) text += `\n  ${theme.fg("muted", `... +${args.chain.length - 3} more`)}`;
				return new Text(text, 0, 0);
			}
			if (args.tasks && args.tasks.length > 0) {
				let text =
					theme.fg("toolTitle", theme.bold("subagent ")) +
					theme.fg("accent", `parallel (${args.tasks.length} tasks)`) +
					theme.fg("muted", ` [${scope}]`);
				for (const t of args.tasks.slice(0, 3)) {
					const preview = t.task.length > 40 ? `${t.task.slice(0, 40)}...` : t.task;
					text += `\n  ${theme.fg("accent", t.agent)}${theme.fg("dim", ` ${preview}`)}`;
				}
				if (args.tasks.length > 3) text += `\n  ${theme.fg("muted", `... +${args.tasks.length - 3} more`)}`;
				return new Text(text, 0, 0);
			}
			const agentName = args.agent || "...";
			const preview = args.task ? (args.task.length > 60 ? `${args.task.slice(0, 60)}...` : args.task) : "...";
			let text =
				theme.fg("toolTitle", theme.bold("subagent ")) +
				theme.fg("accent", agentName) +
				theme.fg("muted", ` [${scope}]`);
			text += `\n  ${theme.fg("dim", preview)}`;
			return new Text(text, 0, 0);
		},

		renderResult(result, { expanded }, theme) {
			const details = result.details as SubagentDetails | undefined;
			if (!details || details.results.length === 0) {
				const text = result.content[0];
				return new Text(text?.type === "text" ? text.text : "(no output)", 0, 0);
			}

			const mdTheme = getMarkdownTheme();

			const renderDisplayItems = (items: DisplayItem[], limit?: number) => {
				const toShow = limit ? items.slice(-limit) : items;
				const skipped = limit && items.length > limit ? items.length - limit : 0;
				let text = "";
				if (skipped > 0) text += theme.fg("muted", `... ${skipped} earlier items\n`);
				for (const item of toShow) {
					if (item.type === "text") {
						const preview = expanded ? item.text : item.text.split("\n").slice(0, 3).join("\n");
						text += `${theme.fg("toolOutput", preview)}\n`;
					} else {
						text += `${theme.fg("muted", "→ ") + formatToolCall(item.name, item.args, theme.fg.bind(theme))}\n`;
					}
				}
				return text.trimEnd();
			};

			if (details.mode === "single" && details.results.length === 1) {
				const r = details.results[0];
				const isError = r.exitCode !== 0 || r.stopReason === "error" || r.stopReason === "aborted";
				const icon = isError ? theme.fg("error", "✗") : theme.fg("success", "✓");
				const displayItems = getDisplayItems(r.messages);
				const finalOutput = getFinalOutput(r.messages);

				if (expanded) {
					const container = new Container();
					let header = `${icon} ${theme.fg("toolTitle", theme.bold(r.agent))}${theme.fg("muted", ` (${r.agentSource})`)}`;
					if (isError && r.stopReason) header += ` ${theme.fg("error", `[${r.stopReason}]`)}`;
					container.addChild(new Text(header, 0, 0));
					if (isError && r.errorMessage)
						container.addChild(new Text(theme.fg("error", `Error: ${r.errorMessage}`), 0, 0));
					container.addChild(new Spacer(1));
					container.addChild(new Text(theme.fg("muted", "─── Task ───"), 0, 0));
					container.addChild(new Text(theme.fg("dim", r.task), 0, 0));
					container.addChild(new Spacer(1));
					container.addChild(new Text(theme.fg("muted", "─── Output ───"), 0, 0));
					if (displayItems.length === 0 && !finalOutput) {
						container.addChild(new Text(theme.fg("muted", "(no output)"), 0, 0));
					} else {
						for (const item of displayItems) {
							if (item.type === "toolCall")
								container.addChild(
									new Text(
										theme.fg("muted", "→ ") + formatToolCall(item.name, item.args, theme.fg.bind(theme)),
										0,
										0,
									),
								);
						}
						if (finalOutput) {
							container.addChild(new Spacer(1));
							container.addChild(new Markdown(finalOutput.trim(), 0, 0, mdTheme));
						}
					}
					const usageStr = formatUsageStats(r.usage, r.model);
					if (usageStr) {
						container.addChild(new Spacer(1));
						container.addChild(new Text(theme.fg("dim", usageStr), 0, 0));
					}
					return container;
				}

				let text = `${icon} ${theme.fg("toolTitle", theme.bold(r.agent))}${theme.fg("muted", ` (${r.agentSource})`)}`;
				if (isError && r.stopReason) text += ` ${theme.fg("error", `[${r.stopReason}]`)}`;
				if (isError && r.errorMessage) text += `\n${theme.fg("error", `Error: ${r.errorMessage}`)}`;
				else if (displayItems.length === 0) text += `\n${theme.fg("muted", "(no output)")}`;
				else {
					text += `\n${renderDisplayItems(displayItems, COLLAPSED_ITEM_COUNT)}`;
					if (displayItems.length > COLLAPSED_ITEM_COUNT) text += `\n${theme.fg("muted", "(Ctrl+O to expand)")}`;
				}
				const usageStr = formatUsageStats(r.usage, r.model);
				if (usageStr) text += `\n${theme.fg("dim", usageStr)}`;
				return new Text(text, 0, 0);
			}

			const aggregateUsage = (results: SingleResult[]) => {
				const total = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 };
				for (const r of results) {
					total.input += r.usage.input;
					total.output += r.usage.output;
					total.cacheRead += r.usage.cacheRead;
					total.cacheWrite += r.usage.cacheWrite;
					total.cost += r.usage.cost;
					total.turns += r.usage.turns;
				}
				return total;
			};

			if (details.mode === "chain") {
				const successCount = details.results.filter((r) => r.exitCode === 0).length;
				const icon = successCount === details.results.length ? theme.fg("success", "✓") : theme.fg("error", "✗");

				if (expanded) {
					const container = new Container();
					container.addChild(
						new Text(
							icon +
								" " +
								theme.fg("toolTitle", theme.bold("chain ")) +
								theme.fg("accent", `${successCount}/${details.results.length} steps`),
							0,
							0,
						),
					);

					for (const r of details.results) {
						const rIcon = r.exitCode === 0 ? theme.fg("success", "✓") : theme.fg("error", "✗");
						const displayItems = getDisplayItems(r.messages);
						const finalOutput = getFinalOutput(r.messages);

						container.addChild(new Spacer(1));
						container.addChild(
							new Text(
								`${theme.fg("muted", `─── Step ${r.step}: `) + theme.fg("accent", r.agent)} ${rIcon}`,
								0,
								0,
							),
						);
						container.addChild(new Text(theme.fg("muted", "Task: ") + theme.fg("dim", r.task), 0, 0));

						// Show tool calls
						for (const item of displayItems) {
							if (item.type === "toolCall") {
								container.addChild(
									new Text(
										theme.fg("muted", "→ ") + formatToolCall(item.name, item.args, theme.fg.bind(theme)),
										0,
										0,
									),
								);
							}
						}

						// Show final output as markdown
						if (finalOutput) {
							container.addChild(new Spacer(1));
							container.addChild(new Markdown(finalOutput.trim(), 0, 0, mdTheme));
						}

						const stepUsage = formatUsageStats(r.usage, r.model);
						if (stepUsage) container.addChild(new Text(theme.fg("dim", stepUsage), 0, 0));
					}

					const usageStr = formatUsageStats(aggregateUsage(details.results));
					if (usageStr) {
						container.addChild(new Spacer(1));
						container.addChild(new Text(theme.fg("dim", `Total: ${usageStr}`), 0, 0));
					}
					return container;
				}

				// Collapsed view
				let text =
					icon +
					" " +
					theme.fg("toolTitle", theme.bold("chain ")) +
					theme.fg("accent", `${successCount}/${details.results.length} steps`);
				for (const r of details.results) {
					const rIcon = r.exitCode === 0 ? theme.fg("success", "✓") : theme.fg("error", "✗");
					const displayItems = getDisplayItems(r.messages);
					text += `\n\n${theme.fg("muted", `─── Step ${r.step}: `)}${theme.fg("accent", r.agent)} ${rIcon}`;
					if (displayItems.length === 0) text += `\n${theme.fg("muted", "(no output)")}`;
					else text += `\n${renderDisplayItems(displayItems, 5)}`;
				}
				const usageStr = formatUsageStats(aggregateUsage(details.results));
				if (usageStr) text += `\n\n${theme.fg("dim", `Total: ${usageStr}`)}`;
				text += `\n${theme.fg("muted", "(Ctrl+O to expand)")}`;
				return new Text(text, 0, 0);
			}

			if (details.mode === "parallel") {
				const running = details.results.filter((r) => r.exitCode === -1).length;
				const successCount = details.results.filter((r) => r.exitCode === 0).length;
				const failCount = details.results.filter((r) => r.exitCode > 0).length;
				const isRunning = running > 0;
				const icon = isRunning
					? theme.fg("warning", "⏳")
					: failCount > 0
						? theme.fg("warning", "◐")
						: theme.fg("success", "✓");
				const status = isRunning
					? `${successCount + failCount}/${details.results.length} done, ${running} running`
					: `${successCount}/${details.results.length} tasks`;

				if (expanded && !isRunning) {
					const container = new Container();
					container.addChild(
						new Text(
							`${icon} ${theme.fg("toolTitle", theme.bold("parallel "))}${theme.fg("accent", status)}`,
							0,
							0,
						),
					);

					for (const r of details.results) {
						const rIcon = r.exitCode === 0 ? theme.fg("success", "✓") : theme.fg("error", "✗");
						const displayItems = getDisplayItems(r.messages);
						const finalOutput = getFinalOutput(r.messages);

						container.addChild(new Spacer(1));
						container.addChild(
							new Text(`${theme.fg("muted", "─── ") + theme.fg("accent", r.agent)} ${rIcon}`, 0, 0),
						);
						container.addChild(new Text(theme.fg("muted", "Task: ") + theme.fg("dim", r.task), 0, 0));

						// Show tool calls
						for (const item of displayItems) {
							if (item.type === "toolCall") {
								container.addChild(
									new Text(
										theme.fg("muted", "→ ") + formatToolCall(item.name, item.args, theme.fg.bind(theme)),
										0,
										0,
									),
								);
							}
						}

						// Show final output as markdown
						if (finalOutput) {
							container.addChild(new Spacer(1));
							container.addChild(new Markdown(finalOutput.trim(), 0, 0, mdTheme));
						}

						const taskUsage = formatUsageStats(r.usage, r.model);
						if (taskUsage) container.addChild(new Text(theme.fg("dim", taskUsage), 0, 0));
					}

					const usageStr = formatUsageStats(aggregateUsage(details.results));
					if (usageStr) {
						container.addChild(new Spacer(1));
						container.addChild(new Text(theme.fg("dim", `Total: ${usageStr}`), 0, 0));
					}
					return container;
				}

				// Collapsed view (or still running)
				let text = `${icon} ${theme.fg("toolTitle", theme.bold("parallel "))}${theme.fg("accent", status)}`;
				for (const r of details.results) {
					const rIcon =
						r.exitCode === -1
							? theme.fg("warning", "⏳")
							: r.exitCode === 0
								? theme.fg("success", "✓")
								: theme.fg("error", "✗");
					const displayItems = getDisplayItems(r.messages);
					text += `\n\n${theme.fg("muted", "─── ")}${theme.fg("accent", r.agent)} ${rIcon}`;
					if (displayItems.length === 0)
						text += `\n${theme.fg("muted", r.exitCode === -1 ? "(running...)" : "(no output)")}`;
					else text += `\n${renderDisplayItems(displayItems, 5)}`;
				}
				if (!isRunning) {
					const usageStr = formatUsageStats(aggregateUsage(details.results));
					if (usageStr) text += `\n\n${theme.fg("dim", `Total: ${usageStr}`)}`;
				}
				if (!expanded) text += `\n${theme.fg("muted", "(Ctrl+O to expand)")}`;
				return new Text(text, 0, 0);
			}

			const text = result.content[0];
			return new Text(text?.type === "text" ? text.text : "(no output)", 0, 0);
		},
	});

	const subCommand = {
		description:
			"Run a subagent in a dedicated sub-session: /subnew <agent|alias> <task>, /subnew <runId> <task>, /subnew <task> (defaults to worker)",
		getArgumentCompletions: (argumentPrefix) => {
			const trimmedStart = argumentPrefix.trimStart();
			if (trimmedStart.includes(" ")) return null;

			const discovery = discoverAgents(process.cwd(), "user");
			const agentItems = getSubCommandAgentCompletions(discovery.agents, argumentPrefix) ?? [];

			const runItems = Array.from(store.commandRuns.values())
				.sort((a, b) => b.id - a.id)
				.filter((run) => !trimmedStart || run.id.toString().startsWith(trimmedStart))
				.slice(0, 20)
				.map((run) => ({
					value: `${run.id} `,
					label: `${run.id}`,
					description: `continue ${run.agent}: ${truncateText(run.task, 50)}`,
				}));

			const merged = [...runItems, ...agentItems];
			return merged.length > 0 ? merged : null;
		},
		handler: async (args, ctx, forceMainContextFromWrapper = false) => {
			let input = (args ?? "").trim();
			const usageText =
				"Usage: /sub <agent|alias> <task> | /sub <runId> <task> | /sub <task> | /subnew <agent|alias> <task> | /subnew <runId> <task> | /subnew <task>";
			let forceMainContext = forceMainContextFromWrapper;

			if (input === "--main" || input.startsWith("--main ")) {
				ctx.ui.notify("'--main' 접두어는 사용할 수 없습니다. /sub 또는 /subnew 명령 자체로 컨텍스트를 선택하세요.", "warning");
				return;
			}

			if (!input) {
				ctx.ui.notify(usageText, "info");
				return;
			}

			const agentScope: AgentScope = "user";
			const discovery = discoverAgents(ctx.cwd, agentScope);
			const agents = discovery.agents;

			if (agents.length === 0) {
				ctx.ui.notify("No agents found in ~/.pi/agent/agents", "error");
				return;
			}

			const firstSpace = input.indexOf(" ");
			const firstToken = firstSpace === -1 ? input : input.slice(0, firstSpace);
			const continuationRun = /^\d+$/.test(firstToken) ? store.commandRuns.get(Number(firstToken)) : undefined;

			let selectedAgent: string;
			let taskForDisplay: string;
			let taskForAgent: string;
			let continuedFromRunId: number | undefined;
			let sessionFileForRun: string | undefined;

			if (continuationRun) {
				if (firstSpace === -1) {
					ctx.ui.notify(usageText, "info");
					return;
				}

				const targetRunId = Number(firstToken);
				const targetRun = continuationRun;

				if (targetRun.status === "running") {
					ctx.ui.notify(`Subagent #${targetRunId} is already running.`, "warning");
					return;
				}

				const nextInstruction = input.slice(firstSpace + 1).trim();
				if (!nextInstruction) {
					ctx.ui.notify(usageText, "info");
					return;
				}

				const previousAgentName = targetRun.agent;
				const directAgent = agents.find((agent) => agent.name.toLowerCase() === previousAgentName.toLowerCase());
				const fuzzyAgent = matchSubCommandAgent(agents, previousAgentName).matchedAgent;
				selectedAgent = directAgent?.name ?? fuzzyAgent?.name ?? previousAgentName;

				if (!agents.some((agent) => agent.name === selectedAgent)) {
					ctx.ui.notify(
						`Run #${targetRunId} references unknown agent "${previousAgentName}". Use /sub <agent> <task> instead.`,
						"error",
					);
					return;
				}

				taskForDisplay = `[continue #${targetRunId}] ${nextInstruction}`;
				continuedFromRunId = targetRunId;
				sessionFileForRun = targetRun.sessionFile;

				if (sessionFileForRun) {
					// True continuation: reuse the same per-run session file.
					taskForAgent = nextInstruction;
				} else {
					// Fallback for older runs that were started in isolated/no-session mode.
					const previousOutputRaw = (targetRun.lastOutput ?? targetRun.lastLine ?? "").trim();
					const previousOutput =
						previousOutputRaw.length > 6000
							? `${previousOutputRaw.slice(0, 6000)}\n... [truncated]`
							: previousOutputRaw;

					taskForAgent = [
						`Continue subagent run #${targetRunId} using the same agent (${selectedAgent}).`,
						`Previous task:\n${targetRun.task}`,
						previousOutput ? `Previous output:\n${previousOutput}` : "Previous output: (not available)",
						`New instruction:\n${nextInstruction}`,
					].join("\n\n");
				}
			} else {
				const { matchedAgent, ambiguousAgents } = matchSubCommandAgent(agents, firstToken);
				let resolvedAgent = matchedAgent;

				if (ambiguousAgents.length > 1) {
					const names = ambiguousAgents.map((agent) => agent.name).join(", ");

					if (firstSpace === -1) {
						ctx.ui.notify(`${usageText}. Ambiguous agent alias "${firstToken}": ${names}.`, "error");
						return;
					}

					// NOTE(user-approved): no-UI 모드에서의 안내 처리 방식은 현재 구현을 유지한다.
					// (headless/RPC 경고 경로 개선은 이번 변경 범위에서 제외)
					if (!ctx.hasUI) {
						ctx.ui.notify(
							`Ambiguous agent alias "${firstToken}": ${names}. Use a longer alias or exact name.`,
							"error",
						);
						return;
					}

					const selectedName = await ctx.ui.select(
						`Ambiguous alias "${firstToken}" — choose subagent`,
						ambiguousAgents.map((agent) => agent.name),
					);
					if (!selectedName) {
						ctx.ui.notify("Subagent selection cancelled.", "info");
						return;
					}

					resolvedAgent = ambiguousAgents.find((agent) => agent.name === selectedName);
					if (!resolvedAgent) {
						ctx.ui.notify("Could not resolve selected subagent.", "error");
						return;
					}
				}

				if (resolvedAgent && firstSpace === -1) {
					ctx.ui.notify(usageText, "info");
					return;
				}

				selectedAgent = resolvedAgent?.name ?? "worker";
				taskForDisplay = resolvedAgent ? input.slice(firstSpace + 1).trim() : input;

				if (!taskForDisplay) {
					ctx.ui.notify(usageText, "info");
					return;
				}

				taskForAgent = taskForDisplay;
			}

			let runId: number;
			let runState: CommandRunState;

			if (continuedFromRunId !== undefined) {
				const existingRun = store.commandRuns.get(continuedFromRunId);
				if (!existingRun) {
					ctx.ui.notify(`Unknown subagent run #${continuedFromRunId}.`, "error");
					return;
				}

				runId = existingRun.id;
				runState = existingRun;
				runState.agent = selectedAgent;
				runState.task = taskForDisplay;
				runState.status = "running";
				runState.startedAt = Date.now();
				runState.elapsedMs = 0;
				runState.toolCalls = 0;
				runState.lastLine = "";
				runState.lastOutput = "";
				runState.continuedFromRunId = continuedFromRunId;
				runState.usage = undefined;
				runState.model = undefined;
				runState.removed = false;
				runState.turnCount = Math.max(1, runState.turnCount || 1) + 1;
				// NOTE(user-approved): continuation 시 기존 context/session을 유지한다.
				// /sub 와 /subnew 간 모드 전환은 기존 run에는 소급 적용하지 않는다.
				runState.contextMode = runState.contextMode ?? (forceMainContext ? "main" : "sub");
				runState.sessionFile = runState.sessionFile ?? sessionFileForRun ?? makeSubagentSessionFile(runId);
				sessionFileForRun = runState.sessionFile;
			} else {
				runId = store.nextCommandRunId++;
				if (forceMainContext) {
					// Extract main session context as text instead of copying the session file.
					// This prevents subagents from inheriting the main agent's persona.
					const subContextText = buildMainContextText(ctx);
					if (subContextText) {
						taskForAgent = wrapTaskWithMainContext(taskForAgent, subContextText);
					} else {
						ctx.ui.notify(
							"Main session context is unavailable in this mode. Running with dedicated sub-session.",
							"warning",
						);
						forceMainContext = false;
					}
					sessionFileForRun = makeSubagentSessionFile(runId);
				} else {
					sessionFileForRun = makeSubagentSessionFile(runId);
				}

				runState = {
					id: runId,
					agent: selectedAgent,
					task: taskForDisplay,
					status: "running",
					startedAt: Date.now(),
					elapsedMs: 0,
					toolCalls: 0,
					lastLine: "",
					lastOutput: "",
					continuedFromRunId,
					turnCount: 1,
					sessionFile: sessionFileForRun,
					removed: false,
					contextMode: forceMainContext ? "main" : "sub",
				};
				store.commandRuns.set(runId, runState);
			}

			const abortController = new AbortController();
			runState.abortController = abortController;

			store.commandWidgetCtx = ctx;
			updateCommandRunsWidget(store, ctx);

			const makeDetails = (results: SingleResult[]): SubagentDetails => ({
				mode: "single",
				agentScope,
				inheritMainContext: runState.contextMode === "main",
				projectAgentsDir: discovery.projectAgentsDir,
				results,
			});

			const contextLabel = runState.contextMode === "main" ? "main context" : "dedicated sub-session";
			const startedState = continuedFromRunId !== undefined ? "resumed" : "started";

			pi.sendMessage(
				{
					customType: "subagent-command",
					content:
						`[sub:${selectedAgent}#${runId}] ${startedState}` +
						`\nTask: ${taskForDisplay}` +
						(continuedFromRunId !== undefined ? `\nContinued from: #${continuedFromRunId}` : "") +
						`\nContext: ${contextLabel} · turn ${runState.turnCount}`,
					display: true,
					details: {
						runId,
						agent: selectedAgent,
						task: taskForDisplay,
						continuedFromRunId,
						turnCount: runState.turnCount,
						contextMode: runState.contextMode,
						sessionFile: runState.sessionFile,
						status: startedState,
					},
				},
				continuedFromRunId !== undefined
					? { deliverAs: "followUp", triggerTurn: false }
					: { deliverAs: "nextTurn" },
			);

			ctx.ui.notify(
				(continuedFromRunId !== undefined
					? `Resumed subagent #${runId}: ${selectedAgent}`
					: `Started subagent #${runId}: ${selectedAgent}`) +
					` (${contextLabel} · turn ${runState.turnCount})`,
				"info",
			);

			const tick = setInterval(() => {
				const current = store.commandRuns.get(runId);
				if (!current || current.status !== "running") {
					clearInterval(tick);
					return;
				}
				current.elapsedMs = Date.now() - current.startedAt;
				updateCommandRunsWidget(store);
			}, 1000);

			void (async () => {
				try {
					const result = await runSingleAgent(
						ctx.cwd,
						agents,
						selectedAgent,
						taskForAgent,
						undefined,
						undefined,
						abortController.signal,
						(partial) => {
							if (runState.removed) return;
							const current = partial.details?.results?.[0];
							if (!current) return;
							updateRunFromResult(runState, current);
							updateCommandRunsWidget(store);
						},
						makeDetails,
						runState.sessionFile,
					);

					if (runState.removed) return;

					updateRunFromResult(runState, result);
					const isError =
						result.exitCode !== 0 || result.stopReason === "error" || result.stopReason === "aborted";
					runState.status = isError ? "error" : "done";
					runState.elapsedMs = Date.now() - runState.startedAt;
					updateCommandRunsWidget(store);

					const rawOutput = isError
						? result.errorMessage || result.stderr || getFinalOutput(result.messages) || "(no output)"
						: getFinalOutput(result.messages) || "(no output)";
					const output = rawOutput.length > 8000 ? `${rawOutput.slice(0, 8000)}\n\n... [truncated]` : rawOutput;
					const usage = formatUsageStats(result.usage, result.model);

					runState.lastOutput = rawOutput;
					if (rawOutput) runState.lastLine = getLastNonEmptyLine(rawOutput);

					pi.sendMessage(
						{
							customType: "subagent-command",
							content:
								`[sub:${selectedAgent}#${runId}] ${isError ? "failed" : "completed"}` +
								`\nTask: ${taskForDisplay}` +
								(continuedFromRunId !== undefined ? `\nContinued from: #${continuedFromRunId}` : "") +
								(usage ? `\nUsage: ${usage}` : "") +
								`\n\n${output}`,
							display: true,
							details: {
								runId,
								agent: selectedAgent,
								task: taskForDisplay,
								continuedFromRunId,
								turnCount: runState.turnCount,
								contextMode: runState.contextMode,
								sessionFile: runState.sessionFile,
								exitCode: result.exitCode,
								usage: result.usage,
								model: result.model,
								source: result.agentSource,
							},
						},
						{ deliverAs: "followUp" },
					);

					ctx.ui.notify(
						isError
							? `subagent #${runId} (${selectedAgent}) failed`
							: `subagent #${runId} (${selectedAgent}) completed`,
						isError ? "error" : "info",
					);
				} catch (error: any) {
					if (runState.removed) return;
					runState.status = "error";
					runState.elapsedMs = Date.now() - runState.startedAt;
					runState.lastLine = error?.message ? String(error.message) : "Subagent execution failed";
					runState.lastOutput = runState.lastLine;
					ctx.ui.notify(`subagent #${runId} failed: ${runState.lastLine}`, "error");
				} finally {
					clearInterval(tick);
					runState.abortController = undefined;

					const completed = Array.from(store.commandRuns.values())
						.filter((run) => run.status !== "running")
						.sort((a, b) => a.id - b.id);
					while (store.commandRuns.size > 10 && completed.length > 0) {
						const oldest = completed.shift();
						if (oldest) store.commandRuns.delete(oldest.id);
					}

					updateCommandRunsWidget(store);
				}
			})();
		},
	};

	pi.registerCommand("subnew", subCommand);

	pi.registerCommand("sub", {
		description: "Run a subagent with main-session context inheritance: /sub <agent|alias> <task>",
		getArgumentCompletions: subCommand.getArgumentCompletions,
		handler: async (args, ctx) => {
			const forwarded = (args ?? "").trim();
			await subCommand.handler(forwarded, ctx, true);
		},
	});

	pi.registerCommand("subagents", {
		description: "List available subagents and their model/tool settings",
		handler: async (args, ctx) => {
			const scopeArg = (args ?? "").trim().toLowerCase();
			const scope: AgentScope = scopeArg === "project" || scopeArg === "both" ? (scopeArg as AgentScope) : "user";
			const discovery = discoverAgents(ctx.cwd, scope);
			const agents = discovery.agents;
			if (agents.length === 0) {
				ctx.ui.notify("No subagents found.", "warning");
				return;
			}

			const lines = agents.map((a) => {
				const tools = a.tools?.join(",") ?? "default";
				const model = a.model ?? "(inherit current model)";
				return `- ${a.name} [${a.source}]\n  model: ${model}\n  tools: ${tools}\n  ${a.description}`;
			});

			pi.sendMessage(
				{
					customType: "subagent-command",
					content: `Available subagents (scope: ${scope})\n\n${lines.join("\n\n")}`,
					display: true,
				},
				{ deliverAs: "followUp" },
			);
		},
	});

	pi.registerCommand("subjobs", {
		description: "Show running/completed /sub jobs",
		handler: async (_args, ctx) => {
			store.commandWidgetCtx = ctx;
			if (store.commandRuns.size === 0) {
				ctx.ui.notify("No subagent jobs yet.", "info");
				return;
			}

			const lines = Array.from(store.commandRuns.values())
				.sort((a, b) => b.id - a.id)
				.map((run) => {
					const elapsedSec = Math.max(0, Math.round(run.elapsedMs / 1000));
					return `#${run.id} [${run.status}] ${run.agent} ctx:${run.contextMode ?? "sub"} turn:${run.turnCount ?? 1} ${elapsedSec}s tools:${run.toolCalls}\n  task: ${run.task}`;
				});

			ctx.ui.notify(`Subagent jobs\n\n${lines.join("\n\n")}`, "info");
		},
	});

	pi.registerCommand("subview", {
		description: "Open a subagent session replay overlay: /subview <runId>",
		getArgumentCompletions: (argumentPrefix) => {
			const trimmedStart = argumentPrefix.trimStart();
			if (trimmedStart.includes(" ")) return null;

			const items = Array.from(store.commandRuns.values())
				.sort((a, b) => b.id - a.id)
				.filter((run) => !trimmedStart || run.id.toString().startsWith(trimmedStart))
				.slice(0, 20)
				.map((run) => ({
					value: `${run.id}`,
					label: `${run.id}`,
					description: `${run.status} ${run.agent}: ${truncateText(run.task, 50)}`,
				}));

			return items.length > 0 ? items : null;
		},
		handler: async (args, ctx) => {
			const raw = (args ?? "").trim();
			if (!/^\d+$/.test(raw)) {
				ctx.ui.notify("Usage: /subview <runId>", "info");
				return;
			}

			const id = Number(raw);
			const run = store.commandRuns.get(id);
			if (!run) {
				const availableRunIds = Array.from(store.commandRuns.keys()).sort((a, b) => a - b);
				const availableText =
					availableRunIds.length > 0
						? `Available run IDs: ${availableRunIds.join(", ")}`
						: "No recent subagent runs available.";
				ctx.ui.notify(`Unknown subagent run #${id}. ${availableText}`, "error");
				return;
			}

			const elapsedSec = Math.max(0, Math.round(run.elapsedMs / 1000));
			const usageLine = run.usage ? `\nUsage: ${formatUsageStats(run.usage, run.model)}` : "";
			const output = (run.lastOutput ?? "").trim();
			const fallback =
				run.status === "running"
					? "(still running; no final output yet)"
					: run.lastLine || "(no output captured)";
			const content =
				`Subagent #${run.id} [${run.status}] ${run.agent} ctx:${run.contextMode ?? "sub"} turn:${run.turnCount ?? 1} ${elapsedSec}s tools:${run.toolCalls}` +
				`\nTask: ${run.task}` +
				usageLine +
				`\n\n${output || fallback}`;

			if (!ctx.hasUI) {
				return;
			}

			if (!run.sessionFile || !fs.existsSync(run.sessionFile)) {
				ctx.ui.notify(content, "info");
				return;
			}

			const replayItems = readSessionReplayItems(run.sessionFile);
			if (replayItems.length === 0) {
				ctx.ui.notify(content, "info");
				return;
			}

			await ctx.ui.custom(
				(tui, theme, _kb, done) => {
					const overlay = new SubagentSessionReplayOverlay(run, replayItems, () => done(undefined));
					return {
						render: (w) => overlay.render(w, 0 /* height computed internally */, theme),
						handleInput: (data) => overlay.handleInput(data, tui),
						invalidate: () => {},
					};
				},
				{
					overlay: true,
					overlayOptions: { width: "90%", maxHeight: "80%", anchor: "center" },
				},
			);
		},
	});

	pi.registerCommand("subtrans", {
		description: "Fork a subagent session into interactive mode",
		handler: async (args, ctx) => {
			const runId = parseInt(args.trim());
			if (isNaN(runId)) {
				ctx.ui.notify("Usage: /subfork <runId>", "error");
				return;
			}
			const run = store.commandRuns.get(runId);
			if (!run) {
				ctx.ui.notify(`Run #${runId} not found. Use /sub to list runs.`, "error");
				return;
			}
			if (run.status === "running") {
				ctx.ui.notify(`Run #${runId} is still running. Wait for it to finish or abort it first.`, "error");
				return;
			}
			if (!run.sessionFile) {
				ctx.ui.notify(`Run #${runId} has no session file.`, "error");
				return;
			}
			const success = await ctx.switchSession(run.sessionFile);
			if (!success) {
				ctx.ui.notify(`Failed to switch to session: ${run.sessionFile}`, "error");
			}
		},
	});

	pi.registerCommand("subrm", {
		description: "Remove one /sub job entry (aborts it if running): /subrm <runId>",
		handler: async (args, ctx) => {
			const raw = (args ?? "").trim();
			if (!/^\d+$/.test(raw)) {
				ctx.ui.notify("Usage: /subrm <runId>", "info");
				return;
			}

			const id = Number(raw);
			const run = store.commandRuns.get(id);
			if (!run) {
				ctx.ui.notify(`Unknown subagent run #${id}.`, "error");
				return;
			}

			let aborted = false;
			run.removed = true;
			if (run.status === "running" && run.abortController) {
				run.lastLine = "Aborting by /subrm...";
				run.lastOutput = run.lastLine;
				run.abortController.abort();
				aborted = true;
			}

			run.abortController = undefined;
			store.commandRuns.delete(id);
			pi.appendEntry("subagent-removed", { runId: id });
			updateCommandRunsWidget(store, ctx);
			ctx.ui.notify(
				aborted
					? `Removed subagent #${id} (aborting in background).`
					: `Removed subagent #${id}.`,
				aborted ? "warning" : "info",
			);
		},
	});

	pi.registerCommand("subclear", {
		description: "Clear /sub job widget entries. /subclear (finished only) or /subclear all",
		handler: async (args, ctx) => {
			const mode = (args ?? "").trim().toLowerCase();
			if (mode === "all") {
				const count = store.commandRuns.size;
				for (const id of store.commandRuns.keys()) {
					pi.appendEntry("subagent-removed", { runId: id });
				}
				store.commandRuns.clear();
				updateCommandRunsWidget(store, ctx);
				ctx.ui.notify(`Cleared ${count} subagent job(s).`, "info");
				return;
			}

			let removed = 0;
			for (const [id, run] of Array.from(store.commandRuns.entries())) {
				if (run.status !== "running") {
					pi.appendEntry("subagent-removed", { runId: id });
					store.commandRuns.delete(id);
					removed++;
				}
			}
			updateCommandRunsWidget(store, ctx);
			ctx.ui.notify(`Cleared ${removed} finished subagent job(s).`, "info");
		},
	});

	const handleSubAbort = async (args: string, ctx: any) => {
		const raw = (args ?? "").trim().toLowerCase();
		const running = Array.from(store.commandRuns.values())
			.filter((run) => run.status === "running")
			.sort((a, b) => b.id - a.id);

		if (running.length === 0) {
			ctx.ui.notify("No running subagent jobs.", "info");
			return;
		}

		const abortRun = (run: CommandRunState): boolean => {
			if (!run.abortController) return false;
			run.lastLine = "Aborting by user...";
			run.lastOutput = run.lastLine;
			run.abortController.abort();
			return true;
		};

		if (!raw) {
			const target = running[0];
			if (!abortRun(target)) {
				ctx.ui.notify(`Subagent #${target.id} is not abortable right now.`, "warning");
				return;
			}
			updateCommandRunsWidget(store, ctx);
			ctx.ui.notify(`Aborting subagent #${target.id} (${target.agent})...`, "warning");
			return;
		}

		if (raw === "all") {
			let count = 0;
			for (const run of running) {
				if (abortRun(run)) count++;
			}
			updateCommandRunsWidget(store, ctx);
			ctx.ui.notify(
				count > 0 ? `Aborting ${count} running subagent job(s)...` : "No abortable subagent jobs.",
				count > 0 ? "warning" : "info",
			);
			return;
		}

		if (/^\d+$/.test(raw)) {
			const id = Number(raw);
			const run = store.commandRuns.get(id);
			if (!run) {
				ctx.ui.notify(`Unknown subagent run #${id}.`, "error");
				return;
			}
			if (run.status !== "running") {
				ctx.ui.notify(`Subagent #${id} is not running.`, "info");
				return;
			}
			if (!abortRun(run)) {
				ctx.ui.notify(`Subagent #${id} is not abortable right now.`, "warning");
				return;
			}
			updateCommandRunsWidget(store, ctx);
			ctx.ui.notify(`Aborting subagent #${id} (${run.agent})...`, "warning");
			return;
		}

		ctx.ui.notify("Usage: /sub:abort [runId|all]", "info");
	};

	pi.registerCommand("sub:abort", {
		description: "Abort running /sub job(s). /sub:abort [runId|all]",
		handler: async (args, ctx) => {
			await handleSubAbort(args, ctx);
		},
	});

	pi.registerCommand("subabort", {
		description: "Alias of /sub:abort",
		handler: async (args, ctx) => {
			await handleSubAbort(args, ctx);
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		store.commandRuns.clear();
		store.commandWidgetCtx = ctx;

		// Restore subagent run history from session entries so that
		// reload / session-switch preserves the run list and allows resume.
		try {
			const entries = ctx.sessionManager.getEntries();
			const restoredRuns = new Map<number, CommandRunState>();
			const removedRunIds = new Set<number>();
			let maxRunId = 0;

			// First pass: collect removed run IDs
			for (const entry of entries) {
				if (entry.type === "custom") {
					const ce = entry as any;
					if (ce.customType === "subagent-removed" && ce.data?.runId != null) {
						removedRunIds.add(ce.data.runId);
					}
				}
			}

			for (const entry of entries) {
				if (entry.type !== "custom_message") continue;
				const cm = entry as any;
				if (cm.customType !== "subagent-command" && cm.customType !== "subagent-tool") continue;
				const d = cm.details;
				if (!d || typeof d.runId !== "number") continue;

				const runId = d.runId;
				if (runId > maxRunId) maxRunId = runId;

				const existing = restoredRuns.get(runId);

				// Determine status from the message content
				const content = typeof cm.content === "string" ? cm.content : "";
				const isCompleted = content.includes("] completed");
				const isFailed = content.includes("] failed");
				const isError = content.includes("] error");

				if (isCompleted || isFailed || isError) {
					// Final message — create or overwrite with done/error state
					const status = isCompleted ? "done" : "error";
					const run: CommandRunState = {
						id: runId,
						agent: d.agent ?? existing?.agent ?? "unknown",
						task: d.task ?? existing?.task ?? "",
						status,
						startedAt: existing?.startedAt ?? Date.now(),
						elapsedMs: existing?.elapsedMs ?? 0,
						toolCalls: existing?.toolCalls ?? 0,
						lastLine: existing?.lastLine ?? "",
						lastOutput: existing?.lastOutput ?? "",
						continuedFromRunId: d.continuedFromRunId,
						turnCount: d.turnCount ?? existing?.turnCount ?? 1,
						sessionFile: d.sessionFile ?? existing?.sessionFile,
						contextMode: d.contextMode ?? existing?.contextMode,
						usage: d.usage ?? existing?.usage,
						model: d.model ?? existing?.model,
					};
					// Extract output from content (after the header lines)
					const lines = content.split("\n");
					const bodyStart = lines.findIndex((l: string) => l === "") + 1;
					if (bodyStart > 0 && bodyStart < lines.length) {
						run.lastOutput = lines.slice(bodyStart).join("\n");
						run.lastLine = getLastNonEmptyLine(run.lastOutput);
					}
					restoredRuns.set(runId, run);
				} else {
					// Started/resumed message — always update so we track the latest continuation.
					// If a completion message follows, it will overwrite this.
					// If not (crash/abort), this "interrupted" state persists.
					restoredRuns.set(runId, {
						id: runId,
						agent: d.agent ?? existing?.agent ?? "unknown",
						task: d.task ?? existing?.task ?? "",
						status: "error",
						startedAt: existing?.startedAt ?? Date.now(),
						elapsedMs: existing?.elapsedMs ?? 0,
						toolCalls: existing?.toolCalls ?? 0,
						lastLine: "(interrupted — started but no completion found)",
						lastOutput: existing?.lastOutput,
						continuedFromRunId: d.continuedFromRunId,
						turnCount: d.turnCount ?? existing?.turnCount ?? 1,
						sessionFile: d.sessionFile ?? existing?.sessionFile,
						contextMode: d.contextMode ?? existing?.contextMode,
						usage: existing?.usage,
						model: existing?.model,
					});
				}
			}

			for (const [id, run] of restoredRuns) {
				if (removedRunIds.has(id)) continue;
				store.commandRuns.set(id, run);
			}
			if (maxRunId >= store.nextCommandRunId) {
				store.nextCommandRunId = maxRunId + 1;
			}
		} catch (_e) {
			// Silently ignore restore errors — fresh state is fine
		}

		updateCommandRunsWidget(store, ctx);
	});

	// Hide subagent-command messages from the main agent's LLM context.
	// They remain visible in the TUI but are stripped before each LLM call.
	pi.on("context", async (event, _ctx) => {
		const filtered = event.messages.filter(
			(m: any) => !(m.role === "custom" && m.customType === "subagent-command"),
		);
		return { messages: filtered };
	});
}
