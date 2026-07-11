import type { ThemeColor } from "@earendil-works/pi-coding-agent";
import { getLanguageFromPath, highlightCode } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { DiffFile, DiffState, CommitFile, ReviewDraft, Theme } from "./types.js";
import {
	applyHighlightToDiff,
	buildFileTree,
	collapseFileTree,
	collectAllDirPaths,
	extractCodeBlock,
	filterEntriesByOverlayQuery,
	flattenVisibleTree,
	parseDiffLines,
	type CommitState,
	type DiffFileStatus,
	type DiffLineCategory,
	type FileTreeNode,
	type OverlayDiffScope,
	type VisibleRow,
} from "./diff-overlay-utils.js";

// ─── Utils ─────────────────────────────────────────────────────────────────

export function clamp(n: number, min: number, max: number): number {
	if (n < min) return min;
	if (n > max) return max;
	return n;
}

export function commitDiffKey(commitHash: string, filePath: string): string {
	return `${commitHash}\x00${filePath}`;
}

export function scopedDiffKey(scope: OverlayDiffScope, filePath: string): string {
	return `${scope}\x00${filePath}`;
}

export function scopeLabel(scope: OverlayDiffScope): string {
	if (scope === "branch") return "branch";
	if (scope === "working") return "working";
	return "last commit";
}

export function scopeFilesLabel(scope: OverlayDiffScope): string {
	if (scope === "branch") return "branch changes";
	if (scope === "working") return "working tree";
	return "last commit";
}

function basename(filePath: string): string {
	return filePath.split("/").pop() ?? filePath;
}

export function fileDisplayPath(file: { path: string; previousPath?: string | null }): string {
	return file.previousPath ? `${file.previousPath} → ${file.path}` : file.path;
}

export function fileTreeLabel(file: { path: string; previousPath?: string | null }, fallbackName: string): string {
	if (!file.previousPath) return fallbackName;
	return `${basename(file.previousPath)} → ${fallbackName}`;
}

export function buildReviewTransferPrompt(drafts: ReviewDraft[]): string {
	if (drafts.length === 0) return "";
	const lines: string[] = [];
	for (const [index, draft] of drafts.entries()) {
		lines.push(`${index + 1}. [${scopeLabel(draft.scope)}] ${draft.fileDisplayPath}`);
		lines.push(`   ${draft.prompt}`);
		lines.push("");
	}
	return lines.join("\n").trim();
}

interface CommitRowsMeta {
	totalRows: number;
	fileStarts: number[];
	fileEnds: number[];
}

export function overlayContentHeight(totalHeight: number): number {
	const bodyHeight = Math.max(3, totalHeight - 6); // header(3) + footer(3)
	return Math.max(1, bodyHeight - 2); // title + separator
}

export function buildCommitRowsMeta(
	files: CommitFile[],
	commitHash: string,
	expanded: Set<string>,
	diffCache: Map<string, string>,
): CommitRowsMeta {
	let row = 0;
	const fileStarts: number[] = [];
	const fileEnds: number[] = [];

	for (let i = 0; i < files.length; i++) {
		const file = files[i];
		fileStarts[i] = row;
		row += 1; // file header line

		if (expanded.has(file.path)) {
			const raw = diffCache.get(commitDiffKey(commitHash, file.path));
			if (raw === undefined) {
				row += 1; // loading / placeholder line
			} else {
				const parsed = parseDiffLines(raw);
				const visibleDiffLines = parsed.filter((line) => !shouldHideCommitParsedLine(line));
				row += Math.max(1, visibleDiffLines.length);
			}
		}

		fileEnds[i] = row - 1;
	}

	return { totalRows: row, fileStarts, fileEnds };
}

export const UNCOMMITTED_HASH = "__uncommitted__";
export const ARROW_SCROLL_STEP = 5;
export const PAGE_SCROLL_STEP = 20;

// ─── Tree helpers ──────────────────────────────────────────────────────────

export function rebuildTree(files: DiffFile[]): { treeNodes: FileTreeNode[]; expandedDirs: Set<string> } {
	const treeNodes = collapseFileTree(buildFileTree(files.map((f) => f.path)));
	const expandedDirs = new Set(collectAllDirPaths(treeNodes));
	return { treeNodes, expandedDirs };
}

export function getVisibleRows(st: DiffState): VisibleRow[] {
	return flattenVisibleTree(st.treeNodes, st.expandedDirs);
}

