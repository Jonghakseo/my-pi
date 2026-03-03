/**
 * Blueprint Execution Engine
 *
 * Implements the "master loop" pattern with sync/async hybrid:
 * 1. run_next identifies runnable nodes (all dependencies completed)
 * 2. Low-difficulty nodes execute synchronously (returned in same tool call)
 * 3. Medium/high-difficulty nodes launch as async subagents
 * 4. On async completion, updates Blueprint state and notifies master via sendMessage
 * 5. Master calls run_next again → repeat until all nodes done
 *
 * Key features:
 * - Single intent tracking: mode "run" runs are tracked for status queries
 * - Abort suppression: aborted Blueprint nodes don't wake the master
 * - Sync/async hybrid: low difficulty = sync, medium/high = async
 *
 * Each node execution reuses the existing subagent infrastructure
 * (runSingleAgent, discoverAgents, session files) for full compatibility.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import type { AgentConfig } from "../subagent/agents.js";
import { discoverAgents } from "../subagent/agents.js";
import { getFinalOutput, runSingleAgent } from "../subagent/runner.js";
import { buildMainContextText, makeSubagentSessionFile, wrapTaskWithMainContext } from "../subagent/session.js";
import {
	formatBlueprintProgress,
	formatBlueprintSummary,
	getRunnableNodes,
	loadBlueprint,
	loadNodeResult,
	saveBlueprint,
	saveNodeResult,
	updateNodeStatus,
} from "./blueprint.js";
import { resolveAgent } from "./mapping.js";
import type { Blueprint, BlueprintNode, SingleIntentRun } from "./types.js";
import { renderBlueprintDAGText } from "./viewer.js";
import {
	initWidgetCtx,
	trackBlueprintActive,
	trackBlueprintNodeChanged,
	trackSingleEnd,
	trackSingleStart,
} from "./widget.js";

// ─── Constants ───────────────────────────────────────────────────────────────

/** Max parallel node executions per run_next call */
const MAX_PARALLEL_NODES = 5;

/** Max sync (low-difficulty) nodes to chain in a single run_next call */
const MAX_SYNC_CHAIN = 10;

/** Truncation limit for node result text stored in Blueprint */
const NODE_RESULT_MAX_CHARS = 4000;

/** Stagger delay between parallel async node launches to avoid lock file contention (ms) */
const PARALLEL_LAUNCH_STAGGER_MS = 300;

// ─── Utilities ───────────────────────────────────────────────────────────────

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Intent defaults to isolated context injection.
 * - isolated(false): do NOT inject main session summary/log path into subagent task.
 * - main(true): inject main session summary/log path (legacy behavior).
 */
const INTENT_INHERIT_MAIN_CONTEXT = false;

function buildIntentMainContext(ctx: any): {
	mainContextText: string;
	totalMessageCount: number;
	mainSessionFile?: string;
} {
	if (!INTENT_INHERIT_MAIN_CONTEXT) {
		return {
			mainContextText: "",
			totalMessageCount: 0,
			mainSessionFile: undefined,
		};
	}

	const { text: mainContextText, totalMessageCount } = buildMainContextText(ctx);

	let mainSessionFile: string | undefined;
	try {
		const raw = ctx.sessionManager.getSessionFile() ?? "";
		mainSessionFile = raw.replace(/[\r\n\t]+/g, "").trim() || undefined;
	} catch {
		/* ignore */
	}

	return { mainContextText, totalMessageCount, mainSessionFile };
}

// ─── Active Run Tracking ─────────────────────────────────────────────────────

/** Track abort controllers for active Blueprint node runs */
const activeNodeRuns = new Map<string, AbortController>();

function makeNodeRunKey(blueprintId: string, nodeId: string): string {
	return `${blueprintId}:${nodeId}`;
}

export function abortAllBlueprintRuns(blueprintId: string): number {
	let aborted = 0;
	for (const [key, controller] of activeNodeRuns) {
		if (key.startsWith(`${blueprintId}:`)) {
			controller.abort();
			activeNodeRuns.delete(key);
			aborted++;
		}
	}
	return aborted;
}

// ─── Single Intent Run Tracking ──────────────────────────────────────────────

const SINGLE_RUNS_YAML = path.join(os.homedir(), ".pi", "blueprints", "single-runs.yaml");
const SINGLE_RUNS_JSON = path.join(os.homedir(), ".pi", "blueprints", "single-runs.json");

