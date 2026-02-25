/**
 * Shared utilities for formatting and managing subagent command runs.
 *
 * Extracted from commands.ts to eliminate duplicated run-summary and
 * run-history-trimming logic. Output format is intentionally kept
 * identical to the original inline implementations.
 */

import type { SubagentStore } from "./store.js";
import type { CommandRunState } from "./types.js";

/**
 * One-line summary of a command run.
 *
 * Format: `#<id> [<status>] <agent> ctx:<contextMode> turn:<turnCount> <elapsed>s tools:<toolCalls>`
 */
export function formatCommandRunSummary(run: CommandRunState): string {
	const elapsedSec = Math.max(0, Math.round(run.elapsedMs / 1000));
	return `#${run.id} [${run.status}] ${run.agent} ctx:${run.contextMode ?? "sub"} turn:${run.turnCount ?? 1} ${elapsedSec}s tools:${run.toolCalls}`;
}

/**
 * Trim completed/errored command runs so that the store never exceeds
 * `maxRuns` entries. Oldest finished runs are removed first; running
 * runs are never evicted.
 */
export function trimCommandRunHistory(store: SubagentStore, maxRuns = 10): void {
	const completed = Array.from(store.commandRuns.values())
		.filter((run) => run.status !== "running")
		.sort((a, b) => a.id - b.id);
	while (store.commandRuns.size > maxRuns && completed.length > 0) {
		const oldest = completed.shift();
		if (oldest) store.commandRuns.delete(oldest.id);
	}
}
