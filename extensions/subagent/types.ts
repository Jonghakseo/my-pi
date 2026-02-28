/**
 * Type definitions, interfaces, and Typebox schemas for the Subagent tool.
 */

import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import type { Message } from "@mariozechner/pi-ai";
import { StringEnum } from "@mariozechner/pi-ai";
import { Type } from "@sinclair/typebox";
import type { AgentConfig, AgentScope } from "./agents.js";

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
}

export interface SubagentDetails {
	mode: "single" | "parallel" | "chain";
	agentScope: AgentScope;
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
	| { type: "toolCall"; name: string; args: Record<string, any> };

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

// ─── Typebox Schemas ─────────────────────────────────────────────────────────

export const TaskItem = Type.Object({
	agent: Type.String({ description: "Name of the agent to invoke" }),
	task: Type.String({ description: "Task to delegate to the agent" }),
	cwd: Type.Optional(Type.String({ description: "Working directory for the agent process" })),
});

export const ChainItem = Type.Object({
	agent: Type.String({ description: "Name of the agent to invoke" }),
	task: Type.String({ description: "Task with optional {previous} placeholder for prior output" }),
	cwd: Type.Optional(Type.String({ description: "Working directory for the agent process" })),
});

/** TypeScript interface matching the TaskItem Typebox schema. */
export interface TaskItemFields {
	agent: string;
	task: string;
	cwd?: string;
}

/** TypeScript interface matching the ChainItem Typebox schema. */
export interface ChainItemFields {
	agent: string;
	task: string;
	cwd?: string;
}

export const AgentScopeSchema = StringEnum(["user", "project", "both"] as const, {
	description:
		'Which agent directories to use. Default: "user". Use "both" to include project-local agents (.pi/agents, .claude/agents).',
	default: "user",
});

export const ContextModeSchema = StringEnum(["isolated", "main"] as const, {
	description:
		'Subagent context mode. "isolated" starts a dedicated sub-session, "main" inherits current main session context.',
	default: "isolated",
});

export const AsyncActionSchema = StringEnum(["run", "list", "status", "detail", "abort", "remove"] as const, {
	description:
		'Async control action for tool-managed jobs. "run" starts a new job; others (list/status/detail/abort/remove) are for occasional manual inspection/control only. Do NOT call subagent repeatedly for polling — completion/failure/error updates are delivered automatically as follow-up messages.',
	default: "run",
});

export const ListAgentsParams = Type.Object({
	agentScope: Type.Optional(
		StringEnum(["user", "project", "both"] as const, {
			description:
				'Which agent directories to list. Default: "both" (includes user + project-local agents when available).',
			default: "both",
		}),
	),
});

export const SubagentParams = Type.Object({
	agent: Type.Optional(Type.String({ description: "Name of the agent to invoke (for single mode)" })),
	task: Type.Optional(Type.String({ description: "Task to delegate (for single mode)" })),
	tasks: Type.Optional(Type.Array(TaskItem, { description: "Array of {agent, task} for parallel execution" })),
	chain: Type.Optional(Type.Array(ChainItem, { description: "Array of {agent, task} for sequential execution" })),
	agentScope: Type.Optional(AgentScopeSchema),
	confirmProjectAgents: Type.Optional(
		Type.Boolean({ description: "Prompt before running project-local agents. Default: true.", default: true }),
	),
	cwd: Type.Optional(Type.String({ description: "Working directory for the agent process (single mode)" })),
	contextMode: Type.Optional(ContextModeSchema),
	runAsync: Type.Optional(
		Type.Boolean({
			description:
				"If true, start the subagent in background and return immediately. Do NOT keep calling subagent to poll status — completion/failure/error results are delivered automatically as follow-up messages. Use asyncAction only for occasional manual inspection or control (e.g. abort).",
			default: true,
		}),
	),
	asyncAction: Type.Optional(AsyncActionSchema),
	runId: Type.Optional(
		Type.Number({
			description:
				"Run ID for asyncAction=status|detail|abort|remove. For abort/remove, you can use runIds instead for bulk control. Use only for occasional manual checks/control; do not repeatedly poll, because completion/failure/error updates are delivered automatically.",
		}),
	),
	runIds: Type.Optional(
		Type.Array(
			Type.Number({
				description: "Run ID to control in bulk mode.",
			}),
			{
				description:
					"Run IDs for asyncAction=abort|remove bulk control. Use either runId (single) or runIds (multiple), not both.",
				minItems: 1,
			},
		),
	),
	continueRunId: Type.Optional(
		Type.Number({
			description:
				"Run ID of an existing completed/error run to continue. Reuses the run's session file for context continuity. The original run's agent is reused if 'agent' is not specified.",
		}),
	),
});
