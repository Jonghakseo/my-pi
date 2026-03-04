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

export interface SubagentDetails {
	mode: "single" | "chain";
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
	/** Origin of this run: "tool" = LLM called subagent tool, "command" = user slash-command / >> shorthand. */
	source?: "tool" | "command";
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

export const ChainItem = Type.Object({
	agent: Type.String({ description: "Name of the agent to invoke" }),
	task: Type.String({ description: "Task with optional {previous} placeholder for prior output" }),
});

/** TypeScript interface matching the ChainItem Typebox schema. */
export interface ChainItemFields {
	agent: string;
	task: string;
}

export const ListAgentsParams = Type.Object({});

export const SubagentParams = Type.Object({
	command: Type.String({
		description:
			"CLI-style subagent command. Always start with 'subagent help' to discover commands. Note: 'continue' reuses an existing run's session but does NOT auto-sync main context. Examples: 'subagent run planner --main --async -- <task>', 'subagent continue 22 -- 아까 진행하던거 마무리해서 커밋해줘', 'subagent runs', 'subagent status 22', 'subagent abort 22', 'subagent remove all'.",
	}),
});