/** Load persisted runs from disk (called once on module init) */
function loadPersistedRuns(): Map<string, SingleIntentRun> {
	try {
		// Try YAML first
		if (fs.existsSync(SINGLE_RUNS_YAML)) {
			const raw = fs.readFileSync(SINGLE_RUNS_YAML, "utf-8");
			const arr: SingleIntentRun[] = parseYaml(raw);
			return applyRunFiltering(arr);
		}

		// Fallback to JSON for migration
		if (fs.existsSync(SINGLE_RUNS_JSON)) {
			const raw = fs.readFileSync(SINGLE_RUNS_JSON, "utf-8");
			const arr: SingleIntentRun[] = JSON.parse(raw);
			const result = applyRunFiltering(arr);
			// Migrate to YAML and delete JSON
			persistRuns(result);
			try {
				fs.unlinkSync(SINGLE_RUNS_JSON);
			} catch {
				/* ignore deletion error */
			}
			return result;
		}

		return new Map();
	} catch {
		return new Map();
	}
}

/** Filter and mark stale runs */
function applyRunFiltering(arr: SingleIntentRun[]): Map<string, SingleIntentRun> {
	// Trim old runs: keep last 200, mark stale "running" as failed
	const now = Date.now();
	const trimmed = arr.slice(-200);
	for (const r of trimmed) {
		if (r.status === "running") {
			const age = now - new Date(r.startedAt).getTime();
			if (age > 30 * 60 * 1000) {
				// >30 min old "running" → stale
				r.status = "failed";
				r.error = "Stale (pi restarted)";
			}
		}
	}
	return new Map(trimmed.map((r) => [r.id, r]));
}

/** Persist in-memory runs to disk (debounced via immediate write) */
function persistRuns(runsMap?: Map<string, SingleIntentRun>): void {
	try {
		const dir = path.dirname(SINGLE_RUNS_YAML);
		if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
		// Keep last 200 runs
		const arr = Array.from((runsMap ?? singleIntentRuns).values()).slice(-200);
		fs.writeFileSync(SINGLE_RUNS_YAML, stringifyYaml(arr), "utf-8");
	} catch (err) {
		console.warn("[intent] Failed to persist single-runs:", err);
	}
}

/** In-memory tracking of single intent runs — initialized from disk */
const singleIntentRuns: Map<string, SingleIntentRun> = loadPersistedRuns();
let singleRunCounter = 0;

function generateSingleRunId(): string {
	return `intent-${Date.now()}-${++singleRunCounter}`;
}

function trackSingleRunStart(purpose: string, difficulty: string, task: string, agent: string): string {
	const id = generateSingleRunId();
	singleIntentRuns.set(id, {
		id,
		purpose,
		difficulty,
		task: task.length > 200 ? `${task.slice(0, 200)}...` : task,
		agent,
		status: "running",
		startedAt: new Date().toISOString(),
	});
	persistRuns();
	return id;
}

function trackSingleRunEnd(runId: string, success: boolean, result?: string, error?: string): void {
	const run = singleIntentRuns.get(runId);
	if (!run) return;
	run.status = success ? "completed" : "failed";
	run.completedAt = new Date().toISOString();
	if (result) run.result = result.length > 500 ? `${result.slice(0, 500)}...` : result;
	if (error) run.error = error.length > 500 ? `${error.slice(0, 500)}...` : error;
	persistRuns();
}

/** List all tracked single intent runs (for status queries). */
export function listSingleRuns(): SingleIntentRun[] {
	return Array.from(singleIntentRuns.values()).sort((a, b) => b.startedAt.localeCompare(a.startedAt));
}

/**
 * Cancel a single intent run by ID.
 * Returns true if the run was found and cancelled, false otherwise.
 */
export function cancelSingleRun(runId: string): boolean {
	const run = singleIntentRuns.get(runId);
	if (!run) return false;
	if (run.status !== "running") return false;
	run.abort?.();
	run.status = "failed";
	run.error = "User cancelled";
	run.completedAt = new Date().toISOString();
	// Keep run in registry (no auto-cleanup) so /sub:history can display it.
	return true;
}

/** Count how many intents with the same purpose are currently running. */
function countRunningByPurpose(purpose: string): number {
	let count = 0;
	for (const run of singleIntentRuns.values()) {
		if (run.status === "running" && run.purpose === purpose) count++;
	}
	return count;
}

// ─── Shared Helpers ──────────────────────────────────────────────────────────

