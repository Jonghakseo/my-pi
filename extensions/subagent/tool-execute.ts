/**
 * Subagent tool execute handler — extracted from commands.ts for modularity.
 *
 * createSubagentToolExecute(pi, store) returns the async execute function
 * that is passed to pi.registerTool({ execute: ... }).
 */

import * as fs from "node:fs";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type { AgentConfig, AgentScope } from "./agents.js";
import { discoverAgents } from "./agents.js";
import {
	DEFAULT_TURN_COUNT,
	IDLE_RUN_WARNING_THRESHOLD,
	MAX_CONCURRENT_ASYNC_SUBAGENT_RUNS,
	PLACEHOLDER_RUNNING_EXIT_CODE,
	STATUS_OUTPUT_PREVIEW_MAX_CHARS,
} from "./constants.js";
import {
	formatContextUsageBar,
	formatUsageStats,
	getUsedContextPercent,
	resolveContextWindow,
	truncateLines,
} from "./format.js";
import { formatCommandRunSummary, removeRun, trimCommandRunHistory } from "./run-utils.js";
import { getFinalOutput, getLastNonEmptyLine, mapWithConcurrencyLimit, runSingleAgent } from "./runner.js";
import { buildMainContextText, makeSubagentSessionFile, wrapTaskWithMainContext } from "./session.js";
import {
	MAX_CONCURRENCY,
	MAX_PARALLEL_TASKS,
	collectToolCallCount,
	type SubagentStore,
	updateRunFromResult,
} from "./store.js";
import type {
	ChainItemFields,
	CommandRunState,
	OnUpdateCallback,
	SingleResult,
	SubagentDetails,
	TaskItemFields,
} from "./types.js";
import { updateCommandRunsWidget } from "./widget.js";

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
	const lines: string[] = [formatCommandRunSummary(run), `Prompt: ${run.task}`];

	if (run.sessionFile) lines.push(`Session: ${run.sessionFile}`);
	if (run.thoughtText) lines.push(`Thought: ${run.thoughtText}`);

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

function isResultError(result: SingleResult): boolean {
	return result.exitCode !== 0 || result.stopReason === "error" || result.stopReason === "aborted";
}

