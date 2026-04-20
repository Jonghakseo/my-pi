import { truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";
import { parseDisplayableEditDiffLine } from "./hashline-display.ts";

export type EditDiffColor =
	| "dim"
	| "error"
	| "muted"
	| "success"
	| "toolDiffAdded"
	| "toolDiffContext"
	| "toolDiffRemoved"
	| "warning";

export type EditDiffBgColor = "toolSuccessBg" | "toolErrorBg";

export interface EditDiffRenderTheme {
	fg: (color: EditDiffColor, text: string) => string;
	bg: (color: EditDiffBgColor, text: string) => string;
	bold: (text: string) => string;
}

export interface ParsedEditDiffLine {
	type: "added" | "removed" | "context" | "ellipsis";
	lineNum: string;
	content: string;
}

export interface EditDiffRowSide {
	type: "added" | "removed" | "context" | "ellipsis" | "empty";
	lineNum: string;
	content: string;
}

export interface EditDiffRow {
	left: EditDiffRowSide;
	right: EditDiffRowSide;
}

export interface EditDiffCounts {
	additions: number;
	removals: number;
}

export interface RenderEditSideBySideOptions {
	diff: string;
	width: number;
	theme: EditDiffRenderTheme;
	maxRows?: number;
	isPreview?: boolean;
}

const MIN_SIDE_BY_SIDE_WIDTH = 20;

export function parseEditUnifiedDiff(diffText: string): ParsedEditDiffLine[] {
	const lines = diffText.split("\n");
	const parsed: ParsedEditDiffLine[] = [];

	for (const line of lines) {
		if (/^\s*\.\.\.$/.test(line)) {
			parsed.push({ type: "ellipsis", lineNum: "", content: "..." });
			continue;
		}

		const match = parseDisplayableEditDiffLine(line);
		if (match) {
			const { prefix, lineNum, content } = match;
			if (prefix === "+") parsed.push({ type: "added", lineNum, content });
			else if (prefix === "-") parsed.push({ type: "removed", lineNum, content });
			else parsed.push({ type: "context", lineNum, content });
		}
	}

	return parsed;
}

function createContextRow(line: ParsedEditDiffLine, lineOffset: number): EditDiffRow {
	const oldNum = line.lineNum;
	const newNum = oldNum ? String(Number.parseInt(oldNum, 10) + lineOffset) : "";
	return {
		left: { type: "context", lineNum: oldNum, content: line.content },
		right: { type: "context", lineNum: newNum, content: line.content },
	};
}

function createMirroredRow(type: "ellipsis", content: string): EditDiffRow {
	return {
		left: { type, lineNum: "", content },
		right: { type, lineNum: "", content },
	};
}

function createAddedOnlyRow(line: ParsedEditDiffLine): EditDiffRow {
	return {
		left: { type: "empty", lineNum: "", content: "" },
		right: { type: "added", lineNum: line.lineNum, content: line.content },
	};
}

function collectSequentialLines(
	parsed: ParsedEditDiffLine[],
	startIndex: number,
	type: ParsedEditDiffLine["type"],
): { lines: ParsedEditDiffLine[]; nextIndex: number } {
	const lines: ParsedEditDiffLine[] = [];
	let index = startIndex;

	while (parsed[index]?.type === type) {
		const current = parsed[index];
		if (current) lines.push(current);
		index++;
	}

	return { lines, nextIndex: index };
}

function appendPairedChangeRows(rows: EditDiffRow[], removed: ParsedEditDiffLine[], added: ParsedEditDiffLine[]): void {
	const rowCount = Math.max(removed.length, added.length);
	for (let rowIndex = 0; rowIndex < rowCount; rowIndex++) {
		const removedLine = removed[rowIndex];
		const addedLine = added[rowIndex];
		rows.push({
			left: removedLine
				? { type: "removed", lineNum: removedLine.lineNum, content: removedLine.content }
				: { type: "empty", lineNum: "", content: "" },
			right: addedLine
				? { type: "added", lineNum: addedLine.lineNum, content: addedLine.content }
				: { type: "empty", lineNum: "", content: "" },
		});
	}
}

export function buildEditSideBySideRows(parsed: ParsedEditDiffLine[]): EditDiffRow[] {
	const rows: EditDiffRow[] = [];
	let index = 0;
	let lineOffset = 0;

	while (index < parsed.length) {
		const line = parsed[index];
		if (!line) break;

		if (line.type === "context") {
			rows.push(createContextRow(line, lineOffset));
			index++;
			continue;
		}

		if (line.type === "ellipsis") {
			rows.push(createMirroredRow("ellipsis", line.content));
			index++;
			continue;
		}

		if (line.type === "removed") {
			const removed = collectSequentialLines(parsed, index, "removed");
			const added = collectSequentialLines(parsed, removed.nextIndex, "added");
			appendPairedChangeRows(rows, removed.lines, added.lines);
			lineOffset += added.lines.length - removed.lines.length;
			index = added.nextIndex;
			continue;
		}

		rows.push(createAddedOnlyRow(line));
		lineOffset += 1;
		index++;
	}

	return rows;
}

export function countEditDiffChanges(diffText: string): EditDiffCounts {
	let additions = 0;
	let removals = 0;

	for (const line of parseEditUnifiedDiff(diffText)) {
		if (line.type === "added") additions++;
		if (line.type === "removed") removals++;
	}

	return { additions, removals };
}

export function slicePreviewRows(rows: EditDiffRow[], maxRows: number): { rows: EditDiffRow[]; hiddenCount: number } {
	if (rows.length <= maxRows) return { rows, hiddenCount: 0 };

	const firstChangedRow = rows.findIndex((row) => row.left.type === "removed" || row.right.type === "added");
	const startIndex = Math.max(0, firstChangedRow <= 0 ? 0 : firstChangedRow - 1);
	const slicedRows = rows.slice(startIndex, startIndex + maxRows);
	const hiddenCount = rows.length - slicedRows.length;
	return { rows: slicedRows, hiddenCount };
}

function lineNumberWidth(rows: EditDiffRow[]): number {
	let maxNumber = 0;
	for (const row of rows) {
		if (row.left.lineNum) maxNumber = Math.max(maxNumber, Number.parseInt(row.left.lineNum, 10));
		if (row.right.lineNum) maxNumber = Math.max(maxNumber, Number.parseInt(row.right.lineNum, 10));
	}
	return Math.max(3, String(maxNumber).length);
}

function sideColor(type: EditDiffRowSide["type"]): EditDiffColor {
	if (type === "added") return "toolDiffAdded";
	if (type === "removed") return "toolDiffRemoved";
	if (type === "ellipsis") return "muted";
	if (type === "context") return "toolDiffContext";
	return "dim";
}

function sideBgColor(type: EditDiffRowSide["type"]): EditDiffBgColor | undefined {
	if (type === "added") return "toolSuccessBg";
	if (type === "removed") return "toolErrorBg";
	return undefined;
}

function formatSide(side: EditDiffRowSide, width: number, numbersWidth: number, theme: EditDiffRenderTheme): string {
	if (side.type === "empty") return " ".repeat(width);

	const lineNumber = side.lineNum ? side.lineNum.padStart(numbersWidth) : " ".repeat(numbersWidth);
	const prefix = side.type === "added" ? "+" : side.type === "removed" ? "-" : " ";
	const rawLine = `${prefix}${lineNumber} ${side.content.replace(/\t/g, "    ")}`;
	const truncated = truncateToWidth(rawLine, width, "");
	const padded = `${truncated}${" ".repeat(Math.max(0, width - visibleWidth(truncated)))}`;
	const colored = theme.fg(sideColor(side.type), padded);
	const bgColor = sideBgColor(side.type);
	return bgColor ? theme.bg(bgColor, colored) : colored;
}

export function renderEditSideBySide({
	diff,
	width,
	theme,
	maxRows,
	isPreview = false,
}: RenderEditSideBySideOptions): string[] {
	const rows = buildEditSideBySideRows(parseEditUnifiedDiff(diff));
	const counts = countEditDiffChanges(diff);
	const summary = [
		theme.fg("success", `+${counts.additions}`),
		theme.fg("dim", " / "),
		theme.fg("error", `-${counts.removals}`),
		isPreview ? theme.fg("warning", " (preview)") : "",
	].join("");

	if (rows.length === 0) return [summary];

	const preview = maxRows === undefined ? { rows, hiddenCount: 0 } : slicePreviewRows(rows, maxRows);
	const lines = [summary];

	if (width < MIN_SIDE_BY_SIDE_WIDTH * 2 + 1) {
		for (const row of preview.rows) {
			if (row.left.type === "removed")
				lines.push(theme.bg("toolErrorBg", theme.fg("toolDiffRemoved", `- ${row.left.content}`)));
			if (row.right.type === "added")
				lines.push(theme.bg("toolSuccessBg", theme.fg("toolDiffAdded", `+ ${row.right.content}`)));
			if (row.left.type === "context") lines.push(theme.fg("toolDiffContext", `  ${row.left.content}`));
			if (row.left.type === "ellipsis") lines.push(theme.fg("muted", "  ..."));
		}
	} else {
		const numbersWidth = lineNumberWidth(rows);
		const leftWidth = Math.floor((width - 1) / 2);
		const rightWidth = width - leftWidth - 1;
		for (const row of preview.rows) {
			const left = formatSide(row.left, leftWidth, numbersWidth, theme);
			const right = formatSide(row.right, rightWidth, numbersWidth, theme);
			lines.push(`${left}${theme.fg("dim", "│")}${right}`);
		}
	}

	if (preview.hiddenCount > 0) {
		lines.push(theme.fg("muted", `… +${preview.hiddenCount} more rows`));
	}

	return lines;
}