/** Build the full task text for a Blueprint node, injecting chain context if applicable. */
function buildNodeTask(node: BlueprintNode, bp: Blueprint): string {
	let nodeContext = node.context || "";
	if (node.chainFrom) {
		const fromNode = bp.nodes.find((n) => n.id === node.chainFrom);
		let chainResult: string | null = null;
		if (fromNode?.resultPath) chainResult = loadNodeResult(fromNode.resultPath);
		if (!chainResult && fromNode?.result) chainResult = fromNode.result;
		if (chainResult) {
			nodeContext = `[Result from ${node.chainFrom}]:\n${chainResult}\n\n${nodeContext}`.trim();
		}
	}
	return nodeContext ? `${node.task}\n\n## Context\n${nodeContext}` : node.task;
}

// ─── Auto-Advance Context & Logic ────────────────────────────────────────────

/**
 * Shared context for auto-advance: captured once at runNext time,
 * reused across the recursive auto-advance chain.
 */
interface AutoAdvanceContext {
	pi: ExtensionAPI;
	blueprintId: string;
	agents: AgentConfig[];
	mainContextText: string;
	mainSessionFile: string | undefined;
	totalMessageCount: number;
	ctx: any;
}

/**
 * Handle node completion with auto-advance logic.
 *
 * Decision tree:
 * 1. Blueprint aborted → silently return
 * 2. Blueprint completed → wake master (triggerTurn: true)
 * 3. Blueprint failed → wake master (triggerTurn: true)
 * 4. Node failed → wake master for decision (triggerTurn: true)
 * 5. Node succeeded, runnable nodes exist → auto-advance (triggerTurn: false)
 * 6. No runnable nodes, other running → silent wait
 *
 * Auto-advance chains: completed async nodes trigger this function,
 * which may launch new sync/async nodes. Those async nodes will
 * again call handleNodeCompletion on completion, forming a recursive
 * event-loop-based chain (not stack-based — no overflow risk).
 */
