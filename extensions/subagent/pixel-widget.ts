/**
 * Pixel art above-editor widget for tool-invoked subagent runs.
 *
 * Each agent gets a dynamically-sized cell based on its label width.
 * Pixel art is centered within the cell, and a gap separates cells.
 */

import { Box, Text, truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";
import { AGENT_NAME_PALETTE, agentBgIndex } from "./format.js";
import { CHAR_HEIGHT, CHAR_WIDTH, renderFrame, resolveCharacter } from "./pixel-characters.js";
import type { SubagentStore } from "./store.js";
import type { CommandRunState } from "./types.js";

const ANIM_INTERVAL_MS = 300;
const ANIM_REFRESH_MS = 150;
const CELL_MARGIN = 2; // min padding inside cell (1 each side)
const CELL_GAP = 3; // gap between cells
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
	return Array.from(store.commandRuns.values())
		.filter((r) => r.source === "tool" && !r.removed)
		.sort((a, b) => a.id - b.id);
}

interface RenderedCell {
	artLines: string[]; // CHAR_HEIGHT lines of pixel art (CHAR_WIDTH visible cols)
	label: string; // "✓ #5 worker" with ANSI color
	labelWidth: number; // visible width of label
	thoughtLine: string; // "💭 생각..." with ANSI color (or empty)
	thoughtWidth: number; // visible width of thought line
	cellWidth: number; // max(CHAR_WIDTH, labelWidth, thoughtWidth) + CELL_MARGIN
}

/**
 * Build a single rendered cell for a given agent/status/run.
 */
const THOUGHT_DISPLAY_WIDTH = 13; // visible text area after 💭 icon (icon = 2 cols)
const MARQUEE_SPEED_MS = 400; // scroll 1 char every N ms

/** Slice a plain string from a visible-width offset for a given visible-width window. */
function marqueeSlice(text: string, offset: number, maxWidth: number): string {
	// Build grapheme array with widths
	const segs: { ch: string; w: number }[] = [];
	let totalW = 0;
	for (const ch of text) {
		const w = visibleWidth(ch);
		segs.push({ ch, w });
		totalW += w;
	}
	if (totalW <= maxWidth) return text;

	// Add spacing + repeat for seamless wrap
	const spacer = "   ";
	const fullSegs = [...segs];
	for (const ch of spacer) fullSegs.push({ ch, w: 1 });
	for (const s of segs) fullSegs.push({ ch: s.ch, w: s.w });

	// Skip to offset
	let skipped = 0;
	let startIdx = 0;
	const wrapOffset = offset % (totalW + spacer.length);
	for (let i = 0; i < fullSegs.length; i++) {
		if (skipped >= wrapOffset) {
			startIdx = i;
			break;
		}
		skipped += fullSegs[i].w;
		startIdx = i + 1;
	}

	// Collect maxWidth visible chars
	let result = "";
	let width = 0;
	for (let i = startIdx; i < fullSegs.length && width < maxWidth; i++) {
		if (width + fullSegs[i].w > maxWidth) break;
		result += fullSegs[i].ch;
		width += fullSegs[i].w;
	}
	return result;
}

