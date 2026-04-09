/**
 * Subagent run status widget — renders per-run status boxes below the editor.
 */

import type { Theme, ThemeColor } from "@mariozechner/pi-coding-agent";
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
	truncateToWidthWithEllipsis,
} from "./format.js";

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const;
const SPINNER_INTERVAL_MS = 120;
const SPINNER_REFRESH_MS = 150;

const MAX_VISIBLE_RUNS = 3;
const MAX_TASK_LABEL_CHARS = 36;
const MIN_LEFT_LABEL_WIDTH = 24;
const MIN_CONTEXT_BAR_WIDTH = 8;

import { type SubagentStore, truncateText } from "./store.js";
import type { CommandRunState } from "./types.js";

type ThemeBg = Parameters<Theme["bg"]>[0];
type WidgetTheme = {
	fg: (color: ThemeColor, text: string) => string;
	bold: (text: string) => string;
	bg: (color: ThemeBg, text: string) => string;
};

type WidgetFactory = (
	tui: unknown,
	theme: WidgetTheme,
) => {
	render(width: number): string[];
	invalidate?(): void;
	dispose?(): void;
};

type WidgetPlacementOptions = { placement?: "aboveEditor" | "belowEditor" };

type WidgetSetWidget = {
	(key: string, content: string[] | undefined, options?: WidgetPlacementOptions): void;
	(key: string, content: WidgetFactory | undefined, options?: WidgetPlacementOptions): void;
};

export type WidgetRenderCtx = {
	hasUI?: boolean;
	ui?: {
		setWidget: WidgetSetWidget;
	};
	model?: { contextWindow?: number };
	modelRegistry?: {
		getAll: () => Array<{ provider: string; id: string; contextWindow?: number }>;
	};
};

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

function getStatusVisual(run: CommandRunState): { statusColor: ThemeColor; statusIcon: string } {
	const statusColor: ThemeColor = run.status === "running" ? "warning" : run.status === "done" ? "success" : "error";
	const spinnerFrame = SPINNER_FRAMES[Math.floor(Date.now() / SPINNER_INTERVAL_MS) % SPINNER_FRAMES.length];
	const statusIcon = run.status === "running" ? spinnerFrame : run.status === "done" ? "✓" : "✗";
	return { statusColor, statusIcon };
}

function getIdleLabel(run: CommandRunState, theme: WidgetTheme): string {
	if (run.status !== "running" || !run.lastActivityAt) return "";
	const idleMs = Date.now() - run.lastActivityAt;
	const idleSec = Math.round(idleMs / 1000);
	if (idleSec < 5) return "";
	const idleColor: ThemeColor = idleMs >= HANG_WARNING_IDLE_MS ? "error" : "dim";
	return theme.fg(idleColor, `idle:${idleSec}s`);
}

function getContextShort(run: CommandRunState, ctx: WidgetRenderCtx, theme: WidgetTheme): string {
	const contextWindow = resolveContextWindow(ctx, run.model);
	const usedContextPercent = getUsedContextPercent(run.usage?.contextTokens, contextWindow);
	const remainingContextPercent = getRemainingContextPercent(usedContextPercent);
	const contextBar = usedContextPercent !== undefined ? formatContextUsageBar(usedContextPercent) : undefined;
	if (!contextBar) return "";
	const contextBarColor =
		remainingContextPercent !== undefined ? getContextBarColorByRemaining(remainingContextPercent) : undefined;
	return contextBarColor ? theme.fg(contextBarColor, contextBar) : theme.fg("dim", contextBar);
}

