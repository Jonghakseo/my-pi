import type { Message } from "@earendil-works/pi-ai";

export type CompactionReason = "manual" | "threshold" | "overflow";

export interface FileOps {
	readFiles?: string[];
	modifiedFiles?: string[];
	createdFiles?: string[];
}

export type NormalizedBlock =
	| { kind: "user"; text: string; sourceIndex?: number }
	| { kind: "custom"; customType: string; text: string; sourceIndex?: number }
	| { kind: "assistant"; text: string; sourceIndex?: number }
	| {
			kind: "tool_call";
			name: string;
			args: Record<string, unknown>;
			sourceIndex?: number;
	  }
	| { kind: "tool_result"; name: string; text: string; sourceIndex?: number }
	| {
			kind: "bash";
			command: string;
			output: string;
			exitCode: number | undefined;
			sourceIndex?: number;
	  };

/**
 * Session messages that pi persists but the pi-ai `Message` union does not
 * model (pi 0.87.x). Every normalizer/render path needs these two shapes,
 * so the narrow views live here instead of `as any` casts at each site.
 */
export type BashExecutionLike = {
	role: "bashExecution";
	command?: string;
	output?: string;
	exitCode?: number;
	excludeFromContext?: boolean;
};

export const asBashExecution = (msg: unknown): BashExecutionLike | null =>
	typeof msg === "object" && msg !== null && (msg as BashExecutionLike).role === "bashExecution"
		? (msg as BashExecutionLike)
		: null;

export type ToolCallPartLike = {
	type: "toolCall";
	name?: string;
	arguments?: unknown;
};

export const isToolCallPart = (part: unknown): part is ToolCallPartLike =>
	typeof part === "object" && part !== null && (part as ToolCallPartLike).type === "toolCall";

/** Preserve persisted roles; LLM transport conversion must not classify user intent. */
export type CompactionMessage =
	| Message
	| BashExecutionLike
	| { role: "custom"; customType: string; content: Message["content"] }
	| { role: "branchSummary" | "compactionSummary"; summary: string };