function buildCell(
	agent: string,
	status: "running" | "done" | "error",
	characterField: string | undefined,
	runId: number,
	tick: number,
	theme: any,
	thoughtText?: string,
): RenderedCell {
	const charDef = resolveCharacter(characterField, agent);
	const frameCount = charDef.frames.length;
	const frameIdx = status === "running" ? tick % frameCount : 0;
	const artLines = renderFrame(charDef.frames[frameIdx]);

	const spinnerFrame = SPINNER_FRAMES[Math.floor(Date.now() / SPINNER_INTERVAL_MS) % SPINNER_FRAMES.length];
	const statusIcon =
		status === "done"
			? theme.fg("success", "✓")
			: status === "error"
				? theme.fg("error", "✗")
				: theme.fg("warning", spinnerFrame);

	const agentColor = AGENT_NAME_PALETTE[agentBgIndex(agent)];
	const label = `${statusIcon} #${runId} \x1b[38;5;${agentColor}m${agent}\x1b[39m`;
	const labelWidth = visibleWidth(label);

	// Build thought line — marquee scrolling for running status
	let thoughtLine = "";
	let thoughtWidth = 0;
	if (status === "running" && thoughtText) {
		const scrollOffset = Math.floor(Date.now() / MARQUEE_SPEED_MS);
		const scrolled = marqueeSlice(thoughtText, scrollOffset, THOUGHT_DISPLAY_WIDTH + 2);
		thoughtLine = theme.fg("muted", scrolled);
		thoughtWidth = visibleWidth(thoughtLine);
	}

	const cellWidth = Math.max(CHAR_WIDTH, labelWidth, thoughtWidth) + CELL_MARGIN;

	return { artLines, label, labelWidth, thoughtLine, thoughtWidth, cellWidth };
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
				const tick = Math.floor(Date.now() / ANIM_INTERVAL_MS);

				// Build cells — one per run
				const allCells: RenderedCell[] = [];
				for (const run of toolRuns) {
					allCells.push(
						buildCell(run.agent, run.status, run.characterField, run.id, tick, theme, run.thoughtText),
					);
				}

				// Determine how many cells fit in width
				let totalWidth = 0;
				let visibleCount = 0;
				for (const cell of allCells) {
					const needed = totalWidth === 0 ? cell.cellWidth : CELL_GAP + cell.cellWidth;
					if (totalWidth + needed > innerWidth) break;
					totalWidth += needed;
					visibleCount++;
				}
				if (visibleCount === 0) visibleCount = 1; // show at least one
				const cells = allCells.slice(0, visibleCount);

				// Recalculate total width for separator
				const sepWidth = cells.reduce((sum, c, i) => sum + c.cellWidth + (i > 0 ? CELL_GAP : 0), 0);

				const outputLines: string[] = [];

				// Center the entire block horizontally
				const blockMargin = Math.max(0, Math.floor((innerWidth - sepWidth) / 2));
				const marginStr = " ".repeat(blockMargin);

				const gap = " ".repeat(CELL_GAP);

				// Thought row — above pixel art (like a thought bubble from the character)
				const hasAnyThought = cells.some((c) => c.thoughtLine.length > 0);
				if (hasAnyThought) {
					const thoughtSegments: string[] = [];
					for (const cell of cells) {
						if (cell.thoughtLine) {
							const padTotal = Math.max(0, cell.cellWidth - cell.thoughtWidth);
							const padL = Math.floor(padTotal / 2);
							const padR = padTotal - padL;
							thoughtSegments.push(" ".repeat(padL) + cell.thoughtLine + " ".repeat(padR));
						} else {
							thoughtSegments.push(" ".repeat(cell.cellWidth));
						}
					}
					outputLines.push(truncateToWidth(marginStr + thoughtSegments.join(gap), innerWidth));
				}

				// Art rows — center each art within its cell
				for (let row = 0; row < CHAR_HEIGHT; row++) {
					const segments: string[] = [];
					for (const cell of cells) {
						const art = cell.artLines[row] ?? "";
						const artVis = CHAR_WIDTH; // art is always CHAR_WIDTH visible cols
						const padTotal = Math.max(0, cell.cellWidth - artVis);
						const padL = Math.floor(padTotal / 2);
						const padR = padTotal - padL;
						segments.push(" ".repeat(padL) + art + " ".repeat(padR));
					}
					outputLines.push(truncateToWidth(marginStr + segments.join(gap), innerWidth));
				}

				// Label row — center each label within its cell
				const labelSegments: string[] = [];
				for (const cell of cells) {
					const padTotal = Math.max(0, cell.cellWidth - cell.labelWidth);
					const padL = Math.floor(padTotal / 2);
					const padR = padTotal - padL;
					labelSegments.push(" ".repeat(padL) + cell.label + " ".repeat(padR));
				}
				outputLines.push(truncateToWidth(marginStr + labelSegments.join(gap), innerWidth));

				// Bottom separator
				outputLines.push(marginStr + theme.fg("muted", "─".repeat(Math.min(innerWidth - blockMargin, sepWidth))));

				content.setText(outputLines.join("\n"));
				return box.render(width);
			},
			invalidate() {
				box.invalidate();
			},
		};
	}); // default placement = aboveEditor

	managePixelTimer(store);
}

export function cleanupPixelTimer(): void {
	if (pixelAnimTimer) {
		clearInterval(pixelAnimTimer);
		pixelAnimTimer = undefined;
	}
}
