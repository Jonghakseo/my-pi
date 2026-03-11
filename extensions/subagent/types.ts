/**
 * Type definitions, interfaces, and Typebox schemas for the Subagent tool.
 */

import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import type { Message } from "@mariozechner/pi-ai";
import { Type } from "@sinclair/typebox";
import type { AgentConfig } from "./agents.js";

// ─── Interfaces ──────────────────────────────────────────────────────────────

export interface UsageStats {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	contextTokens: number;
	turns: number;
}

export interface SingleResult {
	agent: string;
	agentSource: "user" | "project" | "unknown";
	task: string;
	exitCode: number;
	messages: Message[];
	stderr: string;
	usage: UsageStats;
	model?: string;
	stopReason?: string;
	errorMessage?: string;
	step?: number;
	liveText?: string;
	liveToolCalls?: number;
	thoughtText?: string;
	sessionFile?: string;
}

export interface BatchOrChainItem {
	agent: string;
	task: string;
}

export interface SubagentDetails {
	mode: "single" | "batch" | "chain";
	inheritMainContext: boolean;
	projectAgentsDir: string | null;
	results: SingleResult[];
}

export interface CommandRunState {
	id: number;
	agent: string;
	task: string;
	status: "running" | "done" | "error";
	startedAt: number;
	elapsedMs: number;
	toolCalls: number;
	lastLine: string;
	lastOutput?: string;
	continuedFromRunId?: number;
	turnCount: number;
	sessionFile?: string;
	abortController?: AbortController;
	usage?: UsageStats;
	model?: string;
	removed?: boolean;
	contextMode?: "main" | "sub";
	thoughtText?: string;
	/** Timestamp of last detected activity (tool call / turn / liveText change). Used for hang detection. */
	lastActivityAt: number;
	/** Number of auto-retries already attempted for this run. */
	retryCount?: number;
	/** Last transient failure reason that triggered an auto-retry. */
	lastRetryReason?: string;
	/** Origin of this run: "tool" = LLM called subagent tool, "command" = user slash-command / >> shorthand. */
	source?: "tool" | "command";
	/** Optional batch group id for tool-level grouped parallel launches. */
	batchId?: string;
	/** Optional pipeline id for tool-level sequential launches. */
	pipelineId?: string;
	/** Zero-based step index inside batch/pipeline metadata. */
	pipelineStepIndex?: number;
}

export interface SessionReplayItem {
	type: "user" | "assistant" | "tool";
	title: string;
	content: string;
	timestamp: Date;
	elapsed?: string;
}

export type DisplayItem =
	| { type: "text"; text: string }
	| { type: "toolCall"; name: string; args: Record<string, unknown> };

export interface AgentAliasMatch {
	matchedAgent?: AgentConfig;
	ambiguousAgents: AgentConfig[];
}

export type OnUpdateCallback = (partial: AgentToolResult<SubagentDetails>) => void;

/**
 * Pending completion message stored when a run finishes while the user
 * is in a different session from where the run originated.
 */
export interface PendingCompletion {
	message: {
		customType: string;
		content: string;
		display: boolean;
		details: Record<string, unknown>;
	};
	options: {
		deliverAs: "followUp";
		triggerTurn?: boolean;
	};
	createdAt: number;
}

/**
 * Global live run entry — tracks a running subagent process independently
 * of the session lifecycle. Lives in a module-level Map that is never
 * cleared by session switches.
 */
export interface GlobalRunEntry {
	runState: CommandRunState;
	abortController: AbortController;
	originSessionFile: string;
	/** Set when the run completes while the user is in a different session. */
	pendingCompletion?: PendingCompletion;
}

export interface BatchGroupState {
	batchId: string;
	runIds: number[];
	completedRunIds: Set<number>;
	failedRunIds: Set<number>;
	originSessionFile: string;
	createdAt: number;
	pendingResults: Map<number, string>;
	pendingCompletion?: PendingCompletion;
}

export interface PipelineStepResult {
	runId: number;
	agent: string;
	task: string;
	output: string;
	status: "done" | "error";
}

export interface PipelineState {
	pipelineId: string;
	currentIndex: number;
	stepRunIds: number[];
	stepResults: PipelineStepResult[];
	originSessionFile: string;
	createdAt: number;
	pendingCompletion?: PendingCompletion;
}

export const ListAgentsParams = Type.Object({});

export const SubagentParams = Type.Object({
	command: Type.String({
		description:
			"CLI-style subagent command. Always start with 'subagent help' to discover commands. Supported launch forms: run, continue, batch, and chain. After any launch, stop making subagent calls and simply end your response. The subagent will message you again after completion unless the user explicitly asks for manual inspection. Do NOT poll with runs/status/detail right after launch. Tip: when a task description is long, write context to a temp file and pass the file path in the task (e.g. 'read /tmp/ctx.md and follow the instructions') — the subagent can read it. Examples: 'subagent run planner --main -- <task>', 'subagent continue 22 -- 아까 진행하던거 마무리해서 커밋해줘', 'subagent batch --main --agent worker --task \"A\" --agent reviewer --task \"B\"', 'subagent chain --main --agent worker --task \"구현\" --agent reviewer --task \"리뷰\"', 'subagent runs', 'subagent status 22', 'subagent abort 22', 'subagent remove all'.",
	}),
});
