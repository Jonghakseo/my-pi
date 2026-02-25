/**
 * Subagent run status widget — renders per-run status boxes below the editor.
 */

import { Box, Text } from "@mariozechner/pi-tui";
import {
	AGENT_NAME_PALETTE,
	agentBgIndex,
	formatContextUsageBar,
	getContextBarColorByRemaining,
	getRemainingContextPercent,
	getUsedContextPercent,
	resolveContextWindow,
} from "./format.js";
import { type SubagentStore, truncateText } from "./store.js";

export function updateCommandRunsWidget(store: SubagentStore, ctx?: any): void {
	const activeCtx = ctx ?? store.commandWidgetCtx;
	if (!activeCtx || !activeCtx.hasUI) return;
	store.commandWidgetCtx = activeCtx;

	const runs = Array.from(store.commandRuns.values()).sort((a, b) => b.id - a.id);
	const visibleRunIds = new Set<number>(runs.map((run) => run.id));

	for (const id of Array.from(store.renderedRunWidgetIds)) {
		if (!visibleRunIds.has(id)) {
			activeCtx.ui.setWidget(`sub-${id}`, undefined);
			store.renderedRunWidgetIds.delete(id);
		}
	}

	if (runs.length === 0) {
		activeCtx.ui.setWidget("subagent-runs", undefined);
		return;
	}

	activeCtx.ui.setWidget(
		"subagent-runs",
		(_tui: any, theme: any) => {
			const text = new Text("", 0, 0);
			return {
				render(width: number): string[] {
					const runningCount = runs.filter((run) => run.status === "running").length;
					const doneCount = runs.filter((run) => run.status === "done").length;
					const errorCount = runs.filter((run) => run.status === "error").length;

					const lines: string[] = [
						theme.fg("toolTitle", theme.bold("Subagents")) +
							theme.fg("dim", ` · ${runningCount} running · ${doneCount} done · ${errorCount} failed`),
						theme.fg(
							"muted",
							truncateText(
								"Tip: /subview <id> opens latest output (UI-only) · /subrm <id> removes one run · /subclear all clears all",
								Math.max(20, width),
							),
						),
					];

					text.setText(lines.join("\n"));
					return text.render(width);
				},
				invalidate() {
					text.invalidate();
				},
			};
		},
		{ placement: "belowEditor" },
	);

	for (const run of runs) {
		store.renderedRunWidgetIds.add(run.id);
		activeCtx.ui.setWidget(
			`sub-${run.id}`,
			(_tui: any, theme: any) => {
				const box = new Box(1, 0);
				const content = new Text("", 0, 0);
				box.addChild(content);

				return {
					render(width: number): string[] {
						const lines: string[] = [];
						const statusColor = run.status === "running" ? "warning" : run.status === "done" ? "success" : "error";
						const statusIcon = run.status === "running" ? "⏳" : run.status === "done" ? "✓" : "✗";
						const elapsedSec = Math.max(0, Math.round(run.elapsedMs / 1000));
						const contextWindow = resolveContextWindow(activeCtx, run.model);
						const usedContextPercent = getUsedContextPercent(run.usage?.contextTokens, contextWindow);
						const remainingContextPercent = getRemainingContextPercent(usedContextPercent);
						const contextBar = usedContextPercent !== undefined ? formatContextUsageBar(usedContextPercent) : undefined;
						const contextBarColor =
							remainingContextPercent !== undefined ? getContextBarColorByRemaining(remainingContextPercent) : undefined;
						const contextShort = contextBar
							? contextBarColor
								? theme.fg(contextBarColor, ` ${contextBar}`)
								: theme.fg("dim", ` ${contextBar}`)
							: "";
						const turnLabel = run.turnCount > 1 ? theme.fg("dim", ` · Turn ${run.turnCount}`) : "";
						const modeLabel = run.contextMode === "main" ? theme.fg("warning", " · MainCtx") : "";

						lines.push(
							theme.fg(statusColor, `${statusIcon} #${run.id}`) +
							turnLabel +
							modeLabel +
							`\x1b[38;5;${AGENT_NAME_PALETTE[agentBgIndex(run.agent)]}m ${run.agent}\x1b[39m` +
							theme.fg("dim", `  (${elapsedSec}s) | Tools: ${run.toolCalls}`) +
							contextShort,
						);

						const innerWidth = Math.max(1, width - 2);
						const normalizedTask = run.task.replace(/\s*\n+\s*/g, " ").replace(/\s{2,}/g, " ").trim();
						const taskLine = truncateText(normalizedTask, Math.max(1, innerWidth - 2));
						lines.push(theme.fg("dim", `  ${taskLine}`));

						if (run.progressText) {
							const progressLine = truncateText(run.progressText, Math.max(1, innerWidth - 4));
							lines.push(theme.fg("accent", `  ▸ ${progressLine}`));
						}

						if (run.lastLine) {
							const normalized = run.lastLine.replace(/\s*\n+\s*/g, " ").replace(/\s{2,}/g, " ").trim();
							const outputLine = truncateText(normalized, Math.max(1, innerWidth - 4));
							lines.push(theme.fg("muted", `  ↳ ${outputLine}`));
						}

						content.setText(lines.join("\n"));
						return box.render(width);
					},
					invalidate() {
						box.invalidate();
					},
				};
			},
			{ placement: "belowEditor" },
		);
	}
}