export function findFileByPath(st: DiffState, filePath: string | null): DiffFile | null {
	if (!filePath) return null;
	return st.files.find((f) => f.path === filePath) ?? null;
}

export function saveDiffScroll(st: DiffState): void {
	if (!st.selectedFilePath) return;
	st.diffScrollMemory.set(scopedDiffKey(st.scope, st.selectedFilePath), st.diffScrollOffset);
}

export function restoreDiffScroll(st: DiffState): void {
	if (!st.selectedFilePath) {
		st.diffScrollOffset = 0;
		return;
	}
	st.diffScrollOffset = st.diffScrollMemory.get(scopedDiffKey(st.scope, st.selectedFilePath)) ?? 0;
}

export function applyScopeFiles(st: DiffState): void {
	const scopedFiles = st.filesByScope[st.scope] ?? [];
	st.files = filterEntriesByOverlayQuery(scopedFiles, st.searchQuery);

	const { treeNodes, expandedDirs } = rebuildTree(st.files);
	st.treeNodes = treeNodes;
	st.expandedDirs = expandedDirs;

	const visibleRows = getVisibleRows(st);
	const preferredPath = st.selectedFilePathByScope[st.scope];
	const hasPreferred = preferredPath ? st.files.some((file) => file.path === preferredPath) : false;
	const firstFileRow = visibleRows.find((row) => row.type === "file");
	st.selectedFilePath = hasPreferred ? preferredPath : firstFileRow?.type === "file" ? firstFileRow.fullPath : null;
	st.selectedFilePathByScope[st.scope] = st.selectedFilePath;

	const nextIndex = st.selectedFilePath
		? visibleRows.findIndex((row) => row.type === "file" && row.fullPath === st.selectedFilePath)
		: -1;
	st.selectedIndex = clamp(nextIndex >= 0 ? nextIndex : 0, 0, Math.max(0, visibleRows.length - 1));
	st.fileScrollOffset = clamp(st.fileScrollOffset, 0, Math.max(0, visibleRows.length - 1));
	restoreDiffScroll(st);
}

// ─── Syntax highlight ──────────────────────────────────────────────────────

export function buildHighlightedDiff(rawDiff: string, filePath: string, t: Theme): string[] {
	const expanded = rawDiff
		.split("\n")
		.map((l) => expandTabs(l))
		.join("\n");
	const parsed = parseDiffLines(expanded);
	const lang = getLanguageFromPath(filePath);
	const { code } = extractCodeBlock(parsed);
	const highlighted = lang ? highlightCode(code, lang) : code.split("\n");

	return applyHighlightToDiff(
		parsed,
		highlighted,
		(line) => {
			if (line.startsWith("+++") || line.startsWith("---")) return t.fg("muted", line);
			return t.fg("dim", line);
		},
		(line) => t.fg("accent", line),
		(category, prefix) => {
			if (category === "added") return t.fg("success", prefix);
			if (category === "removed") return t.fg("error", prefix);
			return prefix;
		},
	);
}

// ─── Rendering helpers ─────────────────────────────────────────────────────

export function icon(s: DiffFileStatus): string {
	if (s === "added" || s === "untracked") return "+";
	if (s === "deleted") return "-";
	if (s === "renamed") return "→";
	if (s === "copied") return "©";
	return "~";
}

export function statusColor(s: DiffFileStatus): ThemeColor {
	if (s === "added" || s === "untracked") return "success";
	if (s === "deleted") return "error";
	return "warning";
}

export function commitStateColor(state: CommitState): ThemeColor {
	if (state === "both") return "accent";
	if (state === "committed") return "success";
	return "warning";
}

export function expandTabs(s: string, tabSize = 4): string {
	return s.replace(/\t/g, " ".repeat(tabSize));
}

function isCommitFileMarkerLine(line: string): boolean {
	return /^(\+\+\+|---)\s/.test(line);
}

function shouldHideCommitParsedLine(line: ReturnType<typeof parseDiffLines>[number] | undefined): boolean {
	if (!line || line.category !== "meta") return false;
	return line.originalLine.startsWith("diff ") || isCommitFileMarkerLine(line.originalLine);
}

function colorDiffLine(t: Theme, line: string): string {
	if (isCommitFileMarkerLine(line)) return t.fg("muted", line);
	if (line.startsWith("+")) return t.fg("success", line);
	if (line.startsWith("-")) return t.fg("error", line);
	if (line.startsWith("@@")) return t.fg("accent", line);
	if (line.startsWith("diff ") || line.startsWith("index ")) return t.fg("dim", line);
	return line;
}

