/**
 * Subagent tool execute handler — extracted from commands.ts for modularity.
 *
 * createSubagentToolExecute(pi, store) returns the async execute function
 * that is passed to pi.registerTool({ execute: ... }).
 */

import * as fs from "node:fs";

import type { AgentConfig, AgentScope } from "./agents.js";
import { discoverAgents } from "./agents.js";
import { formatUsageStats } from "./format.js";
import {
	getFinalOutput,
	getLastNonEmptyLine,
	mapWithConcurrencyLimit,
	runSingleAgent,
} from "./runner.js";
import { buildMainContextText, makeSubagentSessionFile, wrapTaskWithMainContext } from "./session.js";
import { MAX_CONCURRENCY, MAX_PARALLEL_TASKS, type SubagentStore, updateRunFromResult } from "./store.js";
import type { ChainItemFields, CommandRunState, OnUpdateCallback, SingleResult, SubagentDetails, TaskItemFields } from "./types.js";
import { formatCommandRunSummary, trimCommandRunHistory } from "./run-utils.js";
import { updateCommandRunsWidget } from "./widget.js";

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import {
	DEFAULT_TURN_COUNT,
	PLACEHOLDER_RUNNING_EXIT_CODE,
	STATUS_OUTPUT_PREVIEW_MAX_CHARS,
} from "./constants.js";

type SessionToolCall = {
	name: string;
	argsText: string;
};

type SessionTurnToolCalls = {
	turn: number;
	toolCalls: SessionToolCall[];
};

type SessionDetailSummary = {
	finalOutput: string;
	turns: SessionTurnToolCalls[];
	error?: string;
};

function stringifyToolCallArguments(args: unknown): string {
	if (args === undefined || args === null) return "";
	if (typeof args === "string") return args;
	try {
		return JSON.stringify(args);
	} catch {
		return String(args);
	}
}

function getAssistantTextPart(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	for (const part of content) {
		if (!part || typeof part !== "object") continue;
		if ((part as any).type === "text" && typeof (part as any).text === "string") {
			return (part as any).text;
		}
	}
	return "";
}

function parseSessionDetailSummary(sessionFile?: string): SessionDetailSummary {
	if (!sessionFile) {
		return { finalOutput: "", turns: [], error: "Session file is not available for this run." };
	}
	if (!fs.existsSync(sessionFile)) {
		return { finalOutput: "", turns: [], error: `Session file not found: ${sessionFile}` };
	}

	let raw = "";
	try {
		raw = fs.readFileSync(sessionFile, "utf-8");
	} catch (error: any) {
		const message = error?.message ? String(error.message) : "Unknown read error";
		return { finalOutput: "", turns: [], error: `Failed to read session file: ${message}` };
	}

	const assistantMessages: any[] = [];
	const turns: SessionTurnToolCalls[] = [];

	for (const line of raw.split(/\r?\n/)) {
		if (!line.trim()) continue;

		let entry: any;
		try {
			entry = JSON.parse(line);
		} catch {
			continue;
		}

		if (entry?.type !== "message" || !entry.message || entry.message.role !== "assistant") continue;

		assistantMessages.push(entry.message);
		const turn = assistantMessages.length;
		const toolCalls: SessionToolCall[] = [];
		const content = entry.message.content;

		if (Array.isArray(content)) {
			for (const part of content) {
				if (!part || typeof part !== "object") continue;
				if ((part as any).type !== "toolCall") continue;
				const name = typeof (part as any).name === "string" ? (part as any).name : "tool";
				const argsText = stringifyToolCallArguments((part as any).arguments);
				toolCalls.push({ name, argsText });
			}
		}

		if (toolCalls.length > 0) {
			turns.push({ turn, toolCalls });
		}
	}

	let finalOutput = "";
	for (let i = assistantMessages.length - 1; i >= 0; i--) {
		const text = getAssistantTextPart(assistantMessages[i]?.content);
		if (text) {
			finalOutput = text;
			break;
		}
	}

	return { finalOutput, turns };
}