async function handleNodeCompletion(
	advCtx: AutoAdvanceContext,
	completedNodeId: string,
	isError: boolean,
): Promise<void> {
	const { pi, blueprintId, agents, mainContextText, mainSessionFile, totalMessageCount, ctx } = advCtx;

	const bp = loadBlueprint(blueprintId);
	if (!bp || bp.status === "aborted") return;

	// Blueprint fully completed → wake master
	if (bp.status === "completed") {
		pi.sendMessage(
			{
				customType: "intent-blueprint",
				content: `[Intent Blueprint 완료]\n${formatBlueprintProgress(bp)}`,
				display: true,
				details: { blueprintId, blueprintStatus: "completed" },
			},
			{ deliverAs: "followUp", triggerTurn: true },
		);
		return;
	}

	// Blueprint failed (all failed, no running) → wake master
	if (bp.status === "failed") {
		pi.sendMessage(
			{
				customType: "intent-blueprint",
				content: `[Intent Blueprint 실패]\n${formatBlueprintProgress(bp)}`,
				display: true,
				details: { blueprintId, blueprintStatus: "failed" },
			},
			{ deliverAs: "followUp", triggerTurn: true },
		);
		return;
	}

	// Node failed → wake master for decision (retry/skip/abort)
	if (isError) {
		const failedNode = bp.nodes.find((n) => n.id === completedNodeId);
		const errorMsg = failedNode?.error || "Unknown error";
		pi.sendMessage(
			{
				customType: "intent-blueprint",
				content:
					`[Intent Blueprint 노드 실패]\n` +
					`노드 "${completedNodeId}" 실패: ${errorMsg.slice(0, 200)}\n\n` +
					`${formatBlueprintProgress(bp)}\n\n` +
					`수동 개입이 필요합니다. Blueprint를 abort하거나 재시도하세요.`,
				display: true,
				details: { blueprintId, nodeId: completedNodeId, blueprintStatus: bp.status },
			},
			{ deliverAs: "followUp", triggerTurn: true },
		);
		return;
	}

	// ── Node succeeded, Blueprint not done → Auto-advance ──

	// Phase 1: Chain sync (low-difficulty) nodes
	let syncExecuted = 0;
	let currentBp = bp;
	let syncFailed = false;

	while (syncExecuted < MAX_SYNC_CHAIN) {
		const runnable = getRunnableNodes(currentBp);
		const syncNodes = runnable.filter((n) => n.difficulty === "low");
		if (syncNodes.length === 0) break;

		for (const sNode of syncNodes.slice(0, MAX_PARALLEL_NODES)) {
			if (syncExecuted >= MAX_SYNC_CHAIN) break;

			const agentName = resolveAgent(sNode.purpose, sNode.difficulty);
			const fullTask = buildNodeTask(sNode, currentBp);

			const result = await executeSyncNode(
				blueprintId,
				sNode,
				agentName,
				fullTask,
				agents,
				mainContextText,
				mainSessionFile,
				totalMessageCount,
				ctx,
			);

			syncExecuted++;
			if (!result.success) {
				syncFailed = true;
				break;
			}
		}

		if (syncFailed) break;
		currentBp = loadBlueprint(blueprintId)!;
		if (
			!currentBp ||
			currentBp.status === "completed" ||
			currentBp.status === "aborted" ||
			currentBp.status === "failed"
		)
			break;
	}

	// Re-check Blueprint status after sync phase
	currentBp = loadBlueprint(blueprintId)!;
	if (!currentBp || currentBp.status === "aborted") return;

	if (currentBp.status === "completed") {
		pi.sendMessage(
			{
				customType: "intent-blueprint",
				content: `[Intent Blueprint 완료]\n${formatBlueprintProgress(currentBp)}`,
				display: true,
				details: { blueprintId, blueprintStatus: "completed" },
			},
			{ deliverAs: "followUp", triggerTurn: true },
		);
		return;
	}

	if (currentBp.status === "failed" || syncFailed) {
		pi.sendMessage(
			{
				customType: "intent-blueprint",
				content: `[Intent Blueprint 노드 실패]\n${formatBlueprintProgress(currentBp)}\n\n수동 개입이 필요합니다.`,
				display: true,
				details: { blueprintId, blueprintStatus: currentBp.status },
			},
			{ deliverAs: "followUp", triggerTurn: true },
		);
		return;
	}

	// Phase 2: Launch async (medium/high-difficulty) nodes
	const runnable = getRunnableNodes(currentBp);
	const asyncNodes = runnable.filter((n) => n.difficulty !== "low").slice(0, MAX_PARALLEL_NODES);
	const launchedIds: string[] = [];

	for (let i = 0; i < asyncNodes.length; i++) {
		// Stagger parallel launches to avoid lock file contention
		if (i > 0) await sleep(PARALLEL_LAUNCH_STAGGER_MS);

		// Re-validate: blueprint may have been aborted or node already started by another completion handler
		const freshBp = loadBlueprint(blueprintId);
		if (!freshBp || freshBp.status === "aborted") break;
		const freshNode = freshBp.nodes.find((n) => n.id === asyncNodes[i].id);
		if (!freshNode || freshNode.status !== "pending") continue;

		const aNode = asyncNodes[i];
		const agentName = resolveAgent(aNode.purpose, aNode.difficulty);
		const fullTask = buildNodeTask(aNode, currentBp);

		updateNodeStatus(blueprintId, aNode.id, {
			status: "running",
			agent: agentName,
			startedAt: new Date().toISOString(),
		});

		const abortController = new AbortController();
		const runKey = makeNodeRunKey(blueprintId, aNode.id);
		activeNodeRuns.set(runKey, abortController);

		const sessionFile = makeSubagentSessionFile(Date.now());

		void executeNodeAsync(
			pi,
			blueprintId,
			aNode,
			agentName,
			fullTask,
			agents,
			mainContextText,
			mainSessionFile,
			totalMessageCount,
			sessionFile,
			abortController,
			ctx,
			advCtx,
		);

		launchedIds.push(aNode.id);
	}

	// Update widget
	if (syncExecuted > 0 || launchedIds.length > 0) {
		trackBlueprintNodeChanged(blueprintId);
	}

	// Auto-advance is silent by design.
	// Send follow-up messages only on terminal events (completion/failure).
	// (See handleNodeCompletion: completed/failed branches with triggerTurn: true.)
}

// ─── Single Intent Execution (run mode) ──────────────────────────────────────

/**
 * Execute a single intent without a Blueprint.
 *
 * Sync/async branching based on difficulty:
 * - low → synchronous: awaits completion and returns result directly
 * - medium/high → asynchronous: fires and forgets, notifies via sendMessage
 */
