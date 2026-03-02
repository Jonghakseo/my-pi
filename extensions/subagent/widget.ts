/**
 * Subagent run status widget — renders per-run status boxes below the editor.
 */

import { Box, Text, truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";
import { HANG_WARNING_IDLE_MS, PARENT_HINT } from "./constants.js";
import {
	AGENT_NAME_PALETTE,
	agentBgIndex,
	formatContextUsageBar,
	getContextBarColorByRemaining,
	getRemainingContextPercent,
	getUsedContextPercent,
	resolveContextWindow,
} from "./format.js";
import { updatePixelWidget } from "./pixel-widget.js";

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

	// Parent session hint — visible when inside a child session (persistent parent link exists)
	if (store.currentParentSessionFile) {
		activeCtx.ui.setWidget(
			"sub-parent",
			(_tui: any, theme: any) => {
				const box = new Box(1, 0);
				const content = new Text("", 0, 0);
				box.addChild(content);
				return {
					render(width: number): string[] {
						const innerWidth = Math.max(1, width - 2);
						content.setText(truncateToWidth(theme.fg("accent", PARENT_HINT), innerWidth));
						return box.render(width);
					},
					invalidate() {
						box.invalidate();
					},
				};
			},
			{ placement: "belowEditor" },
		);
	} else {
		activeCtx.ui.setWidget("sub-parent", undefined);
	}

	const statusPriority = (status: "running" | "done" | "error") =>
		status === "running" ? 0 : status === "done" ? 1 : 2;
	// Only show command-invoked runs in the belowEditor widget.
	// Tool-invoked runs (source === "tool") are shown in the pixel widget above the editor.
	const runs = Array.from(store.commandRuns.values())
		.filter((r) => r.source !== "tool")
		.sort((a, b) => {
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
		// Still need to refresh the pixel widget for tool-invoked runs.
		updatePixelWidget(store, ctx);
		return;
	}

	activeCtx.ui.setWidget("subagent-runs", undefined);

	for (const [runIndex, run] of runs.entries()) {
		const showSeparator = runIndex > 0;
		const showBottomSeparator = runIndex === runs.length - 1;
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
						const innerWidth = Math.max(1, width - 2);
						if (showSeparator) lines.push(theme.fg("muted", "─".repeat(innerWidth)));

						const statusColor = run.status === "running" ? "warning" : run.status === "done" ? "success" : "error";
						const spinnerFrame = SPINNER_FRAMES[Math.floor(Date.now() / SPINNER_INTERVAL_MS) % SPINNER_FRAMES.length];
						const statusIcon = run.status === "running" ? spinnerFrame : run.status === "done" ? "✓" : "✗";
						const elapsedSec = Math.max(0, Math.round(run.elapsedMs / 1000));
						const contextWindow = resolveContextWindow(activeCtx, run.model);
						const usedContextPercent = getUsedContextPercent(run.usage?.contextTokens, contextWindow);
						const remainingContextPercent = getRemainingContextPercent(usedContextPercent);
						const contextBar = usedContextPercent !== undefined ? formatContextUsageBar(usedContextPercent) : undefined;
						const contextBarColor =
							remainingContextPercent !== undefined
								? getContextBarColorByRemaining(remainingContextPercent)
								: undefined;
						const contextShort = contextBar
							? contextBarColor
								? theme.fg(contextBarColor, contextBar)
								: theme.fg("dim", contextBar)
							: "";
						const turnLabel = run.turnCount > 1 ? theme.fg("dim", ` · Turn ${run.turnCount}`) : "";
						const modeLabel = run.contextMode === "main" ? theme.fg("warning", " · MainCtx") : "";

						// Idle indicator for running runs
						let idleLabel = "";
						if (run.status === "running" && run.lastActivityAt) {
							const idleMs = Date.now() - run.lastActivityAt;
							const idleSec = Math.round(idleMs / 1000);
							if (idleSec >= 5) {
								const idleColor = idleMs >= HANG_WARNING_IDLE_MS ? "error" : "dim";
								idleLabel = theme.fg(idleColor, ` idle:${idleSec}s`);
							}
						}

						const statusLeft =
							theme.fg(statusColor, `${statusIcon} #${run.id}`) +
							modeLabel +
							`\x1b[38;5;${AGENT_NAME_PALETTE[agentBgIndex(run.agent)]}m ${run.agent}\x1b[39m` +
							theme.fg("dim", `  (${elapsedSec}s)`) +
							turnLabel +
							idleLabel;

						if (contextShort) {
							const contextWidth = visibleWidth(contextShort);
							if (contextWidth >= innerWidth) {
								lines.push(truncateToWidth(contextShort, innerWidth));
							} else {
								const maxLeftWidth = Math.max(1, innerWidth - contextWidth - 1);
								const fittedLeft = truncateToWidth(statusLeft, maxLeftWidth);
								const gapWidth = Math.max(1, innerWidth - visibleWidth(fittedLeft) - contextWidth);
								lines.push(`${fittedLeft}${" ".repeat(gapWidth)}${contextShort}`);
							}
						} else {
							lines.push(truncateToWidth(statusLeft, innerWidth));
						}

						const normalizedTask = run.task
							.replace(/\s*\n+\s*/g, " ")
							.replace(/\s{2,}/g, " ")
							.trim();
						const taskLine = truncateText(normalizedTask, Math.max(1, innerWidth - 4));
						lines.push(theme.fg("dim", `  ${taskLine}`));

						if (run.thoughtText) {
							const thoughtLine = truncateText(run.thoughtText, Math.max(1, innerWidth - 4));
							lines.push(theme.fg("accent", `  💭 ${thoughtLine}`));
						}

						if (!run.thoughtText && run.status !== "done" && run.lastLine) {
							const normalized = run.lastLine
								.replace(/\s*\n+\s*/g, " ")
								.replace(/\s{2,}/g, " ")
								.trim();
							const outputLine = truncateText(normalized, Math.max(1, innerWidth - 4));
							lines.push(theme.fg("muted", `  ↳ ${outputLine}`));
						}

						if (showBottomSeparator) lines.push(theme.fg("muted", "─".repeat(innerWidth)));

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

	// Also refresh the pixel widget (above-editor) for tool-invoked runs.
	updatePixelWidget(store, ctx);
}
