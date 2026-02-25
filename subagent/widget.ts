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

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const;
const SPINNER_INTERVAL_MS = 120;
const SPINNER_REFRESH_MS = 150;
import { type SubagentStore, truncateText } from "./store.js";

/** Fast timer that drives spinner animation while any run is active. */
let spinnerTimer: ReturnType<typeof setInterval> | undefined;

function manageSpinnerTimer(store: SubagentStore): void {
	const hasRunning = Array.from(store.commandRuns.values()).some((r) => r.status === "running");
	if (hasRunning && !spinnerTimer) {
		spinnerTimer = setInterval(() => updateCommandRunsWidget(store), SPINNER_REFRESH_MS);
	} else if (!hasRunning && spinnerTimer) {
		clearInterval(spinnerTimer);
		spinnerTimer = undefined;
	}
}

export function updateCommandRunsWidget(store: SubagentStore, ctx?: any): void {
	const activeCtx = ctx ?? store.commandWidgetCtx;
	if (!activeCtx || !activeCtx.hasUI) return;
	store.commandWidgetCtx = activeCtx;

	const statusPriority = (status: "running" | "done" | "error") =>
		status === "running" ? 0 : status === "error" ? 1 : 2;
	const runs = Array.from(store.commandRuns.values()).sort((a, b) => {
		const priorityDiff = statusPriority(a.status) - statusPriority(b.status);
		if (priorityDiff !== 0) return priorityDiff;
		const startedDiff = (b.startedAt ?? 0) - (a.startedAt ?? 0);
		if (startedDiff !== 0) return startedDiff;
		return b.id - a.id;
	});
	const visibleRunIds = new Set<number>(runs.map((run) => run.id));

	for (const id of Array.from(store.renderedRunWidgetIds)) {
		if (!visibleRunIds.has(id)) {
			activeCtx.ui.setWidget(`sub-${id}`, undefined);
			store.renderedRunWidgetIds.delete(id);
		}
	}

	if (runs.length === 0) {
		activeCtx.ui.setWidget("subagent-runs", undefined);
		manageSpinnerTimer(store);
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
								"Tip: /subview [id] opens output (UI-only) · /subrm [id] removes a run · /subclear all clears all",
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
						const spinnerFrame = SPINNER_FRAMES[Math.floor(Date.now() / SPINNER_INTERVAL_MS) % SPINNER_FRAMES.length];
						const statusIcon = run.status === "running" ? spinnerFrame : run.status === "done" ? "✓" : "✗";
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
							theme.fg("dim", `  (${elapsedSec}s)`) +
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

						if (run.status !== "done" && run.lastLine) {
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

	manageSpinnerTimer(store);
}