export async function runSingleIntent(
	pi: ExtensionAPI,
	purpose: string,
	difficulty: string,
	task: string,
	context: string | undefined,
	ctx: any,
): Promise<string> {
	const agentName = resolveAgent(purpose, difficulty);
	const discovery = discoverAgents(ctx.cwd, "user");
	const agents = discovery.agents;

	const agent = agents.find((a) => a.name === agentName);
	if (!agent) {
		return `Agent "${agentName}" not found for purpose="${purpose}" difficulty="${difficulty}". Available: ${agents.map((a) => a.name).join(", ")}`;
	}

	// ── Soft duplicate warning: warn (don't block) if 3+ same-purpose intents running ──
	const runningCount = countRunningByPurpose(purpose);
	if (runningCount >= 3) {
		void pi.sendMessage(
			{
				customType: "intent-single",
				content: `⚠️ [경고] 같은 목적의 동일한 작업을 다시 호출하지 마세요. 완료 알림을 기다려주세요. (현재 ${runningCount}개 실행 중)`,
				display: true,
			},
			{ triggerTurn: false, deliverAs: "followUp" },
		);
	}

	// Initialize widget and start tracking (both UI widget and status tracking)
	initWidgetCtx(ctx);
	const widgetRunId = trackSingleStart(purpose, difficulty, agentName, task);
	const statusRunId = trackSingleRunStart(purpose, difficulty, task, agentName);

	const fullTask = context ? `${task}\n\n## Context\n${context}` : task;

	// AbortController — created here so it can be stored in the run record before async launch
	const abortController = new AbortController();
	// Inject abort handle into the tracking record so cancelSingleRun() can reach it
	const _runRecord = singleIntentRuns.get(statusRunId);
	if (_runRecord) _runRecord.abort = () => abortController.abort();

	// Build main context for the subagent (respects INTENT_INHERIT_MAIN_CONTEXT flag)
	const { mainContextText, mainSessionFile, totalMessageCount } = buildIntentMainContext(ctx);

	const sessionFile = makeSubagentSessionFile(Date.now());
	// Store sessionFile in the tracking record so /sub:history can switch into it
	if (_runRecord) {
		_runRecord.sessionFile = sessionFile;
		persistRuns(); // persist immediately so sub:history can navigate mid-run
	}

	// Core execution closure (shared between sync and async paths)
	const executeCore = async (): Promise<{ isError: boolean; output: string }> => {
		const result = await runSingleAgent(
			ctx.cwd,
			agents,
			agentName,
			wrapTaskWithMainContext(fullTask, mainContextText, { mainSessionFile, totalMessageCount }),
			undefined, // cwd override
			undefined, // step
			abortController.signal,
			undefined, // onUpdate
			(results) => ({
				mode: "single" as const,
				agentScope: "user" as const,
				inheritMainContext: INTENT_INHERIT_MAIN_CONTEXT,
				projectAgentsDir: discovery.projectAgentsDir,
				results,
			}),
			sessionFile,
		);

		const isError = result.exitCode !== 0 || result.stopReason === "error" || result.stopReason === "aborted";
		const output = isError
			? result.errorMessage || result.stderr || getFinalOutput(result.messages) || "(no output)"
			: getFinalOutput(result.messages) || "(no output)";
		return { isError, output };
	};

	const isSync = difficulty === "low";

	if (isSync) {
		// ── Synchronous: await and return result directly ──
		try {
			const { isError, output } = await executeCore();
			trackSingleEnd(widgetRunId, !isError);
			trackSingleRunEnd(statusRunId, !isError, output);
			const statusLabel = isError ? "실패" : "완료";
			return `[Intent ${statusLabel}] ${purpose}/${difficulty} → ${agentName} (동기)\n\n${output}`;
		} catch (err: any) {
			trackSingleEnd(widgetRunId, false);
			trackSingleRunEnd(statusRunId, false, undefined, err?.message || String(err));
			return `[Intent 오류] ${purpose}/${difficulty} → ${agentName}\n\n${err?.message || String(err)}`;
		}
	} else {
		// ── Asynchronous: fire and forget, notify on completion ──
		void (async () => {
			try {
				const { isError, output } = await executeCore();
				trackSingleEnd(widgetRunId, !isError);
				trackSingleRunEnd(statusRunId, !isError, output);

				const statusLabel = isError ? "실패" : "완료";
				pi.sendMessage(
					{
						customType: "intent-single",
						content: `[Intent ${statusLabel}] ${purpose}/${difficulty} → ${agentName}\n\n${output}`,
						display: true,
						details: { purpose, difficulty, agent: agentName, isError },
					},
					{ deliverAs: "followUp", triggerTurn: true },
				);
			} catch (err: any) {
				trackSingleEnd(widgetRunId, false);
				trackSingleRunEnd(statusRunId, false, undefined, err?.message || String(err));

				pi.sendMessage(
					{
						customType: "intent-single",
						content: `[Intent 오류] ${purpose}/${difficulty} → ${agentName}\n\n${err?.message || String(err)}`,
						display: true,
						details: { purpose, difficulty, agent: agentName, isError: true },
					},
					{ deliverAs: "followUp", triggerTurn: true },
				);
			}
		})();

		return [
			`✅ Intent 비동기 실행 시작됨`,
			`- 목적: ${purpose}/${difficulty} → ${agentName}`,
			`- ID: ${statusRunId}`,
			`- 태스크: "${task.slice(0, 200)}${task.length > 200 ? "..." : ""}"`,
			`- 상태: 백그라운드 실행 중. 완료되면 자동으로 결과가 전달됩니다.`,
			`- ⚠️ 같은 목적의 동일한 작업을 다시 호출하지 마세요. 완료 알림을 기다려주세요.`,
		].join("\n");
	}
}

