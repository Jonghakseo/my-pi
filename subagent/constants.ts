/**
 * Shared constants for the Subagent extension.
 *
 * Keep cross-file magic numbers centralized here so commands/replay
 * stay focused on behavior.
 */

// ─── Shared ────────────────────────────────────────────────────────────────

export const MS_PER_SECOND = 1_000;
export const DEFAULT_TURN_COUNT = 1;

/**
 * Special-character shortcuts for the >> prefix input.
 * `>>? task` → researcher, `>>@ task` → fast-finder, etc.
 */
export const AGENT_SYMBOL_MAP: Record<string, string> = {
	"!": "decider",
	"*": "deep-reviewer",
	"@": "fast-finder",
	"#": "framer",
	"~": "planner",
	"?": "researcher",
	"^": "verifier",
};

/** Format symbol hints for display, e.g. ">>? researcher  >>@ fast-finder ..." */
export function formatSymbolHints(): string {
	return Object.entries(AGENT_SYMBOL_MAP)
		.map(([sym, agent]) => `>>${sym} ${agent}`)
		.join("  ");
}

// ─── commands.ts ───────────────────────────────────────────────────────────

export const STATUS_OUTPUT_PREVIEW_MAX_CHARS = 2_000;
export const RUN_OUTPUT_MESSAGE_MAX_CHARS = 8_000;
export const CONTINUATION_OUTPUT_CONTEXT_MAX_CHARS = 6_000;
export const COMMAND_COMPLETION_LIMIT = 20;
export const COMMAND_TASK_PREVIEW_CHARS = 50;
export const RUN_TICK_INTERVAL_MS = 1_000;
export const PLACEHOLDER_RUNNING_EXIT_CODE = -1;
export const SUBVIEW_OVERLAY_WIDTH = "95%";
export const SUBVIEW_OVERLAY_MAX_HEIGHT = "95%";

// ─── replay.ts ─────────────────────────────────────────────────────────────

export const ELLIPSIS_RESERVED_CHARS = 3;
export const SECONDS_PER_MINUTE = 60;

export const JSON_SUMMARY_MAX_CHARS = 140;
export const TOOL_CALL_ARGS_SUMMARY_MAX_CHARS = 4_000;
export const TOOL_RESULT_DETAILS_SUMMARY_MAX_CHARS = 8_000;
export const REPLAY_CONTENT_MAX_CHARS = 50_000;

export const MIN_TERMINAL_ROWS = 20;
export const FALLBACK_TERMINAL_ROWS = 40;
export const RESERVED_LAYOUT_ROWS = 7;
export const USAGE_EXTRA_ROWS = 1;
export const MIN_BODY_ROWS = 6;
export const MIN_LIST_ROWS = 4;
export const MIN_DETAIL_BODY_ROWS = 8;
export const DETAIL_SECTION_RESERVED_ROWS = 2;
export const MAX_LIST_ROWS = 8;
export const LIST_HEIGHT_RATIO = 0.3;

export const MIN_INNER_WIDTH = 24;
export const OVERLAY_HORIZONTAL_MARGIN = 6;
export const MIN_SEPARATOR_WIDTH = 10;
export const MIN_TASK_WIDTH = 10;
export const TASK_WIDTH_PADDING = 8;
export const MIN_DETAIL_WIDTH = 8;
export const DETAIL_WIDTH_PADDING = 4;
export const DETAIL_LINE_PADDING = 2;
export const MIN_PREVIEW_WIDTH = 18;
export const PREVIEW_WIDTH_DIVISOR = 1.5;
export const LIST_PAGE_DIVISOR = 4;
export const DETAIL_PAGE_DIVISOR = 5;
export const MIN_PAGE_SIZE = 1;