function buildStatusLeft(run: CommandRunState, theme: WidgetTheme): string {
	const { statusColor, statusIcon } = getStatusVisual(run);
	const elapsedSec = Math.max(0, Math.round(run.elapsedMs / 1000));
	const displayTask = run.displayTask ?? run.task;
	const taskLabel = displayTask
		? theme.fg("dim", truncateText(displayTask.replace(/\s+/g, " ").trim(), MAX_TASK_LABEL_CHARS))
		: "";
	const delimiter = theme.fg("muted", " · ");
	const leftParts = [
		theme.fg(statusColor, `${statusIcon} #${run.id}`),
		run.contextMode === "main" ? theme.fg("warning", "Main") : "",
		`\x1b[38;5;${AGENT_NAME_PALETTE[agentBgIndex(run.agent)]}m${run.agent}\x1b[39m`,
		theme.fg("dim", `${elapsedSec}s`),
		taskLabel,
		getIdleLabel(run, theme),
	].filter(Boolean);
	return leftParts.join(delimiter);
}

function composeRunLine(left: string, right: string, innerWidth: number): string {
	if (!right || innerWidth <= MIN_LEFT_LABEL_WIDTH) {
		return truncateToWidthWithEllipsis(left, innerWidth);
	}

	const allowedRightWidth = Math.min(visibleWidth(right), Math.max(0, innerWidth - MIN_LEFT_LABEL_WIDTH - 1));
	if (allowedRightWidth < MIN_CONTEXT_BAR_WIDTH) {
		return truncateToWidthWithEllipsis(left, innerWidth);
	}

	const fittedRight = truncateToWidth(right, allowedRightWidth);
	const maxLeftWidth = Math.max(1, innerWidth - visibleWidth(fittedRight) - 1);
	const fittedLeft = truncateToWidthWithEllipsis(left, maxLeftWidth);
	const gapWidth = Math.max(1, innerWidth - visibleWidth(fittedLeft) - visibleWidth(fittedRight));
	return `${fittedLeft}${" ".repeat(gapWidth)}${fittedRight}`;
}

export function updateCommandRunsWidget(store: SubagentStore, ctx?: WidgetRenderCtx): void {
	const activeCtx = ctx ?? store.commandWidgetCtx;
	if (!activeCtx || !activeCtx.hasUI || !activeCtx.ui) return;
	store.commandWidgetCtx = activeCtx;
	const { ui } = activeCtx;

	// Parent session hint — visible when inside a child session (persistent parent link exists)
	if (store.currentParentSessionFile) {
		ui.setWidget(
			"sub-parent",
			(_tui: unknown, theme: WidgetTheme) => {
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
		ui.setWidget("sub-parent", undefined);
	}

	const statusPriority = (status: "running" | "done" | "error") =>
		status === "running" ? 0 : status === "done" ? 1 : 2;
	// Show all subagent runs in the belowEditor widget, regardless of how they were launched.
	const runs = Array.from(store.commandRuns.values())
		.filter((r) => !r.removed)
		.sort((a, b) => {
			const priorityDiff = statusPriority(a.status) - statusPriority(b.status);
			if (priorityDiff !== 0) return priorityDiff;
			const startedDiff = (b.startedAt ?? 0) - (a.startedAt ?? 0);
			if (startedDiff !== 0) return startedDiff;
			return b.id - a.id;
		})
		.slice(0, MAX_VISIBLE_RUNS);
	const visibleRunIds = new Set<number>(runs.map((run) => run.id));

	for (const id of Array.from(store.renderedRunWidgetIds)) {
		if (!visibleRunIds.has(id)) {
			ui.setWidget(`sub-${id}`, undefined);
			store.renderedRunWidgetIds.delete(id);
		}
	}

	if (runs.length === 0) {
		ui.setWidget("subagent-runs", undefined);
		manageSpinnerTimer(store);
		return;
	}

	ui.setWidget("subagent-runs", undefined);

	for (const run of runs) {
		store.renderedRunWidgetIds.add(run.id);
		ui.setWidget(
			`sub-${run.id}`,
			(_tui: unknown, theme: WidgetTheme) => {
				const box = new Box(1, 0);
				const content = new Text("", 0, 0);
				box.addChild(content);

				return {
					render(width: number): string[] {
						const innerWidth = Math.max(1, width - 2);
						const statusLeft = buildStatusLeft(run, theme);
						const contextShort = getContextShort(run, activeCtx, theme);
						content.setText(composeRunLine(statusLeft, contextShort, innerWidth));
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