// ─── Blueprint Execution (run_next mode) ─────────────────────────────────────

/**
 * Execute the next runnable node(s) in a Blueprint.
 *
 * Sync/async hybrid:
 * - low-difficulty nodes execute synchronously (chained — one run_next can process multiple)
 * - medium/high-difficulty nodes launch asynchronously in parallel
 */
export async function runNext(pi: ExtensionAPI, blueprintId: string, ctx: any): Promise<string> {
	const bp = loadBlueprint(blueprintId);
	if (!bp) return `Blueprint "${blueprintId}" not found.`;
	if (bp.status === "completed")
		return `Blueprint "${bp.title}" is already completed.\n\n\`\`\`\n${renderBlueprintDAGText(bp)}\n\`\`\``;
	if (bp.status === "aborted") return `Blueprint "${bp.title}" was aborted.`;

	// Transition from confirmed → running
	if (bp.status === "pending_confirm" || bp.status === "confirmed") {
		bp.status = "running";
		saveBlueprint(bp);
	}

	// Initialize widget
	initWidgetCtx(ctx);
	trackBlueprintActive(blueprintId);

	// Discover agents and build context once for all nodes
	const discovery = discoverAgents(ctx.cwd, "user");
	const agents = discovery.agents;
	const { mainContextText, mainSessionFile, totalMessageCount } = buildIntentMainContext(ctx);

	const resultLines: string[] = [];

	// ── Phase 1: Synchronous chain (low-difficulty nodes) ──
	let syncExecuted = 0;
	let currentBp = loadBlueprint(blueprintId)!;

	while (syncExecuted < MAX_SYNC_CHAIN) {
		const runnable = getRunnableNodes(currentBp);
		const syncNodes = runnable.filter((n) => n.difficulty === "low");
		if (syncNodes.length === 0) break;

		for (const node of syncNodes.slice(0, MAX_PARALLEL_NODES)) {
			if (syncExecuted >= MAX_SYNC_CHAIN) break;

			const agentName = resolveAgent(node.purpose, node.difficulty);
			const fullTask = buildNodeTask(node, currentBp);

			const result = await executeSyncNode(
				blueprintId,
				node,
				agentName,
				fullTask,
				agents,
				mainContextText,
				mainSessionFile,
				totalMessageCount,
				ctx,
			);

			const label = result.success ? "✅" : "❌";
			resultLines.push(`${label} **${node.id}** [${node.purpose}/${node.difficulty}] → ${agentName} (동기)`);
			syncExecuted++;
		}

		// Refresh blueprint to see newly runnable nodes from sync completions
		currentBp = loadBlueprint(blueprintId)!;
		if (currentBp.status === "completed" || currentBp.status === "aborted" || currentBp.status === "failed") break;
	}

	// ── Phase 2: Async launch (medium/high-difficulty nodes) ──
	currentBp = loadBlueprint(blueprintId)!;

	// Check for completion after sync phase
	if (currentBp.status === "completed") {
		trackBlueprintNodeChanged(blueprintId);
		return syncExecuted > 0
			? `Blueprint "${currentBp.title}" complete! (${syncExecuted} node(s) executed synchronously)\n\n\`\`\`\n${renderBlueprintDAGText(currentBp)}\n\`\`\``
			: `Blueprint "${currentBp.title}" is already completed.\n\n\`\`\`\n${renderBlueprintDAGText(currentBp)}\n\`\`\``;
	}
	if (currentBp.status === "aborted") {
		return `Blueprint "${currentBp.title}" was aborted.`;
	}

	const runnable = getRunnableNodes(currentBp);
	const asyncNodes = runnable.filter((n) => n.difficulty !== "low").slice(0, MAX_PARALLEL_NODES);

	if (asyncNodes.length === 0 && resultLines.length === 0) {
		// No nodes were executed at all — check why
		const running = currentBp.nodes.filter((n) => n.status === "running");
		if (running.length > 0) {
			return `${running.length} node(s) still running. Waiting for completion...\n\n\`\`\`\n${renderBlueprintDAGText(currentBp)}\n\`\`\``;
		}

		const failed = currentBp.nodes.filter((n) => n.status === "failed");
		if (failed.length > 0) {
			return `Blueprint blocked: ${failed.map((n) => n.id).join(", ")} failed. Manual intervention needed.\n\n\`\`\`\n${renderBlueprintDAGText(currentBp)}\n\`\`\``;
		}

		// Everything done (edge case — recalculate)
		currentBp.status = "completed";
		saveBlueprint(currentBp);
		return `Blueprint "${currentBp.title}" complete!\n\n\`\`\`\n${renderBlueprintDAGText(currentBp)}\n\`\`\``;
	}

	// Build auto-advance context for async node completions
	const advCtx: AutoAdvanceContext = {
		pi,
		blueprintId,
		agents,
		mainContextText,
		mainSessionFile,
		totalMessageCount,
		ctx,
	};

	for (let i = 0; i < asyncNodes.length; i++) {
		// Stagger parallel launches to avoid lock file contention
		if (i > 0) await sleep(PARALLEL_LAUNCH_STAGGER_MS);

		// Re-validate: blueprint may have been aborted or node already running
		const freshBp2 = loadBlueprint(blueprintId);
		if (!freshBp2 || freshBp2.status === "aborted") break;
		const freshNode2 = freshBp2.nodes.find((n) => n.id === asyncNodes[i].id);
		if (!freshNode2 || freshNode2.status !== "pending") continue;

		const node = asyncNodes[i];
		const agentName = resolveAgent(node.purpose, node.difficulty);
		const fullTask = buildNodeTask(node, currentBp);

		// Mark node as running
		updateNodeStatus(blueprintId, node.id, {
			status: "running",
			agent: agentName,
			startedAt: new Date().toISOString(),
		});

		resultLines.push(`🚀 **${node.id}** [${node.purpose}/${node.difficulty}] → ${agentName} (비동기)`);

		// Launch async execution with auto-advance
		const abortController = new AbortController();
		const runKey = makeNodeRunKey(blueprintId, node.id);
		activeNodeRuns.set(runKey, abortController);

		const sessionFile = makeSubagentSessionFile(Date.now());

		void executeNodeAsync(
			pi,
			blueprintId,
			node,
			agentName,
			fullTask,
			agents,
			mainContextText,
			mainSessionFile,
			totalMessageCount,
			sessionFile,
			abortController,
			ctx,
			advCtx,
		);
	}

	// Refresh widget to show updated node states
	trackBlueprintNodeChanged(blueprintId);

	const updatedBp = loadBlueprint(blueprintId) || currentBp;
	const remaining = getRunnableNodes(updatedBp).filter(
		(n) => n.difficulty !== "low" && !asyncNodes.find((a) => a.id === n.id),
	).length;
	const remainingMsg = remaining > 0 ? `\n(${remaining} more node(s) queued, will start after current batch)` : "";

	const autoAdvanceNote =
		asyncNodes.length > 0
			? "\n\n⚡ Auto-advance 활성: 후속 노드는 자동으로 실행됩니다. Blueprint 완료/실패 알림을 기다려주세요."
			: "";
	return `${resultLines.join("\n")}${remainingMsg}\n\n\`\`\`\n${renderBlueprintDAGText(updatedBp)}\n\`\`\`${autoAdvanceNote}`;
}

