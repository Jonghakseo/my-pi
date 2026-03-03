/**
 * Intent progress widget — renders above the editor to show
 * real-time status of single intent runs and Blueprint execution.
 *
 * Two display modes:
 * 1. Single Intent: compact one-liner with spinner + elapsed time
 * 2. Blueprint: full node list with per-node status tracking
 *
 * Uses the same component factory pattern as subagent/pixel-widget.ts.
 */

import { Box, Text, truncateToWidth } from "@mariozechner/pi-tui";
import { formatDuration } from "../utils/time-utils.js";
import { loadBlueprint } from "./blueprint.js";
import type { Blueprint, BlueprintNode } from "./types.js";

// ─── Constants ───────────────────────────────────────────────────────────────

const WIDGET_KEY = "intent-progress";
const REFRESH_MS = 500;
const HIDE_DELAY_MS = 5000;
const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const;
const SPINNER_INTERVAL_MS = 120;

// ─── State ───────────────────────────────────────────────────────────────────

interface SingleIntentRun {
	id: number;
	purpose: string;
	difficulty: string;
	agent: string;
	task: string;
	startedAt: number;
	completedAt?: number;
	status: "running" | "completed" | "failed";
}

let widgetCtx: any = null;
const activeSingleRuns = new Map<number, SingleIntentRun>();
let activeBlueprintId: string | null = null;
let cachedBlueprint: Blueprint | null = null;
let refreshTimer: ReturnType<typeof setInterval> | undefined;
let hideTimer: ReturnType<typeof setTimeout> | undefined;
let runIdCounter = 0;

// ─── Public API ──────────────────────────────────────────────────────────────

/** Cache the latest tool execute context for widget rendering. */
export function initWidgetCtx(ctx: any): void {
	if (ctx?.hasUI) widgetCtx = ctx;
}

/** Start tracking a single intent run. Returns a run ID for later completion. */
export function trackSingleStart(purpose: string, difficulty: string, agent: string, task: string): number {
	cancelHideTimer();
	const id = ++runIdCounter;
	activeSingleRuns.set(id, {
		id,
		purpose,
		difficulty,
		agent,
		task,
		startedAt: Date.now(),
		status: "running",
	});
	ensureRefreshTimer();
	renderWidget();
	return id;
}

/** Mark a single intent run as completed or failed. */
export function trackSingleEnd(runId: number, success: boolean): void {
	const run = activeSingleRuns.get(runId);
	if (run) {
		run.status = success ? "completed" : "failed";
		run.completedAt = Date.now();
	}
	renderWidget();
	maybeScheduleHide();
}

/** Set the active Blueprint and show its status. */
export function trackBlueprintActive(blueprintId: string): void {
	cancelHideTimer();
	activeBlueprintId = blueprintId;
	cachedBlueprint = loadBlueprint(blueprintId);
	ensureRefreshTimer();
	renderWidget();
}

/** Reload cached Blueprint state after a node status change. */
export function trackBlueprintNodeChanged(blueprintId: string): void {
	if (activeBlueprintId === blueprintId) {
		cachedBlueprint = loadBlueprint(blueprintId);
		renderWidget();
		maybeScheduleHide();
	}
}

/** Force-clear the widget (used on abort). */
export function clearIntentWidget(): void {
	activeSingleRuns.clear();
	activeBlueprintId = null;
	cachedBlueprint = null;
	cancelHideTimer();
	stopRefreshTimer();
	if (widgetCtx?.hasUI) widgetCtx.ui.setWidget(WIDGET_KEY, undefined);
}

/** Stop all timers (for extension cleanup). */
export function cleanupIntentWidget(): void {
	stopRefreshTimer();
	cancelHideTimer();
}

// ─── Timer Management ────────────────────────────────────────────────────────

function ensureRefreshTimer(): void {
	if (!refreshTimer) {
		refreshTimer = setInterval(() => renderWidget(), REFRESH_MS);
	}
}

function stopRefreshTimer(): void {
	if (refreshTimer) {
		clearInterval(refreshTimer);
		refreshTimer = undefined;
	}
}

function cancelHideTimer(): void {
	if (hideTimer) {
		clearTimeout(hideTimer);
		hideTimer = undefined;
	}
}

function maybeScheduleHide(): void {
	const hasRunningSingle = Array.from(activeSingleRuns.values()).some((r) => r.status === "running");
	const bpDone =
		cachedBlueprint &&
		(cachedBlueprint.status === "completed" ||
			cachedBlueprint.status === "aborted" ||
			cachedBlueprint.status === "failed");

	// Don't auto-hide if anything is still running
	if (hasRunningSingle) return;
	if (activeBlueprintId && !bpDone) return;

	cancelHideTimer();
	hideTimer = setTimeout(() => {
		// Remove completed single runs
		for (const [id, run] of activeSingleRuns) {
			if (run.status !== "running") activeSingleRuns.delete(id);
		}
		if (bpDone) {
			activeBlueprintId = null;
			cachedBlueprint = null;
		}
		stopRefreshTimer();
		if (widgetCtx?.hasUI) widgetCtx.ui.setWidget(WIDGET_KEY, undefined);
		hideTimer = undefined;
	}, HIDE_DELAY_MS);
}

// ─── Rendering ───────────────────────────────────────────────────────────────

