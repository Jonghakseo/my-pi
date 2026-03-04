/**
 * Above-editor widget for tool-invoked subagent runs.
 *
 * Each run is rendered in two lines (same style as below-editor widget):
 *   1) status/meta line
 *   2) thought/progress line
 */

import { Box, Text, truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";
import {
	AGENT_NAME_PALETTE,
	agentBgIndex,
	formatContextUsageBar,
	getContextBarColorByRemaining,
	getRemainingContextPercent,
	getUsedContextPercent,
	resolveContextWindow,
} from "./format.js";
import type { SubagentStore } from "./store.js";
import type { CommandRunState } from "./types.js";

const ANIM_REFRESH_MS = 150;
const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const;
const SPINNER_INTERVAL_MS = 120;

let pixelAnimTimer: ReturnType<typeof setInterval> | undefined;

function managePixelTimer(store: SubagentStore): void {
	const toolRuns = getToolRuns(store);
	const hasRunning = toolRuns.some((r) => r.status === "running");
	if (hasRunning && !pixelAnimTimer) {
		pixelAnimTimer = setInterval(() => updatePixelWidget(store), ANIM_REFRESH_MS);
	} else if (!hasRunning && pixelAnimTimer) {
		clearInterval(pixelAnimTimer);
		pixelAnimTimer = undefined;
	}
}


function getToolRuns(store: SubagentStore): CommandRunState[] {
	const statusPriority = (status: "running" | "done" | "error") =>
		status === "running" ? 0 : status === "done" ? 1 : 2;
	return Array.from(store.commandRuns.values())
		.filter((r) => r.source === "tool" && !r.removed)
		.sort((a, b) => {
			const priorityDiff = statusPriority(a.status) - statusPriority(b.status);
			if (priorityDiff !== 0) return priorityDiff;
			const startedDiff = (b.startedAt ?? 0) - (a.startedAt ?? 0);
			if (startedDiff !== 0) return startedDiff;
			return b.id - a.id;
		})
		.slice(0, 4);
}

/** Format elapsed milliseconds as a short English string: "5s", "1m 8s", "2h 5m". */
function formatElapsed(ms: number): string {
	const totalSeconds = Math.floor(ms / 1000);
	const hours = Math.floor(totalSeconds / 3600);
	const minutes = Math.floor((totalSeconds % 3600) / 60);
	const seconds = totalSeconds % 60;
	if (hours > 0) return `${hours}h ${minutes}m`;
	if (minutes > 0) return `${minutes}m ${seconds}s`;
	return `${seconds}s`;
}

export function updatePixelWidget(store: SubagentStore, ctx?: any): void {
	const activeCtx = ctx ?? store.pixelWidgetCtx;
	if (!activeCtx?.hasUI) return;
	store.pixelWidgetCtx = activeCtx;

	const toolRuns = getToolRuns(store);

	if (toolRuns.length === 0) {
		activeCtx.ui.setWidget("pixel-subagents", undefined);
		managePixelTimer(store);
		return;
	}

	activeCtx.ui.setWidget("pixel-subagents", (_tui: any, theme: any) => {
		const box = new Box(0, 0);
		const content = new Text("", 0, 0);
		box.addChild(content);

		return {
			render(width: number): string[] {
				const innerWidth = Math.max(1, width);
				const now = Date.now();
				const spinnerFrame = SPINNER_FRAMES[Math.floor(now / SPINNER_INTERVAL_MS) % SPINNER_FRAMES.length];
				const outputLines: string[] = [];

				for (const [idx, run] of toolRuns.entries()) {
					if (idx > 0) outputLines.push(theme.fg("muted", "─".repeat(innerWidth)));

					const elapsed = run.status === "running" ? formatElapsed(now - run.startedAt) : formatElapsed(run.elapsedMs);
					const icon =
						run.status === "done"
							? theme.fg("success", "✓")
							: run.status === "error"
								? theme.fg("error", "✗")
								: theme.fg("warning", spinnerFrame);
					const agentColor = AGENT_NAME_PALETTE[agentBgIndex(run.agent)];
					const agentStr = `\x1b[38;5;${agentColor}m ${run.agent}\x1b[39m`;
					const modeLabel = run.contextMode === "main" ? theme.fg("warning", " · Main") : "";

					const contextWindow = resolveContextWindow(activeCtx, run.model);
					const usedContextPercent = getUsedContextPercent(run.usage?.contextTokens, contextWindow);
					const remainingContextPercent = getRemainingContextPercent(usedContextPercent);
					const contextBar = usedContextPercent !== undefined ? formatContextUsageBar(usedContextPercent) : undefined;
					const contextBarColor =
						remainingContextPercent !== undefined ? getContextBarColorByRemaining(remainingContextPercent) : undefined;
					const contextShort = contextBar
						? contextBarColor
							? theme.fg(contextBarColor, contextBar)
							: theme.fg("dim", contextBar)
						: "";

					const taskSnippet = run.task ? theme.fg("dim", ` · ${run.task.replace(/\s+/g, " ").trim().slice(0, 60)}`) : "";
					const statusLeft =
						`${icon} #${run.id}` + modeLabel + agentStr + theme.fg("dim", `  (${elapsed})`) + taskSnippet;

					if (contextShort) {
						const contextWidth = visibleWidth(contextShort);
						if (contextWidth >= innerWidth) {
							outputLines.push(truncateToWidth(contextShort, innerWidth));
						} else {
							const maxLeftWidth = Math.max(1, innerWidth - contextWidth - 1);
							const fittedLeft = truncateToWidth(statusLeft, maxLeftWidth);
							const gapWidth = Math.max(1, innerWidth - visibleWidth(fittedLeft) - contextWidth);
							outputLines.push(`${fittedLeft}${" ".repeat(gapWidth)}${contextShort}`);
						}
					} else {
						outputLines.push(truncateToWidth(statusLeft, innerWidth));
					}

					const rawText = run.thoughtText || (run.status !== "done" ? run.lastLine : "") || "";
					if (rawText) {
						outputLines.push(theme.fg("accent", `  💭 ${truncateToWidth(rawText, Math.max(1, innerWidth - 4))}`));
					}
				}

				const sepWidth = Math.min(innerWidth, 40);
				outputLines.push(theme.fg("muted", "─".repeat(sepWidth)));

				content.setText(outputLines.join("\n"));
				return box.render(width);
			},
			invalidate() {
				box.invalidate();
			},
		};
	});

	managePixelTimer(store);
}

export function cleanupPixelTimer(): void {
	if (pixelAnimTimer) {
		clearInterval(pixelAnimTimer);
		pixelAnimTimer = undefined;
	}
}
