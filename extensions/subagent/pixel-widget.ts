/**
 * Simple single-line-per-run above-editor widget for tool-invoked subagent runs.
 *
 * Each run is rendered as one line:
 *   {icon} #{id} {agent} ({elapsed}): {thought or activity}
 */

import { Box, Text, truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";
import { AGENT_NAME_PALETTE, agentBgIndex } from "./format.js";
import type { SubagentStore } from "./store.js";
import type { CommandRunState } from "./types.js";

const ANIM_REFRESH_MS = 150;
const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const;
const SPINNER_INTERVAL_MS = 120;
const MARQUEE_SPEED_MS = 400;

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
	return Array.from(store.commandRuns.values())
		.filter((r) => r.source === "tool" && !r.removed)
		.sort((a, b) => a.id - b.id);
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

/** Slice plain text to a visible-width window with seamless marquee wrapping. */
function marqueeSlice(text: string, offset: number, maxWidth: number): string {
	const segs: { ch: string; w: number }[] = [];
	let totalW = 0;
	for (const ch of text) {
		const w = visibleWidth(ch);
		segs.push({ ch, w });
		totalW += w;
	}
	if (totalW <= maxWidth) return text;

	const spacer = "   ";
	const fullSegs = [...segs];
	for (const ch of spacer) fullSegs.push({ ch, w: 1 });
	for (const s of segs) fullSegs.push({ ch: s.ch, w: s.w });

	const wrapOffset = offset % (totalW + spacer.length);
	let skipped = 0;
	let startIdx = 0;
	for (let i = 0; i < fullSegs.length; i++) {
		if (skipped >= wrapOffset) {
			startIdx = i;
			break;
		}
		skipped += fullSegs[i].w;
		startIdx = i + 1;
	}

	let result = "";
	let width = 0;
	for (let i = startIdx; i < fullSegs.length && width < maxWidth; i++) {
		if (width + fullSegs[i].w > maxWidth) break;
		result += fullSegs[i].ch;
		width += fullSegs[i].w;
	}
	return result;
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

				for (const run of toolRuns) {
					const elapsed = run.status === "running" ? formatElapsed(now - run.startedAt) : formatElapsed(run.elapsedMs);

					// Status icon
					const icon =
						run.status === "done"
							? theme.fg("success", "✓")
							: run.status === "error"
								? theme.fg("error", "✗")
								: theme.fg("warning", spinnerFrame);

					// Agent name with color
					const agentColor = AGENT_NAME_PALETTE[agentBgIndex(run.agent)];
					const agentStr = `\x1b[38;5;${agentColor}m${run.agent}\x1b[39m`;

					// Build prefix and measure its visible width
					const prefix = `${icon} #${run.id} ${agentStr} (${elapsed}): `;
					const prefixWidth = visibleWidth(prefix);

					// Text source: thought > lastLine > task
					const rawText = run.thoughtText || run.lastLine || run.task || "";
					const maxTextWidth = Math.max(1, innerWidth - prefixWidth);

					let textPart: string;
					if (run.status === "running" && rawText) {
						const scrollOffset = Math.floor(now / MARQUEE_SPEED_MS);
						textPart = theme.fg("muted", marqueeSlice(rawText, scrollOffset, maxTextWidth));
					} else {
						textPart = theme.fg("muted", truncateToWidth(rawText, maxTextWidth));
					}

					outputLines.push(truncateToWidth(`${prefix}${textPart}`, innerWidth));
				}

				// Bottom separator
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