// ─── Sync Node Execution (Blueprint) ─────────────────────────────────────────

/**
 * Execute a single Blueprint node synchronously (awaiting completion).
 * Used for low-difficulty nodes that should complete quickly.
 */
async function executeSyncNode(
	blueprintId: string,
	node: BlueprintNode,
	agentName: string,
	task: string,
	agents: AgentConfig[],
	mainContextText: string,
	mainSessionFile: string | undefined,
	totalMessageCount: number,
	ctx: any,
): Promise<{ success: boolean; output: string }> {
	// Mark as running
	updateNodeStatus(blueprintId, node.id, {
		status: "running",
		agent: agentName,
		startedAt: new Date().toISOString(),
	});
	trackBlueprintNodeChanged(blueprintId);

	const sessionFile = makeSubagentSessionFile(Date.now());
	const abortController = new AbortController();
	const runKey = makeNodeRunKey(blueprintId, node.id);
	activeNodeRuns.set(runKey, abortController);

	try {
		const result = await runSingleAgent(
			ctx.cwd,
			agents,
			agentName,
			wrapTaskWithMainContext(task, mainContextText, { mainSessionFile, totalMessageCount }),
			undefined, // cwd
			undefined, // step
			abortController.signal,
			undefined, // onUpdate
			(results) => ({
				mode: "single" as const,
				agentScope: "user" as const,
				inheritMainContext: INTENT_INHERIT_MAIN_CONTEXT,
				projectAgentsDir: null,
				results,
			}),
			sessionFile,
		);

		const isError = result.exitCode !== 0 || result.stopReason === "error" || result.stopReason === "aborted";
		const output = isError
			? result.errorMessage || result.stderr || getFinalOutput(result.messages) || "(no output)"
			: getFinalOutput(result.messages) || "(no output)";

		const storedResult =
			output.length > NODE_RESULT_MAX_CHARS ? `${output.slice(0, NODE_RESULT_MAX_CHARS)}\n...[truncated]` : output;

		let resultPath: string | undefined;
		if (!isError) {
			try {
				resultPath = saveNodeResult(blueprintId, node.id, output);
			} catch {
				/* File save failure should not break Blueprint execution */
			}
		}

		updateNodeStatus(blueprintId, node.id, {
			status: isError ? "failed" : "completed",
			result: storedResult,
			resultPath,
			error: isError ? output.slice(0, 500) : undefined,
			completedAt: new Date().toISOString(),
		});

		trackBlueprintNodeChanged(blueprintId);
		return { success: !isError, output: storedResult };
	} catch (err: any) {
		updateNodeStatus(blueprintId, node.id, {
			status: "failed",
			error: err?.message || String(err),
			completedAt: new Date().toISOString(),
		});
		trackBlueprintNodeChanged(blueprintId);
		return { success: false, output: err?.message || String(err) };
	} finally {
		activeNodeRuns.delete(runKey);
	}
}