function aggregateUsage(results: SingleResult[]) {
	return results.reduce(
		(acc, result) => {
			acc.input += result.usage?.input ?? 0;
			acc.output += result.usage?.output ?? 0;
			acc.cacheRead += result.usage?.cacheRead ?? 0;
			acc.cacheWrite += result.usage?.cacheWrite ?? 0;
			acc.cost += result.usage?.cost ?? 0;
			acc.contextTokens += result.usage?.contextTokens ?? 0;
			acc.turns += result.usage?.turns ?? 0;
			return acc;
		},
		{ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
	);
}

function buildParallelRunTaskPreview(tasks: TaskItemFields[]): string {
	const previews = tasks.slice(0, 3).map((task, index) => {
		const normalizedTask = truncateLines(task.task, 1).replace(/\s*\n+\s*/g, " ").trim();
		return `${index + 1}. ${task.agent}: ${normalizedTask}`;
	});
	const suffix = tasks.length > 3 ? ` | ... +${tasks.length - 3} more` : "";
	return `[parallel ${tasks.length} tasks] ${previews.join(" | ")}${suffix}`;
}

function buildParallelOutputSummary(tasks: TaskItemFields[], results: SingleResult[]): {
	successCount: number;
	failureCount: number;
	output: string;
} {
	const lines: string[] = [];
	let successCount = 0;
	let failureCount = 0;

	for (let i = 0; i < results.length; i++) {
		const result = results[i];
		const task = tasks[i];
		const failed = isResultError(result);
		const output = failed
			? result.errorMessage || result.stderr || getFinalOutput(result.messages) || "(no output)"
			: getFinalOutput(result.messages) || "(no output)";

		if (failed) failureCount += 1;
		else successCount += 1;

		lines.push(
			`[${i + 1}/${results.length}] ${result.agent} ${failed ? "failed" : "completed"}`,
			`Task: ${truncateLines(task?.task ?? result.task, 2)}`,
			output,
		);
		if (i < results.length - 1) lines.push("", "---", "");
	}

	return {
		successCount,
		failureCount,
		output: lines.join("\n") || "(no output)",
	};
}

function updateParallelRunProgress(runState: CommandRunState, results: SingleResult[], totalTasks: number): void {
	const runningCount = results.filter((result) => result.exitCode === PLACEHOLDER_RUNNING_EXIT_CODE).length;
	const doneCount = Math.max(0, totalTasks - runningCount);
	const failureCount = results.filter(
		(result) => result.exitCode !== PLACEHOLDER_RUNNING_EXIT_CODE && isResultError(result),
	).length;
	const successCount = Math.max(0, doneCount - failureCount);

	runState.elapsedMs = Date.now() - runState.startedAt;
	runState.toolCalls = results.reduce(
		(count, result) => count + Math.max(result.liveToolCalls ?? 0, collectToolCallCount(result.messages)),
		0,
	);

	const latestThought = [...results]
		.reverse()
		.find((result) => typeof result.thoughtText === "string" && result.thoughtText.trim().length > 0);
	if (latestThought?.thoughtText) runState.thoughtText = latestThought.thoughtText;

	let latestPreview = "";
	for (let i = results.length - 1; i >= 0; i--) {
		const result = results[i];
		const live = result.liveText ? getLastNonEmptyLine(result.liveText) : "";
		if (live) {
			latestPreview = `${result.agent}: ${live}`;
			break;
		}
		const output = getFinalOutput(result.messages);
		const outputLine = output ? getLastNonEmptyLine(output) : "";
		if (outputLine) {
			latestPreview = `${result.agent}: ${outputLine}`;
			break;
		}
	}

	const base = `Parallel ${doneCount}/${totalTasks} done (${successCount} ok, ${failureCount} fail${
		runningCount > 0 ? `, ${runningCount} running` : ""
	})`;
	runState.lastLine = latestPreview ? `${base} · ${latestPreview}` : base;
	runState.lastOutput = runState.lastLine;
	runState.lastActivityAt = Date.now();
}

function getRunCounts(store: SubagentStore): { running: number; idle: number } {
	const dedupedRunning = new Map<number, CommandRunState>();

	for (const [runId, run] of store.commandRuns) {
		if (run.removed) continue;
		dedupedRunning.set(runId, run);
	}

	for (const [runId, entry] of store.globalLiveRuns) {
		if (entry.runState.removed) continue;
		dedupedRunning.set(runId, entry.runState);
	}

	const running = Array.from(dedupedRunning.values()).filter((run) => run.status === "running").length;
	const idle = Array.from(store.commandRuns.values()).filter((run) => !run.removed && run.status !== "running").length;
	return { running, idle };
}

function formatIdleRunWarning(idleRunCount: number): string {
	return (
		`⚠️ Idle subagent runs: ${idleRunCount}. ` +
		`removed되지 않은 완료/오류 run이 ${IDLE_RUN_WARNING_THRESHOLD}개 이상입니다. ` +
		`필요 없는 run은 asyncAction:"remove"로 정리하세요.`
	);
}

/** Return type for the subagent execute function (extends AgentToolResult with optional isError). */
type SubagentExecuteResult = {
	content: { type: "text"; text: string }[];
	details: SubagentDetails;
	isError?: boolean;
};

export function createSubagentToolExecute(pi: ExtensionAPI, store: SubagentStore) {
	return async (
		_toolCallId: string,
		params: Record<string, any>,
		signal: AbortSignal | undefined,
		onUpdate: OnUpdateCallback | undefined,
		ctx: any,
	): Promise<SubagentExecuteResult> => {
		const agentScope: AgentScope = params.agentScope ?? "user";
		const contextMode = params.contextMode ?? "isolated";
		const inheritMainContext = contextMode === "main";
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

		const runCounts = getRunCounts(store);
		const idleRunWarning =
			runCounts.idle >= IDLE_RUN_WARNING_THRESHOLD ? formatIdleRunWarning(runCounts.idle) : undefined;

		if (idleRunWarning && ctx.hasUI) {
			ctx.ui.notify(idleRunWarning, "warning");
		}

		const withIdleRunWarning = (text: string): string =>
			idleRunWarning ? `${idleRunWarning}\n\n${text}` : text;

		const asyncAction = asyncActionRequested;

		if (asyncAction !== "run") {
			if (asyncAction === "list") {
				const runs = Array.from(store.commandRuns.values()).sort((a, b) => b.id - a.id);
				if (runs.length === 0) {
					return {
						content: [{ type: "text", text: withIdleRunWarning("No subagent runs found.") }],
						details: makeDetails("single")([]),
					};
				}
				const lines = runs.map((run) => {
					const contextWindow = resolveContextWindow(ctx, run.model);
					const usedPercent = getUsedContextPercent(run.usage?.contextTokens, contextWindow);
					const usageSuffix = usedPercent === undefined ? "" : ` usage:${formatContextUsageBar(usedPercent)}`;
					const taskPreview = truncateLines(run.task, 2).replace(/\n/g, "\n  ");
					return `${formatCommandRunSummary(run)}${usageSuffix}\n  ${taskPreview}`;
				});
				return {
					content: [{ type: "text", text: withIdleRunWarning(`Subagent runs\n\n${lines.join("\n\n")}`) }],
					details: makeDetails("single")([]),
				};
			}

			const rawRunIds = Array.isArray(params.runIds) ? params.runIds : undefined;
			const invalidRunIds = (rawRunIds ?? []).filter((value) => !Number.isInteger(value));
			if (invalidRunIds.length > 0) {
				return {
					content: [{ type: "text", text: `runIds must be an array of integer run IDs.` }],
					details: makeDetails("single")([]),
					isError: true,
				};
			}

			const runIdsFromArray = ((rawRunIds ?? []) as number[]).filter((value) => Number.isInteger(value));
			const hasRunId = Number.isInteger(params.runId);
			const hasRunIds = runIdsFromArray.length > 0;
			const isBulkAction = asyncAction === "abort" || asyncAction === "remove";

			if (!isBulkAction && rawRunIds !== undefined) {
				return {
					content: [{ type: "text", text: `asyncAction=${asyncAction} does not support runIds. Use runId.` }],
					details: makeDetails("single")([]),
					isError: true,
				};
			}

			if (hasRunId && hasRunIds) {
				return {
					content: [{ type: "text", text: `Use either runId or runIds, not both.` }],
					details: makeDetails("single")([]),
					isError: true,
				};
			}

			if (!hasRunId && !hasRunIds) {
				const required = isBulkAction ? "runId or runIds" : "runId";
				return {
					content: [{ type: "text", text: `asyncAction=${asyncAction} requires ${required}.` }],
					details: makeDetails("single")([]),
					isError: true,
				};
			}

			const targetRunIds = hasRunIds ? Array.from(new Set(runIdsFromArray)) : [params.runId as number];
			const firstRunId = targetRunIds[0];

			if (asyncAction === "status" || asyncAction === "detail") {
				const run = store.commandRuns.get(firstRunId);
				if (!run) {
					return {
						content: [{ type: "text", text: `Unknown subagent run #${firstRunId}.` }],
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
								text: `${formatCommandRunSummary(run)}\n${run.task}\n\n${preview}`,
							},
						],
						details: makeDetails("single")([]),
					};
				}

				if (run.status === "running") {
					return {
						content: [
							{ type: "text", text: `Subagent run #${run.id} is still running. detail is available after completion.` },
						],
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
				const aborting: number[] = [];
				const notRunning: number[] = [];
				const unknown: number[] = [];

				for (const runId of targetRunIds) {
					const run = store.commandRuns.get(runId);
					if (!run) {
						unknown.push(runId);
						continue;
					}

					const abortCtrl = run.abortController ?? store.globalLiveRuns.get(run.id)?.abortController;
					if (run.status !== "running" || !abortCtrl) {
						notRunning.push(runId);
						continue;
					}

					run.lastLine = "Aborting by subagent tool...";
					run.lastOutput = run.lastLine;
					abortCtrl.abort();
					aborting.push(runId);
				}

				if (aborting.length > 0) {
					updateCommandRunsWidget(store, ctx);
				}

				if (targetRunIds.length === 1 && aborting.length === 1 && notRunning.length === 0 && unknown.length === 0) {
					return {
						content: [{ type: "text", text: `Aborting subagent run #${aborting[0]}...` }],
						details: makeDetails("single")([]),
					};
				}

				const lines: string[] = [];
				if (aborting.length > 0) lines.push(`Aborting: ${aborting.map((id) => `#${id}`).join(", ")}.`);
				if (notRunning.length > 0) lines.push(`Not running: ${notRunning.map((id) => `#${id}`).join(", ")}.`);
				if (unknown.length > 0) lines.push(`Unknown: ${unknown.map((id) => `#${id}`).join(", ")}.`);
				if (lines.length === 0) lines.push("No subagent runs matched.");

				return {
					content: [{ type: "text", text: lines.join("\n") }],
					details: makeDetails("single")([]),
				};
			}

			if (asyncAction === "remove") {
				const removed: number[] = [];
				const abortedWhileRemoving: number[] = [];
				const unknown: number[] = [];

				for (const runId of targetRunIds) {
					const run = store.commandRuns.get(runId);
					if (!run) {
						unknown.push(runId);
						continue;
					}

					const { removed: didRemove, aborted } = removeRun(store, run.id, {
						ctx,
						pi,
						reason: "Aborting by subagent tool remove...",
						removalReason: "tool-remove",
						updateWidget: false,
					});
					if (!didRemove) {
						unknown.push(runId);
						continue;
					}

					removed.push(runId);
					if (aborted) abortedWhileRemoving.push(runId);
				}

				if (removed.length > 0) {
					updateCommandRunsWidget(store, ctx);
				}

				if (targetRunIds.length === 1 && removed.length === 1 && unknown.length === 0) {
					return {
						content: [
							{
								type: "text",
								text:
									abortedWhileRemoving.length > 0
										? `Removed subagent run #${removed[0]} (aborting in background).`
										: `Removed subagent run #${removed[0]}.`,
							},
						],
						details: makeDetails("single")([]),
					};
				}

				const lines: string[] = [];
				if (removed.length > 0) lines.push(`Removed: ${removed.map((id) => `#${id}`).join(", ")}.`);
				if (abortedWhileRemoving.length > 0)
					lines.push(`Aborting in background: ${abortedWhileRemoving.map((id) => `#${id}`).join(", ")}.`);
				if (unknown.length > 0) lines.push(`Unknown: ${unknown.map((id) => `#${id}`).join(", ")}.`);
				if (lines.length === 0) lines.push("No subagent runs matched.");

				return {
					content: [{ type: "text", text: lines.join("\n") }],
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
			if (hasChain) {
				return {
					content: [
						{ type: "text", text: withIdleRunWarning("runAsync currently supports single or parallel mode. chain is not supported.") },
					],
					details: makeDetails("single")([]),
					isError: true,
				};
			}

			if (!hasSingle && !hasTasks) {
				return {
					content: [{ type: "text", text: withIdleRunWarning("runAsync requires single(agent+task) or tasks(parallel) mode.") }],
					details: makeDetails("single")([]),
					isError: true,
				};
			}

			if (hasSingle && !params.task) {
				return {
					content: [{ type: "text", text: withIdleRunWarning("single async run requires task.") }],
					details: makeDetails("single")([]),
					isError: true,
				};
			}

			if (runCounts.running >= MAX_CONCURRENT_ASYNC_SUBAGENT_RUNS) {
				return {
					content: [
						{
							type: "text",
							text: withIdleRunWarning(
								`Too many running subagent runs (${runCounts.running}). Max is ${MAX_CONCURRENT_ASYNC_SUBAGENT_RUNS}. ` +
									`Wait for completion, abort unnecessary runs, or remove stale runs before starting a new one.`,
							),
						},
					],
					details: makeDetails("single")([]),
					isError: true,
				};
			}

			if (hasTasks) {
				const parallelTasks = params.tasks as TaskItemFields[];
				if (parallelTasks.length > MAX_PARALLEL_TASKS) {
					return {
						content: [
							{
								type: "text",
								text: withIdleRunWarning(
									`Too many parallel tasks (${parallelTasks.length}). Max is ${MAX_PARALLEL_TASKS}.`,
								),
							},
						],
						details: makeDetails("parallel")([]),
						isError: true,
					};
				}
				if (params.continueRunId !== undefined) {
					return {
						content: [
							{ type: "text", text: withIdleRunWarning("continueRunId is supported only for single async runs.") },
						],
						details: makeDetails("parallel")([]),
						isError: true,
					};
				}

				const runId = store.nextCommandRunId++;
				const taskForDisplay = buildParallelRunTaskPreview(parallelTasks);
				const runState: CommandRunState = {
					id: runId,
					agent: "parallel",
					task: taskForDisplay,
					status: "running",
					startedAt: Date.now(),
					lastActivityAt: Date.now(),
					elapsedMs: 0,
					toolCalls: 0,
					lastLine: "Parallel run started",
					lastOutput: "Parallel run started",
					turnCount: DEFAULT_TURN_COUNT,
					removed: false,
					contextMode: inheritMainContext ? "main" : "sub",
				};
				store.commandRuns.set(runId, runState);

				const abortController = new AbortController();
				runState.abortController = abortController;

				let originSessionFile = "";
				try {
					const raw = ctx.sessionManager.getSessionFile() ?? "";
					originSessionFile = raw.replace(/[\r\n\t]+/g, "").trim();
				} catch {
					/* ignore */
				}
				store.globalLiveRuns.set(runId, {
					runState,
					abortController,
					originSessionFile,
				});

				store.commandWidgetCtx = ctx;
				updateCommandRunsWidget(store, ctx);

				const contextLabel = runState.contextMode === "main" ? "main context" : "dedicated sub-session";
				pi.sendMessage(
					{
						customType: "subagent-tool",
						content:
							`[subagent:parallel#${runId}] started` +
							`\nContext: ${contextLabel} · tasks ${parallelTasks.length}` +
							``,
						display: false,
						details: {
							runId,
							agent: "parallel",
							task: taskForDisplay,
							turnCount: runState.turnCount,
							contextMode: runState.contextMode,
							status: "started",
							thoughtText: runState.thoughtText,
						},
					},
					{ deliverAs: "followUp", triggerTurn: false },
				);

				if (ctx.hasUI) {
					ctx.ui.notify(
						`Started async parallel subagent run #${runId} (${parallelTasks.length} tasks) (${contextLabel}).`,
						"info",
					);
				}

				void (async () => {
					const allResults: SingleResult[] = parallelTasks.map((task) => ({
						agent: task.agent,
						agentSource: "unknown",
						task: task.task,
						exitCode: PLACEHOLDER_RUNNING_EXIT_CODE,
						messages: [],
						stderr: "",
						usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
					}));

					const emitParallelProgress = () => {
						if (runState.removed) return;
						updateParallelRunProgress(runState, allResults, parallelTasks.length);
						updateCommandRunsWidget(store);
					};

					try {
						const results = await mapWithConcurrencyLimit(parallelTasks, MAX_CONCURRENCY, async (task, index) => {
							if (abortController.signal.aborted) throw new Error("Subagent was aborted");

							const result = await runSingleAgent(
								ctx.cwd,
								agents,
								task.agent,
								wrapTaskWithMainContext(task.task, mainContextText),
								task.cwd,
								undefined,
								abortController.signal,
								(partial) => {
									if (runState.removed) return;
									const current = partial.details?.results?.[0];
									if (!current) return;
									allResults[index] = current;
									emitParallelProgress();
								},
								makeDetails("parallel"),
								undefined,
							);

							allResults[index] = result;
							emitParallelProgress();
							return result;
						});

						if (runState.removed) return;

						const { successCount, failureCount, output } = buildParallelOutputSummary(parallelTasks, results);
						const usageTotal = aggregateUsage(results);
						runState.status = failureCount > 0 ? "error" : "done";
						runState.elapsedMs = Date.now() - runState.startedAt;
						runState.toolCalls = results.reduce(
							(count, result) => count + Math.max(result.liveToolCalls ?? 0, collectToolCallCount(result.messages)),
							0,
						);
						runState.usage = usageTotal;
						runState.turnCount = Math.max(
							DEFAULT_TURN_COUNT,
							results.reduce((maxTurns, result) => Math.max(maxTurns, result.usage?.turns ?? 0), 0),
						);
						runState.lastOutput = output;
						runState.lastLine = getLastNonEmptyLine(output);
						runState.lastActivityAt = Date.now();
						updateCommandRunsWidget(store);

						const usage = formatUsageStats(usageTotal);
						const completionMessage = {
							customType: "subagent-tool" as const,
							content:
								`[subagent:parallel#${runId}] ${failureCount > 0 ? "failed" : "completed"}` +
								`\nPrompt: ${truncateLines(taskForDisplay, 2)}` +
								`\nTasks: ${parallelTasks.length} (${successCount} succeeded${
									failureCount > 0 ? `, ${failureCount} failed` : ""
								})` +
								(usage ? `\nUsage: ${usage}` : "") +
								(runState.thoughtText ? `\nThought: ${runState.thoughtText}` : "") +
								`\n\n${output}`,
							display: true,
							details: {
								runId,
								agent: "parallel",
								task: taskForDisplay,
								turnCount: runState.turnCount,
								contextMode: runState.contextMode,
								exitCode: failureCount > 0 ? 1 : 0,
								usage: usageTotal,
								thoughtText: runState.thoughtText,
								status: runState.status,
							},
						};
						const completionOptions = { deliverAs: "followUp" as const, triggerTurn: true };

						const toolGlobalEntry = store.globalLiveRuns.get(runId);
						let toolCurrentSession: string | null = null;
						try {
							const rawSession = ctx.sessionManager.getSessionFile() ?? null;
							toolCurrentSession = rawSession ? rawSession.replace(/[\r\n\t]+/g, "").trim() : null;
						} catch {
							/* ignore */
						}

						const toolInOrigin =
							!toolGlobalEntry ||
							!toolCurrentSession ||
							!toolGlobalEntry.originSessionFile ||
							toolCurrentSession === toolGlobalEntry.originSessionFile;

						if (toolInOrigin) {
							pi.sendMessage(completionMessage, completionOptions);
							store.globalLiveRuns.delete(runId);
						} else {
							toolGlobalEntry.pendingCompletion = {
								message: completionMessage,
								options: completionOptions,
							};
							store.commandRuns.set(runId, runState);
						}

						if (ctx.hasUI) {
							ctx.ui.notify(
								runState.status === "error"
									? `subagent tool parallel run #${runId} failed (${failureCount}/${parallelTasks.length})`
									: `subagent tool parallel run #${runId} completed (${successCount}/${parallelTasks.length})`,
								runState.status === "error" ? "error" : "info",
							);
						}
					} catch (error: any) {
						if (runState.removed) return;
						runState.status = "error";
						runState.elapsedMs = Date.now() - runState.startedAt;
						runState.lastLine = error?.message ? String(error.message) : "Parallel subagent execution failed";
						runState.lastOutput = runState.lastLine;
						runState.lastActivityAt = Date.now();

						const errorMessage = {
							customType: "subagent-tool" as const,
							content:
								`[subagent:parallel#${runId}] failed` +
								`\nPrompt: ${truncateLines(taskForDisplay, 2)}` +
								`\n\n${runState.lastLine}`,
							display: true,
							details: {
								runId,
								agent: "parallel",
								task: taskForDisplay,
								turnCount: runState.turnCount,
								contextMode: runState.contextMode,
								error: runState.lastLine,
								thoughtText: runState.thoughtText,
								status: runState.status,
							},
						};

						const errGlobalEntry = store.globalLiveRuns.get(runId);
						let errCurrentSession: string | null = null;
						try {
							const rawErrSession = ctx.sessionManager.getSessionFile() ?? null;
							errCurrentSession = rawErrSession ? rawErrSession.replace(/[\r\n\t]+/g, "").trim() : null;
						} catch {
							/* ignore */
						}

						const errInOrigin =
							!errGlobalEntry ||
							!errCurrentSession ||
							!errGlobalEntry.originSessionFile ||
							errCurrentSession === errGlobalEntry.originSessionFile;

						if (errInOrigin) {
							pi.sendMessage(errorMessage, { deliverAs: "followUp", triggerTurn: true });
							store.globalLiveRuns.delete(runId);
						} else {
							errGlobalEntry.pendingCompletion = {
								message: errorMessage,
								options: { deliverAs: "followUp", triggerTurn: true },
							};
							store.commandRuns.set(runId, runState);
						}

						if (ctx.hasUI) ctx.ui.notify(`subagent tool parallel run #${runId} failed: ${runState.lastLine}`, "error");
						updateCommandRunsWidget(store);
					} finally {
						runState.abortController = undefined;
						trimCommandRunHistory(store, {
							maxRuns: 10,
							ctx,
							pi,
							updateWidget: false,
							removalReason: "trim",
						});
						updateCommandRunsWidget(store);
					}
				})();

				return {
					content: [
						{
							type: "text",
							text: withIdleRunWarning(
								`Started async parallel subagent run #${runId} (${parallelTasks.length} tasks).`,
							),
						},
					],
					details: makeDetails("parallel")([]),
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
						content: [
							{
								type: "text",
								text: withIdleRunWarning(
									`Unknown subagent run #${params.continueRunId}. Use asyncAction:"list" to see available runs.`,
								),
							},
						],
						details: makeDetails("single")([]),
						isError: true,
					};
				}
				if (continueFromRun.status === "running") {
					return {
						content: [
							{
								type: "text",
								text: withIdleRunWarning(
									`Subagent #${params.continueRunId} is still running. Wait for it to finish or abort it first.`,
								),
							},
						],
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
				runState.lastActivityAt = Date.now();
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
					lastActivityAt: Date.now(),
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

			// Register in global live run registry (survives session switches).
			let originSessionFile = "";
			try {
				const raw = ctx.sessionManager.getSessionFile() ?? "";
				originSessionFile = raw.replace(/[\r\n\t]+/g, "").trim();
			} catch {
				/* ignore */
			}
			store.globalLiveRuns.set(runId, {
				runState,
				abortController,
				originSessionFile,
			});

			store.commandWidgetCtx = ctx;
			updateCommandRunsWidget(store, ctx);

			const startedState = continueFromRun ? "resumed" : "started";
			const contextLabel = runState.contextMode === "main" ? "main context" : "dedicated sub-session";

			pi.sendMessage(
				{
					customType: "subagent-tool",
					content:
						`[subagent:${resolvedAgent}#${runId}] ${startedState}` +
						`\nContext: ${contextLabel} · turn ${runState.turnCount}` +
						``,
					display: false,
					details: {
						runId,
						agent: resolvedAgent,
						task: taskForDisplay,
						continuedFromRunId: params.continueRunId,
						turnCount: runState.turnCount,
						contextMode: runState.contextMode,
						sessionFile: runState.sessionFile,
						status: startedState,
						thoughtText: runState.thoughtText,
					},
				},
				{ deliverAs: "followUp", triggerTurn: false },
			);

			if (ctx.hasUI) {
				ctx.ui.notify(
					(continueFromRun
						? `Resumed subagent #${runId}: ${resolvedAgent}`
						: `Started subagent #${runId}: ${resolvedAgent}`) + ` (${contextLabel} · turn ${runState.turnCount})`,
					"info",
				);
			}

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
					const isError = result.exitCode !== 0 || result.stopReason === "error" || result.stopReason === "aborted";
					runState.status = isError ? "error" : "done";
					runState.elapsedMs = Date.now() - runState.startedAt;
					updateCommandRunsWidget(store);

					const rawOutput = isError
						? result.errorMessage || result.stderr || getFinalOutput(result.messages) || "(no output)"
						: getFinalOutput(result.messages) || "(no output)";
					const usage = formatUsageStats(result.usage, result.model);

					runState.lastOutput = rawOutput;
					if (rawOutput) runState.lastLine = getLastNonEmptyLine(rawOutput);

					const completionMessage = {
						customType: "subagent-tool" as const,
						content:
							`[subagent:${resolvedAgent}#${runId}] ${isError ? "failed" : "completed"}` +
							`\nPrompt: ${truncateLines(taskForDisplay, 2)}` +
							(usage ? `\nUsage: ${usage}` : "") +
							(runState.thoughtText ? `\nThought: ${runState.thoughtText}` : "") +
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
							thoughtText: runState.thoughtText,
							status: runState.status,
						},
					};
					const completionOptions = { deliverAs: "followUp" as const, triggerTurn: true };

					// Check if the user is still in the origin session.
					const toolGlobalEntry = store.globalLiveRuns.get(runId);
					let toolCurrentSession: string | null = null;
					try {
						const rawSession = ctx.sessionManager.getSessionFile() ?? null;
						toolCurrentSession = rawSession ? rawSession.replace(/[\r\n\t]+/g, "").trim() : null;
					} catch {
						/* ignore */
					}

					const toolInOrigin =
						!toolGlobalEntry ||
						!toolCurrentSession ||
						!toolGlobalEntry.originSessionFile ||
						toolCurrentSession === toolGlobalEntry.originSessionFile;

					if (toolInOrigin) {
						pi.sendMessage(completionMessage, completionOptions);
						store.globalLiveRuns.delete(runId);
					} else {
						// User is in a different session — queue for later delivery.
						toolGlobalEntry.pendingCompletion = {
							message: completionMessage,
							options: completionOptions,
						};
						store.commandRuns.set(runId, runState);
					}

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

					const errorMessage = {
						customType: "subagent-tool" as const,
						content:
							`[subagent:${resolvedAgent}#${runId}] failed` +
							`\nPrompt: ${truncateLines(taskForDisplay, 2)}` +
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
							thoughtText: runState.thoughtText,
							status: runState.status,
						},
					};

					// Error path: also check origin session for deferred delivery.
					const errGlobalEntry = store.globalLiveRuns.get(runId);
					let errCurrentSession: string | null = null;
					try {
						const rawErrSession = ctx.sessionManager.getSessionFile() ?? null;
						errCurrentSession = rawErrSession ? rawErrSession.replace(/[\r\n\t]+/g, "").trim() : null;
					} catch {
						/* ignore */
					}

					const errInOrigin =
						!errGlobalEntry ||
						!errCurrentSession ||
						!errGlobalEntry.originSessionFile ||
						errCurrentSession === errGlobalEntry.originSessionFile;

					if (errInOrigin) {
						pi.sendMessage(errorMessage, { deliverAs: "followUp", triggerTurn: true });
						store.globalLiveRuns.delete(runId);
					} else {
						errGlobalEntry.pendingCompletion = {
							message: errorMessage,
							options: { deliverAs: "followUp", triggerTurn: true },
						};
						store.commandRuns.set(runId, runState);
					}

					if (ctx.hasUI) ctx.ui.notify(`subagent tool run #${runId} failed: ${runState.lastLine}`, "error");
					updateCommandRunsWidget(store);
				} finally {
					runState.abortController = undefined;
					trimCommandRunHistory(store, {
						maxRuns: 10,
						ctx,
						pi,
						updateWidget: false,
						removalReason: "trim",
					});
					updateCommandRunsWidget(store);
				}
			})();

			return {
				content: [
					{
						type: "text",
						text: withIdleRunWarning(
							continueFromRun
								? `Resumed async subagent run #${runId} (${resolvedAgent}) turn ${runState.turnCount}.`
								: `Started async subagent run #${runId} (${resolvedAgent}).`,
						),
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

				const isError = result.exitCode !== 0 || result.stopReason === "error" || result.stopReason === "aborted";
				if (isError) {
					const errorMsg = result.errorMessage || result.stderr || getFinalOutput(result.messages) || "(no output)";
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
						content: [{ type: "text", text: `Parallel: ${done}/${allResults.length} done, ${running} running...` }],
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
				const errorMsg = result.errorMessage || result.stderr || getFinalOutput(result.messages) || "(no output)";
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