function renderWidget(): void {
	if (!widgetCtx?.hasUI) return;

	const hasSingle = activeSingleRuns.size > 0;
	const hasBp = activeBlueprintId && cachedBlueprint;

	if (!hasSingle && !hasBp) {
		widgetCtx.ui.setWidget(WIDGET_KEY, undefined);
		stopRefreshTimer();
		return;
	}

	widgetCtx.ui.setWidget(WIDGET_KEY, (_tui: any, theme: any) => {
		const box = new Box(0, 0);
		const content = new Text("", 0, 0);
		box.addChild(content);

		return {
			render(width: number): string[] {
				const w = Math.max(1, width);
				const lines: string[] = [];

				// Blueprint section
				if (cachedBlueprint) {
					renderBlueprintBlock(cachedBlueprint, w, theme, lines);
				}

				// Single intent runs
				for (const run of activeSingleRuns.values()) {
					renderSingleBlock(run, w, theme, lines);
				}

				// Bottom separator
				if (lines.length > 0) {
					lines.push(theme.fg("muted", "─".repeat(Math.min(w, 60))));
				}

				content.setText(lines.join("\n"));
				return box.render(width);
			},
			invalidate() {
				box.invalidate();
			},
		};
	}); // default placement = aboveEditor
}

// ─── Blueprint Rendering ─────────────────────────────────────────────────────

function renderBlueprintBlock(bp: Blueprint, width: number, theme: any, lines: string[]): void {
	const completed = bp.nodes.filter((n) => n.status === "completed").length;
	const total = bp.nodes.length;

	// Header with status-colored title
	const statusColor =
		bp.status === "completed" ? "success" : bp.status === "aborted" || bp.status === "failed" ? "error" : "accent";
	lines.push(truncateToWidth(theme.fg(statusColor, `📋 ${bp.title} [${completed}/${total}]`), width));

	// Node rows
	for (const node of bp.nodes) {
		lines.push(truncateToWidth(renderNodeLine(node, theme), width));
	}
}

function renderNodeLine(node: BlueprintNode, theme: any): string {
	const spinner = SPINNER_FRAMES[Math.floor(Date.now() / SPINNER_INTERVAL_MS) % SPINNER_FRAMES.length];

	// Status icon — all 1-column characters for consistent alignment
	let icon: string;
	switch (node.status) {
		case "running":
			icon = theme.fg("warning", spinner);
			break;
		case "completed":
			icon = theme.fg("success", "✓");
			break;
		case "failed":
			icon = theme.fg("error", "✗");
			break;
		case "skipped":
			icon = theme.fg("muted", "-");
			break;
		default:
			icon = theme.fg("muted", "○");
			break;
	}

	// Node ID — padded for alignment
	const nodeId = node.id.padEnd(14);

	// Purpose/difficulty
	const purpose = `${node.purpose}/${node.difficulty.slice(0, 3)}`.padEnd(16);

	// Agent
	const agent = node.agent ? `→ ${node.agent}`.padEnd(14) : " ".repeat(14);

	// Status text with elapsed
	let statusText: string;
	switch (node.status) {
		case "running":
			statusText = theme.fg("warning", elapsedFromIso(node.startedAt));
			break;
		case "completed":
			statusText = theme.fg("success", durationBetweenIso(node.startedAt, node.completedAt));
			break;
		case "failed":
			statusText = theme.fg("error", durationBetweenIso(node.startedAt, node.completedAt));
			break;
		default:
			statusText = "";
			break;
	}

	return ` ${icon} ${nodeId} ${theme.fg("dim", purpose)} ${theme.fg("dim", agent)} ${statusText}`;
}

// ─── Single Intent Rendering ─────────────────────────────────────────────────

function renderSingleBlock(run: SingleIntentRun, width: number, theme: any, lines: string[]): void {
	const spinner = SPINNER_FRAMES[Math.floor(Date.now() / SPINNER_INTERVAL_MS) % SPINNER_FRAMES.length];
	const elapsed = formatDuration((run.completedAt ?? Date.now()) - run.startedAt);

	let headerLine: string;
	switch (run.status) {
		case "running":
			headerLine =
				theme.fg("warning", `🎯 ${spinner} ${run.purpose}/${run.difficulty} → ${run.agent}`) +
				theme.fg("dim", ` (${elapsed})`);
			break;
		case "completed":
			headerLine =
				theme.fg("success", `✅ ${run.purpose}/${run.difficulty} → ${run.agent}`) +
				theme.fg("dim", ` (완료, ${elapsed})`);
			break;
		case "failed":
			headerLine =
				theme.fg("error", `❌ ${run.purpose}/${run.difficulty} → ${run.agent}`) +
				theme.fg("dim", ` (실패, ${elapsed})`);
			break;
	}

	lines.push(truncateToWidth(headerLine, width));

	// Task preview (single line, collapsed whitespace)
	const taskText = run.task.replace(/\s*\n+\s*/g, " ").trim();
	const maxLen = Math.max(1, width - 4);
	const truncated = taskText.length > maxLen ? `${taskText.slice(0, maxLen - 3)}...` : taskText;
	lines.push(truncateToWidth(theme.fg("dim", `   ${truncated}`), width));
}

// ─── Time Helpers ────────────────────────────────────────────────────────────

/** Format elapsed time from an ISO string to now. */
function elapsedFromIso(isoStr?: string): string {
	if (!isoStr) return "";
	const ms = Date.now() - new Date(isoStr).getTime();
	return formatDuration(Math.max(0, ms));
}

/** Format duration between two ISO strings (or from start to now). */
function durationBetweenIso(start?: string, end?: string): string {
	if (!start) return "";
	const startMs = new Date(start).getTime();
	const endMs = end ? new Date(end).getTime() : Date.now();
	return formatDuration(Math.max(0, endMs - startMs));
}