// ─── Async Node Execution ────────────────────────────────────────────────────

async function executeNodeAsync(
	pi: ExtensionAPI,
	blueprintId: string,
	node: BlueprintNode,
	agentName: string,
	task: string,
	agents: AgentConfig[],
	mainContextText: string,
	mainSessionFile: string | undefined,
	totalMessageCount: number,
	sessionFile: string,
	abortController: AbortController,
	ctx: any,
	advCtx: AutoAdvanceContext,
): Promise<void> {
	const runKey = makeNodeRunKey(blueprintId, node.id);

	try {
		const result = await runSingleAgent(
			ctx.cwd,
			agents,
			agentName,
			wrapTaskWithMainContext(task, mainContextText, { mainSessionFile, totalMessageCount }),
			undefined, // cwd
			undefined, // step
			abortController.signal,
			undefined, // onUpdate
			(results) => ({
				mode: "single" as const,
				agentScope: "user" as const,
				inheritMainContext: INTENT_INHERIT_MAIN_CONTEXT,
				projectAgentsDir: null,
				results,
			}),
			sessionFile,
		);

		const isError = result.exitCode !== 0 || result.stopReason === "error" || result.stopReason === "aborted";
		const output = isError
			? result.errorMessage || result.stderr || getFinalOutput(result.messages) || "(no output)"
			: getFinalOutput(result.messages) || "(no output)";

		// Truncate result for in-memory storage
		const storedResult =
			output.length > NODE_RESULT_MAX_CHARS ? `${output.slice(0, NODE_RESULT_MAX_CHARS)}\n...[truncated]` : output;

		// Persist full result to .md file (survives compaction/session restart)
		let resultPath: string | undefined;
		if (!isError) {
			try {
				resultPath = saveNodeResult(blueprintId, node.id, output);
			} catch {
				/* File save failure should not break Blueprint execution */
			}
		}

		updateNodeStatus(blueprintId, node.id, {
			status: isError ? "failed" : "completed",
			result: storedResult,
			resultPath,
			error: isError ? output.slice(0, 500) : undefined,
			completedAt: new Date().toISOString(),
		});

		// Update widget with latest node state
		trackBlueprintNodeChanged(blueprintId);

		// Auto-advance: handle node completion and auto-launch next runnable nodes
		await handleNodeCompletion(advCtx, node.id, isError);
	} catch (err: any) {
		updateNodeStatus(blueprintId, node.id, {
			status: "failed",
			error: err?.message || String(err),
			completedAt: new Date().toISOString(),
		});

		// Update widget with failure state
		trackBlueprintNodeChanged(blueprintId);

		// Auto-advance: handle node failure and notify master
		await handleNodeCompletion(advCtx, node.id, true);
	} finally {
		activeNodeRuns.delete(runKey);
	}
}
