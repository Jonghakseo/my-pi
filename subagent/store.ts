/**
 * Shared state store and state-mutation helpers for the Subagent extension.
 */

import type { Message } from "@mariozechner/pi-ai";
import { getDisplayItems, getFinalOutput, getLastNonEmptyLine, getLatestActivityPreview } from "./runner.js";
import type { CommandRunState, SingleResult } from "./types.js";

export const MAX_PARALLEL_TASKS = 8;
export const MAX_CONCURRENCY = 4;
export const COLLAPSED_ITEM_COUNT = 10;

export interface SubagentStore {
	commandRuns: Map<number, CommandRunState>;
	renderedRunWidgetIds: Set<number>;
	nextCommandRunId: number;
	commandWidgetCtx: any;
}

export function createStore(): SubagentStore {
	return {
		commandRuns: new Map(),
		renderedRunWidgetIds: new Set(),
		nextCommandRunId: 1,
		commandWidgetCtx: null,
	};
}

export function truncateText(value: string, max: number): string {
	if (value.length <= max) return value;
	if (max <= 3) return value.slice(0, max);
	return `${value.slice(0, max - 3)}...`;
}

export function collectToolCallCount(messages: Message[]): number {
	return getDisplayItems(messages).filter((item) => item.type === "toolCall").length;
}

export function updateRunFromResult(state: CommandRunState, result: SingleResult): void {
	state.elapsedMs = Date.now() - state.startedAt;
	state.toolCalls = Math.max(collectToolCallCount(result.messages), result.liveToolCalls ?? 0);
	state.usage = result.usage;
	state.model = result.model ?? state.model;
	if (result.progressText) state.progressText = result.progressText;

	const output = getFinalOutput(result.messages);
	if (output) state.lastOutput = output;

	const previewLine = getLatestActivityPreview(result.messages);
	if (previewLine) {
		state.lastLine = previewLine;
		return;
	}

	if (result.liveText) {
		const liveLine = getLastNonEmptyLine(result.liveText);
		if (liveLine) {
			state.lastLine = liveLine;
			return;
		}
	}

	if (output) state.lastLine = getLastNonEmptyLine(output);
}