function padStyledLine(line: string, width: number): string {
	const truncated = truncateToWidth(line, width, "");
	const pad = " ".repeat(Math.max(0, width - visibleWidth(truncated)));
	return `${truncated}${pad}`;
}

function diffLineNumberWidth(parsed: ReturnType<typeof parseDiffLines>): number {
	const maxLineNumber = parsed.reduce(
		(max, line) => Math.max(max, line.oldLineNumber ?? 0, line.newLineNumber ?? 0),
		0,
	);
	return Math.max(3, String(maxLineNumber || 0).length);
}

export function buildCommitRenderedDiffLines(
	t: Theme,
	rawDiff: string,
	width: number,
): Array<{ text: string; category: DiffLineCategory }> {
	const parsed = parseDiffLines(rawDiff);
	const lineNumberWidth = diffLineNumberWidth(parsed);
	const blankLineNumber = " ".repeat(lineNumberWidth);
	const rendered: Array<{ text: string; category: DiffLineCategory }> = [];

	for (const line of parsed) {
		if (shouldHideCommitParsedLine(line)) continue;
		const oldNumber = line.oldLineNumber ? String(line.oldLineNumber).padStart(lineNumberWidth, " ") : blankLineNumber;
		const newNumber = line.newLineNumber ? String(line.newLineNumber).padStart(lineNumberWidth, " ") : blankLineNumber;
		const gutter = t.fg("dim", `${oldNumber} ${newNumber} │`);
		const content = colorDiffLine(t, expandTabs(line.originalLine));
		rendered.push({ text: padStyledLine(`${gutter} ${content}`, width), category: line.category });
	}

	return rendered;
}

function shouldHideDiffMetaLine(line: ReturnType<typeof parseDiffLines>[number] | undefined): boolean {
	if (!line || line.category !== "meta") return false;
	return !line.originalLine.startsWith("\\");
}

export function buildRenderedDiffLines(
	t: Theme,
	all: string[],
	parsed: ReturnType<typeof parseDiffLines>,
	width: number,
	wrapLines: boolean,
	changedOnly: boolean,
): Array<{ text: string; category: DiffLineCategory }> {
	const rendered: Array<{ text: string; category: DiffLineCategory }> = [];
	const lineNumberWidth = diffLineNumberWidth(parsed);
	const blankLineNumber = " ".repeat(lineNumberWidth);

	for (let i = 0; i < all.length; i++) {
		const text = all[i] ?? "";
		const line = parsed[i];
		const category = line?.category ?? "context";
		if (shouldHideDiffMetaLine(line)) continue;
		if (changedOnly && category === "context") continue;

		const oldNumber = line?.oldLineNumber ? String(line.oldLineNumber).padStart(lineNumberWidth, " ") : blankLineNumber;
		const newNumber = line?.newLineNumber ? String(line.newLineNumber).padStart(lineNumberWidth, " ") : blankLineNumber;
		const gutter = t.fg("dim", `${oldNumber} ${newNumber} │`);
		const contentWidth = Math.max(1, width - visibleWidth(gutter) - 1);

		if (wrapLines) {
			const wrapped = wrapTextWithAnsi(` ${text}`, contentWidth);
			for (const [segmentIndex, segment] of wrapped.entries()) {
				const lineGutter = segmentIndex === 0 ? gutter : t.fg("dim", `${blankLineNumber} ${blankLineNumber} │`);
				rendered.push({ text: padStyledLine(`${lineGutter} ${segment}`, width), category });
			}
			continue;
		}

		rendered.push({ text: padStyledLine(`${gutter} ${text}`, width), category });
	}

	return rendered;
}

export function countRenderedDiffLines(
	all: string[],
	parsed: ReturnType<typeof parseDiffLines>,
	width: number,
	wrapLines: boolean,
	changedOnly: boolean,
): number {
	const lineNumberWidth = diffLineNumberWidth(parsed);
	const gutterWidth = lineNumberWidth * 2 + 4;
	const contentWidth = Math.max(1, width - gutterWidth - 1);
	let count = 0;

	for (let i = 0; i < all.length; i++) {
		const line = parsed[i];
		const category = line?.category ?? "context";
		if (shouldHideDiffMetaLine(line)) continue;
		if (changedOnly && category === "context") continue;
		if (wrapLines) count += wrapTextWithAnsi(` ${all[i] ?? ""}`, contentWidth).length;
		else count += 1;
	}

	return count;
}
