/**
 * Shared state store and state-mutation helpers for the Subagent extension.
 */

import type { Message } from "@mariozechner/pi-ai";
import { visibleWidth } from "@mariozechner/pi-tui";
import { getDisplayItems, getFinalOutput, getLastNonEmptyLine, getLatestActivityPreview } from "./runner.js";
import type { CommandRunState, GlobalRunEntry, SingleResult } from "./types.js";

export const COLLAPSED_ITEM_COUNT = 10;

export interface SubagentStore {
	commandRuns: Map<number, CommandRunState>;
	/**
	 * Global live run registry — tracks running subagent processes independently
	 * of session lifecycle. Never cleared by session switches. Entries are removed
	 * only when a run completes, is aborted, or is explicitly removed.
	 */
	globalLiveRuns: Map<number, GlobalRunEntry>;
	renderedRunWidgetIds: Set<number>;
	nextCommandRunId: number;
	commandWidgetCtx: { hasUI?: boolean; ui?: unknown } | null;
	/** Context reference for the above-editor run status widget (tool-invoked runs). */
	pixelWidgetCtx: { hasUI?: boolean; ui?: unknown } | null;
	/** @deprecated Kept for backward compat; persistent parent link now used instead. */
	sessionStack: string[];
	/** Captured switchSession from ExtensionCommandContext (for use in input handlers). */
	switchSessionFn: ((sessionPath: string) => Promise<{ cancelled: boolean }>) | null;
	/** Persistent parent session file path, restored from session entries. Null when at root. */
	currentParentSessionFile: string | null;
	/**
	 * Per-session in-memory run snapshots used as a fallback when a session switch
	 * happens before subagent status logs are fully persisted to JSONL.
	 */
	sessionRunCache: Map<string, CommandRunState[]>;
	/** Last active session file path for snapshot bookkeeping. */
	currentSessionFile: string | null;
}

export function createStore(): SubagentStore {
	return {
		commandRuns: new Map(),
		globalLiveRuns: new Map(),
		renderedRunWidgetIds: new Set(),
		nextCommandRunId: 1,
		commandWidgetCtx: null,
		pixelWidgetCtx: null,
		sessionStack: [],
		switchSessionFn: null,
		currentParentSessionFile: null,
		sessionRunCache: new Map(),
		currentSessionFile: null,
	};
}

const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

function sliceToDisplayWidth(value: string, maxWidth: number): string {
	if (maxWidth <= 0 || value.length === 0) return "";

	let result = "";
	let width = 0;

	for (const { segment } of graphemeSegmenter.segment(value)) {
		const segmentWidth = visibleWidth(segment);
		if (segmentWidth <= 0) {
			result += segment;
			continue;
		}
		if (width + segmentWidth > maxWidth) break;
		result += segment;
		width += segmentWidth;
	}

	return result;
}

export function truncateText(value: string, max: number): string {
	if (max <= 0 || value.length === 0) return "";
	if (visibleWidth(value) <= max) return value;
	if (max <= 3) return sliceToDisplayWidth(value, max);
	return `${sliceToDisplayWidth(value, max - 3)}...`;
}

export function collectToolCallCount(messages: Message[]): number {
	return getDisplayItems(messages).filter((item) => item.type === "toolCall").length;
}

export function updateRunFromResult(state: CommandRunState, result: SingleResult): void {
	const prevToolCalls = state.toolCalls;
	const prevTurnCount = state.turnCount;
	const prevLastLine = state.lastLine;

	state.elapsedMs = Date.now() - state.startedAt;
	state.toolCalls = Math.max(collectToolCallCount(result.messages), result.liveToolCalls ?? 0);
	state.usage = result.usage;
	state.model = result.model ?? state.model;
	if (result.usage?.turns != null) state.turnCount = result.usage.turns;
	if (result.thoughtText) state.thoughtText = result.thoughtText;

	const output = getFinalOutput(result.messages);
	if (output) state.lastOutput = output;

	const previewLine = getLatestActivityPreview(result.messages);
	if (previewLine) {
		state.lastLine = previewLine;
	} else if (result.liveText) {
		const liveLine = getLastNonEmptyLine(result.liveText);
		if (liveLine) {
			state.lastLine = liveLine;
		} else if (output) {
			state.lastLine = getLastNonEmptyLine(output);
		}
	} else if (output) {
		state.lastLine = getLastNonEmptyLine(output);
	}

	// Update lastActivityAt when observable state changes
	if (state.toolCalls !== prevToolCalls || state.turnCount !== prevTurnCount || state.lastLine !== prevLastLine) {
		state.lastActivityAt = Date.now();
	}
}