function formatRunDetailOutput(run: CommandRunState): string {
	const sessionSummary = parseSessionDetailSummary(run.sessionFile);
	const runOutput = run.lastOutput?.trim() ? run.lastOutput : "";
	const sessionOutput = sessionSummary.finalOutput?.trim() ? sessionSummary.finalOutput : "";
	const lineOutput = run.lastLine?.trim() ? run.lastLine : "";
	const output = runOutput || sessionOutput || lineOutput || "(no output)";
	const lines: string[] = [formatCommandRunSummary(run), `Task: ${run.task}`];

	if (run.sessionFile) lines.push(`Session: ${run.sessionFile}`);
	if (run.progressText) lines.push(`Progress: ${run.progressText}`);

	lines.push("", "Result:", output, "", "Tool calls by turn:");

	if (sessionSummary.error) {
		lines.push(`- (session parse error) ${sessionSummary.error}`);
	}

	if (sessionSummary.turns.length === 0) {
		lines.push("- (no tool calls)");
	} else {
		for (const turn of sessionSummary.turns) {
			lines.push(`Turn ${turn.turn}:`);
			for (const toolCall of turn.toolCalls) {
				lines.push(`  - ${toolCall.name}${toolCall.argsText ? ` ${toolCall.argsText}` : ""}`);
			}
		}
	}

	return lines.join("\n");
}

export function createSubagentToolExecute(pi: ExtensionAPI, store: SubagentStore) {
	return async (_toolCallId: string, params: Record<string, any>, signal: AbortSignal, onUpdate: OnUpdateCallback | undefined, ctx: any) => {
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

		if (asyncAction !== "run") {
			if (asyncAction === "list") {
				const runs = Array.from(store.commandRuns.values()).sort((a, b) => b.id - a.id);
				if (runs.length === 0) {
					return {
						content: [{ type: "text", text: "No subagent runs found." }],
						details: makeDetails("single")([]),
					};
				}
				const lines = runs.map((run) => `${formatCommandRunSummary(run)}\n  task: ${run.task}`);
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
				const preview =
					output.length > STATUS_OUTPUT_PREVIEW_MAX_CHARS
						? `${output.slice(0, STATUS_OUTPUT_PREVIEW_MAX_CHARS)}\n\n... [truncated]`
						: output;
				return {
					content: [
						{
							type: "text",
							text: `${formatCommandRunSummary(run)}\nTask: ${run.task}\n\n${preview}`,
						},
					],
					details: makeDetails("single")([]),
				};
			}

			if (asyncAction === "detail") {
				if (run.status === "running") {
					return {
						content: [{ type: "text", text: `Subagent run #${run.id} is still running. detail is available after completion.` }],
						details: makeDetails("single")([]),
						isError: true,
					};
				}
				return {
					content: [{ type: "text", text: formatRunDetailOutput(run) }],
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
				// Reuse existing run — same pattern as /sub:run command continuation
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
				runState.turnCount = Math.max(DEFAULT_TURN_COUNT, runState.turnCount || DEFAULT_TURN_COUNT) + 1;
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
					turnCount: DEFAULT_TURN_COUNT,
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
								(runState.progressText ? `\nProgress: ${runState.progressText}` : "") +
								`\n\n${rawOutput}`,
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
								progressText: runState.progressText,
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
								progressText: runState.progressText,
							},
						},
						{ deliverAs: "followUp", triggerTurn: true },
					);
					if (ctx.hasUI) ctx.ui.notify(`subagent tool run #${runId} failed: ${runState.lastLine}`, "error");
					updateCommandRunsWidget(store);
				} finally {
					runState.abortController = undefined;
					trimCommandRunHistory(store);
					updateCommandRunsWidget(store);
				}
			})();

			return {
				content: [
					{
						type: "text",
						text: continueFromRun
							? `Resumed async subagent run #${runId} (${resolvedAgent}) turn ${runState.turnCount}. ` +
							  `Use asyncAction=status/detail/list/abort/remove to monitor/control it.`
							: `Started async subagent run #${runId} (${resolvedAgent}). ` +
							  `Use asyncAction=status/detail/list/abort/remove to monitor/control it.`,
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
					exitCode: PLACEHOLDER_RUNNING_EXIT_CODE, // still running
					messages: [],
					stderr: "",
					usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
				};
			}

			const emitParallelUpdate = () => {
				if (onUpdate) {
					const running = allResults.filter((r) => r.exitCode === PLACEHOLDER_RUNNING_EXIT_CODE).length;
					const done = allResults.filter((r) => r.exitCode !== PLACEHOLDER_RUNNING_EXIT_CODE).length;
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
	};
}
