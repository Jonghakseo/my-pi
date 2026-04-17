/**
 * /diff — Git diff overlay
 *
 * Split-pane view with mode toggle:
 * - Diff mode: left = changed files, right = aggregated file diff (current behavior)
 * - Commit mode: left = commits, right = changed files per selected commit (fold/expand)
 *
 * Global: Tab / v toggles Diff ↔ Commit mode
 */

import path from "node:path";
import type { ExtensionAPI, ExtensionCommandContext, ThemeColor } from "@mariozechner/pi-coding-agent";
import { DynamicBorder, getLanguageFromPath, highlightCode } from "@mariozechner/pi-coding-agent";
import { Key, matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@mariozechner/pi-tui";
import {
	applyHighlightToDiff,
	type BranchCommitEntry,
	buildFileTree,
	type CommitState,
	collapseFileTree,
	collectAllDirPaths,
	commitStateBadge,
	cycleOverlayDiffScope,
	type DiffFileStatus,
	type DiffLineCategory,
	extractCodeBlock,
	type FileTreeNode,
	filterEntriesByOverlayQuery,
	flattenVisibleTree,
	mergeDiffEntries,
	type OverlayDiffScope,
	type OverlayViewMode,
	parseDiffLines,
	parseGitLogOutput,
	parseNameStatusZ,
	parsePorcelainStatusZ,
	toggleOverlayViewMode,
	type VisibleRow,
} from "./utils/diff-overlay-utils.ts";

// ─── Types ─────────────────────────────────────────────────────────────────

interface DiffFile {
	path: string;
	status: DiffFileStatus;
	rawStatus: string;
	commitState: CommitState;
	previousPath?: string | null;
}

interface CommitFile {
	path: string;
	status: DiffFileStatus;
	rawStatus: string;
	previousPath?: string | null;
}

type FocusPane = "left" | "right";

interface ReviewDraft {
	scope: OverlayDiffScope;
	filePath: string;
	fileDisplayPath: string;
	prompt: string;
}

interface ReviewInputState {
	active: boolean;
	buffer: string;
	error: string | null;
}

interface DiffState {
	// Diff mode
	files: DiffFile[];
	filesByScope: Record<OverlayDiffScope, DiffFile[]>;
	scope: OverlayDiffScope;
	searchQuery: string;
	searchMode: boolean;
	selectedIndex: number;
	fileScrollOffset: number;
	diffCache: Map<string, string>;
	highlightedDiffCache: Map<string, string[]>;
	diffScrollOffset: number;
	diffScrollMemory: Map<string, number>;
	selectedFilePathByScope: Record<OverlayDiffScope, string | null>;
	wrapLines: boolean;
	changedOnly: boolean;
	reviewDrafts: ReviewDraft[];
	reviewInput: ReviewInputState;

	// Tree state for diff mode
	treeNodes: FileTreeNode[];
	expandedDirs: Set<string>;
	selectedFilePath: string | null;

	// Commit mode
	commits: BranchCommitEntry[];
	commitSelectedIndex: number;
	commitScrollOffset: number;
	commitFilesCache: Map<string, CommitFile[]>;
	commitFilesLoading: Set<string>;
	commitFileDiffCache: Map<string, string>;
	commitFileDiffLoading: Set<string>;
	commitExpandedByHash: Map<string, Set<string>>;
	commitFileSelectedIndex: number;
	commitFileScrollOffset: number; // line-based scroll in right commit pane
	commitFileManualScroll: boolean;

	viewMode: OverlayViewMode;
	focus: FocusPane;

	branch: string;
	mergeBase: string | null;
	baseBranch: string | null;
	error: string | null;
}

interface Theme {
	fg: (color: ThemeColor, text: string) => string;
	bg: (color: "toolSuccessBg" | "toolErrorBg" | "selectedBg", text: string) => string;
	bold: (text: string) => string;
}

interface Tui {
	requestRender: () => void;
	terminal?: { rows?: number };
}

// ─── Utils ─────────────────────────────────────────────────────────────────

function clamp(n: number, min: number, max: number): number {
	if (n < min) return min;
	if (n > max) return max;
	return n;
}

function commitDiffKey(commitHash: string, filePath: string): string {
	return `${commitHash}\x00${filePath}`;
}

function scopedDiffKey(scope: OverlayDiffScope, filePath: string): string {
	return `${scope}\x00${filePath}`;
}

function scopeLabel(scope: OverlayDiffScope): string {
	if (scope === "branch") return "branch";
	if (scope === "working") return "working";
	return "last commit";
}

function scopeFilesLabel(scope: OverlayDiffScope): string {
	if (scope === "branch") return "branch changes";
	if (scope === "working") return "working tree";
	return "last commit";
}

function basename(filePath: string): string {
	return filePath.split("/").pop() ?? filePath;
}

function fileDisplayPath(file: { path: string; previousPath?: string | null }): string {
	return file.previousPath ? `${file.previousPath} → ${file.path}` : file.path;
}

function fileTreeLabel(file: { path: string; previousPath?: string | null }, fallbackName: string): string {
	if (!file.previousPath) return fallbackName;
	return `${basename(file.previousPath)} → ${fallbackName}`;
}

function buildReviewTransferPrompt(drafts: ReviewDraft[]): string {
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

function overlayContentHeight(totalHeight: number): number {
	const bodyHeight = Math.max(3, totalHeight - 6); // header(3) + footer(3)
	return Math.max(1, bodyHeight - 2); // title + separator
}

function buildCommitRowsMeta(
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
				const diffLines = raw.split("\n");
				row += Math.max(1, diffLines.length);
			}
		}

		fileEnds[i] = row - 1;
	}

	return { totalRows: row, fileStarts, fileEnds };
}

const UNCOMMITTED_HASH = "__uncommitted__";

// ─── Tree helpers ──────────────────────────────────────────────────────────

function rebuildTree(files: DiffFile[]): { treeNodes: FileTreeNode[]; expandedDirs: Set<string> } {
	const treeNodes = collapseFileTree(buildFileTree(files.map((f) => f.path)));
	const expandedDirs = new Set(collectAllDirPaths(treeNodes));
	return { treeNodes, expandedDirs };
}

function getVisibleRows(st: DiffState): VisibleRow[] {
	return flattenVisibleTree(st.treeNodes, st.expandedDirs);
}

function findFileByPath(st: DiffState, filePath: string | null): DiffFile | null {
	if (!filePath) return null;
	return st.files.find((f) => f.path === filePath) ?? null;
}

function saveDiffScroll(st: DiffState): void {
	if (!st.selectedFilePath) return;
	st.diffScrollMemory.set(scopedDiffKey(st.scope, st.selectedFilePath), st.diffScrollOffset);
}

function restoreDiffScroll(st: DiffState): void {
	if (!st.selectedFilePath) {
		st.diffScrollOffset = 0;
		return;
	}
	st.diffScrollOffset = st.diffScrollMemory.get(scopedDiffKey(st.scope, st.selectedFilePath)) ?? 0;
}

function applyScopeFiles(st: DiffState): void {
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

function buildHighlightedDiff(rawDiff: string, filePath: string, t: Theme): string[] {
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

// ─── Git helpers ───────────────────────────────────────────────────────────

async function gitRoot(pi: ExtensionAPI, cwd: string): Promise<string | null> {
	const r = await pi.exec("git", ["rev-parse", "--show-toplevel"], { cwd });
	return r.code === 0 ? (r.stdout ?? "").trim() || null : null;
}

async function currentBranch(pi: ExtensionAPI, cwd: string): Promise<string> {
	const r = await pi.exec("git", ["branch", "--show-current"], { cwd });
	return r.code === 0 ? (r.stdout ?? "").trim() || "HEAD" : "HEAD";
}

interface MergeBaseInfo {
	commit: string;
	baseBranch: string;
}

async function findMergeBase(pi: ExtensionAPI, cwd: string, branch: string): Promise<MergeBaseInfo | null> {
	const defaults = ["main", "master", "develop"];
	if (defaults.includes(branch) || branch === "HEAD") return null;

	const symRef = await pi.exec("git", ["symbolic-ref", "refs/remotes/origin/HEAD", "--short"], { cwd });
	if (symRef.code === 0 && symRef.stdout?.trim()) {
		const defaultBranch = symRef.stdout.trim().replace(/^origin\//, "");
		if (defaultBranch !== branch) {
			const r = await pi.exec("git", ["merge-base", branch, `origin/${defaultBranch}`], { cwd });
			if (r.code === 0 && r.stdout?.trim()) {
				return { commit: r.stdout.trim(), baseBranch: defaultBranch };
			}
		}
	}

	for (const base of defaults) {
		if (base === branch) continue;
		const r = await pi.exec("git", ["merge-base", branch, `origin/${base}`], { cwd });
		if (r.code === 0 && r.stdout?.trim()) return { commit: r.stdout.trim(), baseBranch: base };
	}
	return null;
}

async function repositoryHasHead(pi: ExtensionAPI, cwd: string): Promise<boolean> {
	const r = await pi.exec("git", ["rev-parse", "--verify", "HEAD"], { cwd });
	return r.code === 0;
}

async function committedFiles(pi: ExtensionAPI, cwd: string, mergeBase: string | null): Promise<DiffFile[]> {
	if (!mergeBase) return [];
	const diffR = await pi.exec("git", ["diff", "--name-status", "-z", `${mergeBase}..HEAD`], { cwd });
	if (diffR.code !== 0 || !diffR.stdout) return [];
	return parseNameStatusZ(diffR.stdout).map((entry) => ({ ...entry, commitState: "committed" }));
}

async function workingTreeFiles(pi: ExtensionAPI, cwd: string): Promise<DiffFile[]> {
	const r = await pi.exec("git", ["status", "--porcelain=1", "-uall", "-z"], { cwd });
	if (r.code !== 0 || !r.stdout) return [];
	return parsePorcelainStatusZ(r.stdout).map((entry) => ({ ...entry, commitState: "uncommitted" }));
}

async function lastCommitFiles(pi: ExtensionAPI, cwd: string): Promise<DiffFile[]> {
	if (!(await repositoryHasHead(pi, cwd))) return [];
	const r = await pi.exec("git", ["show", "--name-status", "--format=", "-z", "HEAD"], { cwd });
	if (r.code !== 0 || !r.stdout) return [];
	return parseNameStatusZ(r.stdout).map((entry) => ({ ...entry, commitState: "committed" }));
}

async function changedFiles(pi: ExtensionAPI, cwd: string, mergeBase: string | null): Promise<DiffFile[]> {
	const [committed, working] = await Promise.all([committedFiles(pi, cwd, mergeBase), workingTreeFiles(pi, cwd)]);
	return mergeDiffEntries(committed, working);
}

const COMMIT_HISTORY_LIMIT = 200;
const GIT_LOG_PRETTY = "%H%x1f%h%x1f%an%x1f%ar%x1f%s%x1e";

async function branchCommits(pi: ExtensionAPI, cwd: string, mergeBase: string | null): Promise<BranchCommitEntry[]> {
	const range = mergeBase ? `${mergeBase}..HEAD` : "HEAD";
	const r = await pi.exec(
		"git",
		["log", "--no-color", `--max-count=${COMMIT_HISTORY_LIMIT}`, `--pretty=format:${GIT_LOG_PRETTY}`, range],
		{ cwd },
	);

	const commits = r.code === 0 && r.stdout ? parseGitLogOutput(r.stdout) : [];
	if (commits.length > 0 || !mergeBase) return commits;

	const fallback = await pi.exec(
		"git",
		[
			"log",
			"--no-color",
			`--max-count=${Math.min(50, COMMIT_HISTORY_LIMIT)}`,
			`--pretty=format:${GIT_LOG_PRETTY}`,
			"HEAD",
		],
		{ cwd },
	);
	if (fallback.code !== 0 || !fallback.stdout) return [];
	return parseGitLogOutput(fallback.stdout);
}

interface OverlayData {
	filesByScope: Record<OverlayDiffScope, DiffFile[]>;
	commits: BranchCommitEntry[];
	uncommittedFiles: DiffFile[];
}

async function loadOverlayData(pi: ExtensionAPI, cwd: string, mergeBase: string | null): Promise<OverlayData> {
	const workingFilesPromise = workingTreeFiles(pi, cwd);
	const [branchFiles, workingFiles, lastCommitScopeFiles, commits] = await Promise.all([
		changedFiles(pi, cwd, mergeBase),
		workingFilesPromise,
		lastCommitFiles(pi, cwd),
		branchCommits(pi, cwd, mergeBase),
	]);
	const uncommittedFiles = [...workingFiles];

	return {
		filesByScope: {
			branch: branchFiles,
			working: workingFiles,
			"last-commit": lastCommitScopeFiles,
		},
		commits,
		uncommittedFiles,
	};
}

async function commitFilesForHash(pi: ExtensionAPI, cwd: string, commitHash: string): Promise<CommitFile[]> {
	const r = await pi.exec("git", ["show", "--name-status", "--format=", "-z", commitHash], { cwd });
	if (r.code !== 0 || !r.stdout) return [];
	return parseNameStatusZ(r.stdout);
}

async function asAddedFileDiff(pi: ExtensionAPI, cwd: string, filePath: string): Promise<string> {
	const r = await pi.exec("cat", [filePath], { cwd });
	if (r.code !== 0) return "(cannot read file)";
	return (r.stdout ?? "")
		.split("\n")
		.map((line) => `+ ${line}`)
		.join("\n");
}

async function workingTreeFileDiff(
	pi: ExtensionAPI,
	cwd: string,
	file: { path: string; status: DiffFileStatus },
): Promise<string> {
	if (file.status === "untracked") return asAddedFileDiff(pi, cwd, file.path);

	if (await repositoryHasHead(pi, cwd)) {
		const againstHead = await pi.exec("git", ["diff", "--no-color", "HEAD", "--", file.path], { cwd });
		if (againstHead.code === 0 && (againstHead.stdout ?? "").trim()) return (againstHead.stdout ?? "").trim();
	}

	const working = await pi.exec("git", ["diff", "--no-color", "--", file.path], { cwd });
	const staged = await pi.exec("git", ["diff", "--cached", "--no-color", "--", file.path], { cwd });
	if (working.code === 0 && (working.stdout ?? "").trim()) return (working.stdout ?? "").trim();
	if (staged.code === 0 && (staged.stdout ?? "").trim()) return (staged.stdout ?? "").trim();

	if (file.status === "added") return asAddedFileDiff(pi, cwd, file.path);
	return "(no diff available)";
}

async function commitFileDiff(pi: ExtensionAPI, cwd: string, commitHash: string, file: CommitFile): Promise<string> {
	if (commitHash === UNCOMMITTED_HASH) {
		return workingTreeFileDiff(pi, cwd, file);
	}
	const r = await pi.exec("git", ["show", "--no-color", "--format=", commitHash, "--", file.path], { cwd });
	if (r.code === 0 && (r.stdout ?? "").trim()) return (r.stdout ?? "").trim();
	return "(no diff available)";
}

async function fileDiff(
	pi: ExtensionAPI,
	cwd: string,
	file: DiffFile,
	scope: OverlayDiffScope,
	mergeBase: string | null,
): Promise<string> {
	if (scope === "working") return workingTreeFileDiff(pi, cwd, file);

	if (scope === "last-commit") {
		if (!(await repositoryHasHead(pi, cwd))) return "(no commit available)";
		const r = await pi.exec("git", ["show", "--no-color", "--format=", "HEAD", "--", file.path], { cwd });
		if (r.code === 0 && (r.stdout ?? "").trim()) return (r.stdout ?? "").trim();
		return "(no diff available)";
	}

	if (file.status === "untracked") return asAddedFileDiff(pi, cwd, file.path);

	if (mergeBase) {
		const r = await pi.exec("git", ["diff", "--no-color", mergeBase, "--", file.path], { cwd });
		if (r.code === 0 && (r.stdout ?? "").trim()) return (r.stdout ?? "").trim();
	}

	return workingTreeFileDiff(pi, cwd, file);
}

// ─── Rendering helpers ─────────────────────────────────────────────────────

function icon(s: DiffFileStatus): string {
	if (s === "added" || s === "untracked") return "+";
	if (s === "deleted") return "-";
	if (s === "renamed") return "→";
	if (s === "copied") return "©";
	return "~";
}

function statusColor(s: DiffFileStatus): ThemeColor {
	if (s === "added" || s === "untracked") return "success";
	if (s === "deleted") return "error";
	return "warning";
}

function commitStateColor(state: CommitState): ThemeColor {
	if (state === "both") return "accent";
	if (state === "committed") return "success";
	return "warning";
}

function expandTabs(s: string, tabSize = 4): string {
	return s.replace(/\t/g, " ".repeat(tabSize));
}

function colorDiffLine(t: Theme, line: string): string {
	if (line.startsWith("+++") || line.startsWith("---")) return t.fg("muted", line);
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

function shouldHideDiffMetaLine(line: ReturnType<typeof parseDiffLines>[number] | undefined): boolean {
	if (!line || line.category !== "meta") return false;
	return !line.originalLine.startsWith("\\");
}

function buildRenderedDiffLines(
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

function countRenderedDiffLines(
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

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: tree row rendering keeps selection and styling logic in one place for overlay consistency.
function renderFiles(t: Theme, st: DiffState, w: number, h: number): string[] {
	const visibleRows = getVisibleRows(st);
	if (visibleRows.length === 0) {
		return [t.fg("muted", st.searchQuery ? ` (no files match: ${st.searchQuery})` : " (no changes)")];
	}

	const active = st.focus === "left";
	const max = Math.max(1, h);

	st.selectedIndex = clamp(st.selectedIndex, 0, Math.max(0, visibleRows.length - 1));
	if (st.selectedIndex < st.fileScrollOffset) st.fileScrollOffset = st.selectedIndex;
	if (st.selectedIndex >= st.fileScrollOffset + max) st.fileScrollOffset = st.selectedIndex - max + 1;

	const start = st.fileScrollOffset;
	const end = Math.min(visibleRows.length, start + max);
	const lines: string[] = [];

	const fileByPath = new Map(st.files.map((f) => [f.path, f]));

	for (let i = start; i < end; i++) {
		const row = visibleRows[i];
		const sel = i === st.selectedIndex;
		const indent = " ".repeat(row.depth * 2);
		const cursor = sel ? (active ? t.fg("accent", "▶") : t.fg("muted", "▸")) : " ";

		if (row.type === "dir") {
			const fold = row.expanded ? "▾" : "▸";
			const foldColored = row.expanded ? t.fg("accent", fold) : t.fg("dim", fold);
			const prefix = `${cursor} ${indent}${foldColored} `;
			const nameW = Math.max(4, w - visibleWidth(prefix) - 1);
			const dirName =
				sel && active
					? t.fg("accent", t.bold(truncateToWidth(`${row.name}/`, nameW)))
					: sel
						? t.fg("muted", truncateToWidth(`${row.name}/`, nameW))
						: t.fg("muted", truncateToWidth(`${row.name}/`, nameW));
			lines.push(truncateToWidth(`${prefix}${dirName}`, w));
		} else {
			const file = fileByPath.get(row.fullPath);
			const reviewCount = file ? st.reviewDrafts.filter((draft) => draft.filePath === file.path).length : 0;
			const reviewMark = reviewCount > 0 ? t.fg("accent", String(reviewCount)) : t.fg("dim", "·");
			const ic = file ? t.fg(statusColor(file.status), icon(file.status)) : " ";
			const badge = file ? t.fg(commitStateColor(file.commitState), `[${commitStateBadge(file.commitState)}]`) : "";
			const prefix = `${cursor} ${indent}${reviewMark} ${ic} ${badge} `;
			const nameW = Math.max(4, w - visibleWidth(prefix));
			const fileName = file ? fileTreeLabel(file, row.name) : row.name;

			let label: string;
			if (sel && active) {
				label = t.fg("accent", truncateToWidth(fileName, nameW));
			} else if (sel) {
				label = t.fg("muted", truncateToWidth(fileName, nameW));
			} else {
				label = t.fg("text", truncateToWidth(fileName, nameW));
			}
			lines.push(truncateToWidth(`${prefix}${label}`, w));
		}
	}

	if (visibleRows.length > max) {
		const info = t.fg("dim", ` ${start + 1}–${end}/${visibleRows.length}`);
		while (lines.length < max) lines.push("");
		lines[max - 1] = info;
	}

	while (lines.length < max) lines.push("");
	return lines;
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: commit row rendering intentionally mirrors diff-pane selection semantics.
function renderCommits(t: Theme, st: DiffState, w: number, h: number): string[] {
	if (st.commits.length === 0) return [t.fg("muted", " (no commits in branch scope)")];

	const active = st.focus === "left";
	const max = Math.max(1, h);
	st.commitSelectedIndex = clamp(st.commitSelectedIndex, 0, Math.max(0, st.commits.length - 1));

	if (st.commitSelectedIndex < st.commitScrollOffset) st.commitScrollOffset = st.commitSelectedIndex;
	if (st.commitSelectedIndex >= st.commitScrollOffset + max) st.commitScrollOffset = st.commitSelectedIndex - max + 1;

	const start = st.commitScrollOffset;
	const end = Math.min(st.commits.length, start + max);
	const lines: string[] = [];

	for (let i = start; i < end; i++) {
		const c = st.commits[i];
		const sel = i === st.commitSelectedIndex;
		const cursor = sel ? (active ? t.fg("accent", "▶") : t.fg("muted", "▸")) : " ";
		const isUncommitted = c.hash === UNCOMMITTED_HASH;

		if (isUncommitted) {
			const marker = t.fg(sel && active ? "accent" : "warning", "●●●");
			const prefix = `${cursor} ${marker} `;
			const subjectW = Math.max(4, w - visibleWidth(prefix));
			const subject =
				sel && active
					? t.fg("accent", truncateToWidth(c.subject, subjectW))
					: t.fg("warning", truncateToWidth(c.subject, subjectW));
			lines.push(truncateToWidth(`${prefix}${subject}`, w));
		} else {
			const hash = t.fg(sel && active ? "accent" : "muted", c.shortHash);
			const prefix = `${cursor} ${hash} `;
			const subjectW = Math.max(4, w - visibleWidth(prefix));
			const subject =
				sel && active
					? t.fg("accent", truncateToWidth(c.subject, subjectW))
					: t.fg("text", truncateToWidth(c.subject, subjectW));
			lines.push(truncateToWidth(`${prefix}${subject}`, w));
		}
	}

	if (st.commits.length > max) {
		const info = t.fg("dim", ` ${start + 1}–${end}/${st.commits.length}`);
		while (lines.length < max) lines.push("");
		lines[max - 1] = info;
	}

	while (lines.length < max) lines.push("");
	return lines;
}

function renderDiff(t: Theme, st: DiffState, w: number, h: number): string[] {
	if (st.files.length === 0) return [t.fg("muted", "  No changes")];

	const f = findFileByPath(st, st.selectedFilePath);
	if (!f) return [t.fg("muted", "  Select a file to view diff")];

	const diffKey = scopedDiffKey(st.scope, f.path);
	const raw = st.diffCache.get(diffKey);
	if (raw === undefined) return [t.fg("muted", "  Loading…")];

	// Build syntax-highlighted lines on first render (lazy, cached)
	if (!st.highlightedDiffCache.has(diffKey)) {
		st.highlightedDiffCache.set(diffKey, buildHighlightedDiff(raw, f.path, t));
	}
	const all = st.highlightedDiffCache.get(diffKey);
	if (!all || all.length === 0) return [t.fg("muted", "  (empty diff)")];
	const parsed = parseDiffLines(raw);

	const rendered = buildRenderedDiffLines(t, all, parsed, w, st.wrapLines, st.changedOnly);
	if (rendered.length === 0) return [t.fg("muted", "  (all context hidden by filter)")];

	const max = Math.max(1, h);
	const maxOffset = Math.max(0, rendered.length - max);
	if (st.diffScrollOffset > maxOffset) st.diffScrollOffset = maxOffset;

	const start = st.diffScrollOffset;
	const end = Math.min(rendered.length, start + max);

	const lines: string[] = [];
	for (let i = start; i < end; i++) {
		const line = rendered[i];
		if (!line) continue;
		if (line.category === "added") {
			lines.push(t.bg("toolSuccessBg", line.text));
		} else if (line.category === "removed") {
			lines.push(t.bg("toolErrorBg", line.text));
		} else {
			lines.push(line.text);
		}
	}

	while (lines.length < max) lines.push("");

	if (rendered.length > max) {
		const pct = maxOffset > 0 ? Math.round((st.diffScrollOffset / maxOffset) * 100) : 0;
		const indicator = t.fg("dim", `${pct}% (${start + 1}–${end}/${rendered.length})`);
		lines[max - 1] = truncateToWidth(` ${indicator}`, w);
	}

	return lines;
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: commit file pane interleaves fold state and inline diff rows for TUI rendering.
function renderCommitFiles(t: Theme, st: DiffState, w: number, h: number): string[] {
	const selectedCommit = st.commits[st.commitSelectedIndex];
	if (!selectedCommit) return [t.fg("muted", "  (no commit selected)")];

	const commitHash = selectedCommit.hash;
	const files = st.commitFilesCache.get(commitHash);
	if (!files) {
		return [
			t.fg(
				"muted",
				st.commitFilesLoading.has(commitHash) ? "  Loading changed files…" : "  (press Enter to load files)",
			),
		];
	}
	if (files.length === 0) return [t.fg("muted", "  (no changed files)")];

	st.commitFileSelectedIndex = clamp(st.commitFileSelectedIndex, 0, Math.max(0, files.length - 1));
	const expanded = st.commitExpandedByHash.get(commitHash) ?? new Set<string>();
	const active = st.focus === "right";

	const rows: string[] = [];
	const fileLineStart: number[] = [];

	for (let i = 0; i < files.length; i++) {
		const file = files[i];
		const selected = i === st.commitFileSelectedIndex;
		fileLineStart[i] = rows.length;

		const cursor = selected ? (active ? t.fg("accent", "▶") : t.fg("muted", "▸")) : " ";
		const fold = expanded.has(file.path) ? t.fg("accent", "▾") : t.fg("dim", "▸");
		const ic = t.fg(statusColor(file.status), icon(file.status));
		const prefix = `${cursor} ${fold} ${ic} `;
		const nameW = Math.max(4, w - visibleWidth(prefix));

		const fileName = truncateToWidth(fileDisplayPath(file), nameW);
		const label = selected ? (active ? t.fg("accent", fileName) : t.fg("muted", fileName)) : t.fg("text", fileName);
		rows.push(truncateToWidth(`${prefix}${label}`, w));

		if (!expanded.has(file.path)) continue;

		const diffKey = commitDiffKey(commitHash, file.path);
		const raw = st.commitFileDiffCache.get(diffKey);
		if (raw === undefined) {
			const loading = st.commitFileDiffLoading.has(diffKey) ? "    Loading diff…" : "    (no diff loaded)";
			rows.push(t.fg("muted", truncateToWidth(loading, w)));
			continue;
		}

		const diffLines = raw.split("\n");
		if (diffLines.length === 0) {
			rows.push(t.fg("muted", "    (empty diff)"));
			continue;
		}

		for (const line of diffLines) {
			const renderedLine = padStyledLine(`    ${colorDiffLine(t, expandTabs(line))}`, w);
			if (line.startsWith("+") && !line.startsWith("+++")) {
				rows.push(t.bg("toolSuccessBg", renderedLine));
			} else if (line.startsWith("-") && !line.startsWith("---")) {
				rows.push(t.bg("toolErrorBg", renderedLine));
			} else {
				rows.push(renderedLine);
			}
		}
	}

	const max = Math.max(1, h);
	const selectedLine = fileLineStart[st.commitFileSelectedIndex] ?? 0;
	if (!st.commitFileManualScroll) {
		if (selectedLine < st.commitFileScrollOffset) st.commitFileScrollOffset = selectedLine;
		if (selectedLine >= st.commitFileScrollOffset + max) st.commitFileScrollOffset = selectedLine - max + 1;
	}

	const maxOffset = Math.max(0, rows.length - max);
	if (st.commitFileScrollOffset < 0) st.commitFileScrollOffset = 0;
	if (st.commitFileScrollOffset > maxOffset) st.commitFileScrollOffset = maxOffset;

	const start = st.commitFileScrollOffset;
	const end = Math.min(rows.length, start + max);
	const visible = rows.slice(start, end);

	while (visible.length < max) visible.push("");
	if (rows.length > max) {
		const info = t.fg("dim", ` ${start + 1}–${end}/${rows.length}`);
		visible[max - 1] = info;
	}

	return visible;
}

// ─── Overlay controller ────────────────────────────────────────────────────

class DiffOverlay {
	private st: DiffState;
	private pi: ExtensionAPI;
	private cwd: string;
	private done: (reviewPrompt?: string) => void;
	private diffLoading = false;
	private lastRightWidth = 80;

	constructor(pi: ExtensionAPI, cwd: string, st: DiffState, done: (reviewPrompt?: string) => void) {
		this.pi = pi;
		this.cwd = cwd;
		this.st = st;
		this.done = done;
	}

	private selectedDiffFile(): DiffFile | null {
		return findFileByPath(this.st, this.st.selectedFilePath);
	}

	private selectDiffFile(filePath: string | null, tui: Tui): void {
		saveDiffScroll(this.st);
		this.st.selectedFilePath = filePath;
		this.st.selectedFilePathByScope[this.st.scope] = filePath;
		restoreDiffScroll(this.st);
		void this.ensureDiff(tui);
	}

	private applyScopeAndFilter(tui: Tui): void {
		applyScopeFiles(this.st);
		void this.ensureDiff(tui);
	}

	private openReviewDraftInput(): void {
		if (!this.selectedDiffFile()) {
			this.st.error = "Select a file before adding review feedback";
			return;
		}
		this.st.reviewInput = { active: true, buffer: "", error: null };
	}

	private submitReviewDraft(): void {
		const file = this.selectedDiffFile();
		if (!file) {
			this.st.reviewInput.error = "No file selected";
			return;
		}
		const prompt = this.st.reviewInput.buffer.trim();
		if (!prompt) {
			this.st.reviewInput.error = "Review message cannot be empty";
			return;
		}
		this.st.reviewDrafts.push({
			scope: this.st.scope,
			filePath: file.path,
			fileDisplayPath: fileDisplayPath(file),
			prompt,
		});
		this.st.reviewInput = { active: false, buffer: "", error: null };
		this.st.error = null;
	}

	private closeReviewDraftInput(): void {
		this.st.reviewInput = { active: false, buffer: "", error: null };
	}

	private closeOverlay(): void {
		const reviewPrompt = buildReviewTransferPrompt(this.st.reviewDrafts);
		this.done(reviewPrompt || undefined);
	}

	private switchScope(nextScope: OverlayDiffScope, tui: Tui): void {
		if (nextScope === this.st.scope) return;
		saveDiffScroll(this.st);
		this.st.scope = nextScope;
		this.st.searchMode = false;
		this.st.diffCache.clear();
		this.st.highlightedDiffCache.clear();
		this.applyScopeAndFilter(tui);
	}

	private selectedCommit(): BranchCommitEntry | null {
		if (this.st.commits.length === 0) return null;
		this.st.commitSelectedIndex = clamp(this.st.commitSelectedIndex, 0, this.st.commits.length - 1);
		return this.st.commits[this.st.commitSelectedIndex] ?? null;
	}

	private selectedCommitFile(): CommitFile | null {
		const commit = this.selectedCommit();
		if (!commit) return null;
		const files = this.st.commitFilesCache.get(commit.hash);
		if (!files || files.length === 0) return null;
		this.st.commitFileSelectedIndex = clamp(this.st.commitFileSelectedIndex, 0, files.length - 1);
		return files[this.st.commitFileSelectedIndex] ?? null;
	}

	private expandedSet(commitHash: string): Set<string> {
		let set = this.st.commitExpandedByHash.get(commitHash);
		if (!set) {
			set = new Set<string>();
			this.st.commitExpandedByHash.set(commitHash, set);
		}
		return set;
	}

	private resetCommitFilesPanel(): void {
		this.st.commitFileSelectedIndex = 0;
		this.st.commitFileScrollOffset = 0;
		this.st.commitFileManualScroll = false;
	}

	private async ensureDiff(tui: Tui): Promise<void> {
		const f = this.selectedDiffFile();
		if (!f) return;
		const key = scopedDiffKey(this.st.scope, f.path);
		if (this.st.diffCache.has(key) || this.diffLoading) return;
		this.diffLoading = true;
		try {
			this.st.diffCache.set(key, await fileDiff(this.pi, this.cwd, f, this.st.scope, this.st.mergeBase));
		} finally {
			this.diffLoading = false;
		}
		tui.requestRender();
		const current = this.selectedDiffFile();
		if (current) {
			const currentKey = scopedDiffKey(this.st.scope, current.path);
			if (!this.st.diffCache.has(currentKey)) {
				void this.ensureDiff(tui);
			}
		}
	}

	private async ensureCommitFiles(tui: Tui): Promise<void> {
		const commit = this.selectedCommit();
		if (!commit) return;
		if (this.st.commitFilesCache.has(commit.hash) || this.st.commitFilesLoading.has(commit.hash)) return;

		this.st.commitFilesLoading.add(commit.hash);
		tui.requestRender();
		try {
			if (commit.hash === UNCOMMITTED_HASH) {
				const wtFiles = await workingTreeFiles(this.pi, this.cwd);
				this.st.commitFilesCache.set(
					UNCOMMITTED_HASH,
					wtFiles.map((f) => ({
						path: f.path,
						status: f.status,
						rawStatus: f.rawStatus,
						previousPath: f.previousPath ?? null,
					})),
				);
			} else {
				const files = await commitFilesForHash(this.pi, this.cwd, commit.hash);
				this.st.commitFilesCache.set(commit.hash, files);
			}
		} finally {
			this.st.commitFilesLoading.delete(commit.hash);
		}
		tui.requestRender();
	}

	private async ensureCommitFileDiff(commitHash: string, file: CommitFile, tui: Tui): Promise<void> {
		const key = commitDiffKey(commitHash, file.path);
		if (this.st.commitFileDiffCache.has(key) || this.st.commitFileDiffLoading.has(key)) return;
		this.st.commitFileDiffLoading.add(key);
		tui.requestRender();
		try {
			const raw = await commitFileDiff(this.pi, this.cwd, commitHash, file);
			this.st.commitFileDiffCache.set(key, raw);
		} finally {
			this.st.commitFileDiffLoading.delete(key);
		}
		tui.requestRender();
	}

	private async openPath(targetPath: string): Promise<void> {
		const filePath = path.isAbsolute(targetPath) ? targetPath : path.resolve(this.cwd, targetPath);
		const command = process.platform === "darwin" ? "open" : "xdg-open";
		const r = await this.pi.exec(command, [filePath], { cwd: this.cwd });
		this.st.error = r.code === 0 ? null : r.stderr?.trim() || `Failed to open ${targetPath}`;
	}

	private async revealPath(targetPath: string): Promise<void> {
		const filePath = path.isAbsolute(targetPath) ? targetPath : path.resolve(this.cwd, targetPath);
		const command = process.platform === "darwin" ? "open" : "xdg-open";
		const args = process.platform === "darwin" ? ["-R", filePath] : [path.dirname(filePath)];
		const r = await this.pi.exec(command, args, { cwd: this.cwd });
		this.st.error = r.code === 0 ? null : r.stderr?.trim() || `Failed to reveal ${targetPath}`;
	}

	private async refreshFiles(tui: Tui): Promise<void> {
		const data = await loadOverlayData(this.pi, this.cwd, this.st.mergeBase);
		this.st.filesByScope = data.filesByScope;
		this.st.commits = data.commits;
		this.st.diffCache.clear();
		this.st.highlightedDiffCache.clear();
		this.st.commitFilesCache.clear();
		this.st.commitFileDiffCache.clear();
		this.st.commitExpandedByHash.clear();
		this.applyScopeAndFilter(tui);
		if (data.uncommittedFiles.length > 0) {
			this.st.commits.unshift({
				hash: UNCOMMITTED_HASH,
				shortHash: "•••",
				author: "",
				relativeDate: "now",
				subject: `Uncommitted Changes (${data.uncommittedFiles.length} file${data.uncommittedFiles.length !== 1 ? "s" : ""})`,
			});
			this.st.commitFilesCache.set(
				UNCOMMITTED_HASH,
				data.uncommittedFiles.map((f) => ({
					path: f.path,
					status: f.status,
					rawStatus: f.rawStatus,
					previousPath: f.previousPath ?? null,
				})),
			);
		}
		if (this.st.files.length === 0) {
			this.st.selectedIndex = 0;
			this.st.fileScrollOffset = 0;
			this.st.diffScrollOffset = 0;
			this.st.selectedFilePath = null;
			this.st.focus = "left";
		}
	}

	private async stashChanges(tui: Tui): Promise<void> {
		const r = await this.pi.exec("git", ["stash", "push", "-u"], { cwd: this.cwd });
		if (r.code !== 0) {
			this.st.error = r.stderr?.trim() || "Failed to stash changes";
			return;
		}

		this.st.error = null;
		await this.refreshFiles(tui);
		if (this.st.viewMode === "diff") void this.ensureDiff(tui);
	}

	private selectCommit(nextIndex: number, tui: Tui): void {
		if (this.st.commits.length === 0) return;
		const clamped = clamp(nextIndex, 0, this.st.commits.length - 1);
		if (clamped === this.st.commitSelectedIndex) return;
		this.st.commitSelectedIndex = clamped;
		this.resetCommitFilesPanel();
		void this.ensureCommitFiles(tui);
	}

	/** After navigating in the tree, update selectedFilePath if on a file row. */
	private syncSelectedFile(tui: Tui): void {
		const rows = getVisibleRows(this.st);
		const row = rows[this.st.selectedIndex];
		if (row?.type === "file") {
			this.selectDiffFile(row.fullPath, tui);
		}
	}

	// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: keyboard routing is stateful and kept flat to preserve exact overlay behavior.
	private handleDiffModeInput(data: string, tui: Tui): void {
		const st = this.st;

		if (st.reviewInput.active) {
			if (matchesKey(data, Key.escape)) {
				this.closeReviewDraftInput();
				tui.requestRender();
				return;
			}
			if (matchesKey(data, Key.enter)) {
				this.submitReviewDraft();
				tui.requestRender();
				return;
			}
			if (matchesKey(data, Key.backspace)) {
				st.reviewInput.buffer = st.reviewInput.buffer.slice(0, -1);
				st.reviewInput.error = null;
				tui.requestRender();
				return;
			}
			if (data.length === 1 && data >= " " && data !== "\u007f") {
				st.reviewInput.buffer += data;
				st.reviewInput.error = null;
				tui.requestRender();
			}
			return;
		}

		if (st.searchMode) {
			if (matchesKey(data, Key.escape) || matchesKey(data, Key.enter)) {
				st.searchMode = false;
				tui.requestRender();
				return;
			}
			if (matchesKey(data, Key.backspace)) {
				st.searchQuery = st.searchQuery.slice(0, -1);
				this.applyScopeAndFilter(tui);
				tui.requestRender();
				return;
			}
			if (data.length === 1 && data >= " " && data !== "\u007f") {
				st.searchQuery += data;
				this.applyScopeAndFilter(tui);
				tui.requestRender();
			}
			return;
		}

		const rows = getVisibleRows(st);
		const n = rows.length;
		const currentRow = rows[st.selectedIndex];
		const f = this.selectedDiffFile();

		if (data === "/") {
			st.searchMode = true;
			tui.requestRender();
			return;
		}
		if (data === "s") {
			this.switchScope(cycleOverlayDiffScope(st.scope), tui);
			tui.requestRender();
			return;
		}
		if (data === "w") {
			st.wrapLines = !st.wrapLines;
			tui.requestRender();
			return;
		}
		if (data === "c") {
			st.changedOnly = !st.changedOnly;
			tui.requestRender();
			return;
		}
		if (data === "r") {
			this.openReviewDraftInput();
			tui.requestRender();
			return;
		}

		if (st.focus === "left") {
			if (matchesKey(data, Key.escape)) {
				this.closeOverlay();
				return;
			}
			if (matchesKey(data, Key.up) || data === "k") {
				if (st.selectedIndex > 0) {
					st.selectedIndex -= 1;
					this.syncSelectedFile(tui);
				}
			} else if (matchesKey(data, Key.down) || data === "j") {
				if (st.selectedIndex < n - 1) {
					st.selectedIndex += 1;
					this.syncSelectedFile(tui);
				}
			} else if (data === "g") {
				st.selectedIndex = 0;
				this.syncSelectedFile(tui);
			} else if (data === "G") {
				st.selectedIndex = Math.max(0, n - 1);
				this.syncSelectedFile(tui);
			} else if (matchesKey(data, Key.enter)) {
				if (currentRow?.type === "dir") {
					if (st.expandedDirs.has(currentRow.fullPath)) st.expandedDirs.delete(currentRow.fullPath);
					else st.expandedDirs.add(currentRow.fullPath);
				} else if (currentRow?.type === "file") {
					this.selectDiffFile(currentRow.fullPath, tui);
					st.focus = "right";
				}
			} else if (data === "o" && f) {
				void this.openPath(f.path).then(() => tui.requestRender());
			} else if (data === "f" && f) {
				void this.revealPath(f.path).then(() => tui.requestRender());
			}

			tui.requestRender();
			return;
		}

		if (matchesKey(data, Key.escape)) {
			saveDiffScroll(st);
			st.focus = "left";
			tui.requestRender();
			return;
		}

		const raw = f ? (st.diffCache.get(scopedDiffKey(st.scope, f.path)) ?? "") : "";
		const parsed = parseDiffLines(raw);
		const highlighted = f ? (st.highlightedDiffCache.get(scopedDiffKey(st.scope, f.path)) ?? raw.split("\n")) : [];
		const diffLen = countRenderedDiffLines(
			highlighted,
			parsed,
			Math.max(1, this.lastRightWidth),
			st.wrapLines,
			st.changedOnly,
		);
		if (matchesKey(data, Key.up) || data === "k") {
			st.diffScrollOffset = Math.max(0, st.diffScrollOffset - 1);
		} else if (matchesKey(data, Key.down) || data === "j") {
			st.diffScrollOffset = Math.min(st.diffScrollOffset + 1, Math.max(0, diffLen - 3));
		} else if (matchesKey(data, Key.pageUp) || matchesKey(data, Key.ctrl("u"))) {
			st.diffScrollOffset = Math.max(0, st.diffScrollOffset - 20);
		} else if (matchesKey(data, Key.pageDown) || matchesKey(data, Key.ctrl("d"))) {
			st.diffScrollOffset = Math.min(st.diffScrollOffset + 20, Math.max(0, diffLen - 3));
		} else if (data === "g") {
			st.diffScrollOffset = 0;
		} else if (data === "G") {
			st.diffScrollOffset = Math.max(0, diffLen - 3);
		} else if (matchesKey(data, Key.left)) {
			saveDiffScroll(st);
			st.focus = "left";
		} else if (data === "o" && f) {
			void this.openPath(f.path).then(() => tui.requestRender());
		} else if (data === "f" && f) {
			void this.revealPath(f.path).then(() => tui.requestRender());
		}

		saveDiffScroll(st);
		tui.requestRender();
	}

	// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: commit-mode navigation combines selection and viewport rules for predictable arrow-key behavior.
	private handleCommitModeInput(data: string, tui: Tui): void {
		const st = this.st;

		if (st.focus === "left") {
			if (matchesKey(data, Key.escape)) {
				this.closeOverlay();
				return;
			}

			if (matchesKey(data, Key.up) || data === "k") {
				this.selectCommit(st.commitSelectedIndex - 1, tui);
			} else if (matchesKey(data, Key.down) || data === "j") {
				this.selectCommit(st.commitSelectedIndex + 1, tui);
			} else if (matchesKey(data, Key.pageUp) || matchesKey(data, Key.ctrl("u"))) {
				this.selectCommit(st.commitSelectedIndex - 10, tui);
			} else if (matchesKey(data, Key.pageDown) || matchesKey(data, Key.ctrl("d"))) {
				this.selectCommit(st.commitSelectedIndex + 10, tui);
			} else if (data === "g") {
				this.selectCommit(0, tui);
			} else if (data === "G") {
				this.selectCommit(Math.max(0, st.commits.length - 1), tui);
			} else if (matchesKey(data, Key.enter)) {
				st.focus = "right";
				this.resetCommitFilesPanel();
				void this.ensureCommitFiles(tui);
			}

			tui.requestRender();
			return;
		}

		if (matchesKey(data, Key.escape) || matchesKey(data, Key.left)) {
			st.focus = "left";
			tui.requestRender();
			return;
		}

		const commit = this.selectedCommit();
		if (!commit) {
			tui.requestRender();
			return;
		}

		void this.ensureCommitFiles(tui);
		const files = st.commitFilesCache.get(commit.hash);
		if (!files || files.length === 0) {
			tui.requestRender();
			return;
		}

		const maxIndex = files.length - 1;
		st.commitFileSelectedIndex = clamp(st.commitFileSelectedIndex, 0, maxIndex);
		const selectedIndex = st.commitFileSelectedIndex;
		const selectedFile = files[selectedIndex];
		const expanded = this.expandedSet(commit.hash);
		const selectedExpanded = Boolean(selectedFile && expanded.has(selectedFile.path));

		const contentH = overlayContentHeight(tui.terminal?.rows ?? 40);
		const rowsMeta = buildCommitRowsMeta(files, commit.hash, expanded, st.commitFileDiffCache);
		const maxOffset = Math.max(0, rowsMeta.totalRows - contentH);
		st.commitFileScrollOffset = clamp(st.commitFileScrollOffset, 0, maxOffset);
		const viewportStart = st.commitFileScrollOffset;
		const viewportEnd = viewportStart + contentH - 1;

		const prevIndex = selectedIndex - 1;
		const nextIndex = selectedIndex + 1;
		const prevStart = prevIndex >= 0 ? (rowsMeta.fileStarts[prevIndex] ?? 0) : -1;
		const nextStart =
			nextIndex <= maxIndex ? (rowsMeta.fileStarts[nextIndex] ?? rowsMeta.totalRows) : rowsMeta.totalRows;
		const selectedStart = rowsMeta.fileStarts[selectedIndex] ?? 0;
		const selectedEnd = rowsMeta.fileEnds[selectedIndex] ?? selectedStart;

		const shouldArrowUpScroll =
			selectedExpanded &&
			st.commitFileScrollOffset > 0 &&
			((prevIndex >= 0 && prevStart < viewportStart) || (prevIndex < 0 && selectedStart < viewportStart));
		const shouldArrowDownScroll =
			selectedExpanded &&
			st.commitFileScrollOffset < maxOffset &&
			((nextIndex <= maxIndex && nextStart > viewportEnd) || (nextIndex > maxIndex && selectedEnd > viewportEnd));

		if (matchesKey(data, Key.up)) {
			if (shouldArrowUpScroll) {
				st.commitFileScrollOffset = Math.max(0, st.commitFileScrollOffset - 1);
				st.commitFileManualScroll = true;
			} else {
				st.commitFileSelectedIndex = clamp(selectedIndex - 1, 0, maxIndex);
				st.commitFileManualScroll = false;
			}
		} else if (matchesKey(data, Key.down)) {
			if (shouldArrowDownScroll) {
				st.commitFileScrollOffset = Math.min(maxOffset, st.commitFileScrollOffset + 1);
				st.commitFileManualScroll = true;
			} else {
				st.commitFileSelectedIndex = clamp(selectedIndex + 1, 0, maxIndex);
				st.commitFileManualScroll = false;
			}
		} else if (data === "k") {
			st.commitFileSelectedIndex = clamp(selectedIndex - 1, 0, maxIndex);
			st.commitFileManualScroll = false;
		} else if (data === "j") {
			st.commitFileSelectedIndex = clamp(selectedIndex + 1, 0, maxIndex);
			st.commitFileManualScroll = false;
		} else if (matchesKey(data, Key.pageUp) || matchesKey(data, Key.ctrl("u"))) {
			st.commitFileScrollOffset = Math.max(0, st.commitFileScrollOffset - 20);
			st.commitFileManualScroll = true;
		} else if (matchesKey(data, Key.pageDown) || matchesKey(data, Key.ctrl("d"))) {
			st.commitFileScrollOffset = Math.min(maxOffset, st.commitFileScrollOffset + 20);
			st.commitFileManualScroll = true;
		} else if (data === "g") {
			st.commitFileSelectedIndex = 0;
			st.commitFileManualScroll = false;
		} else if (data === "G") {
			st.commitFileSelectedIndex = maxIndex;
			st.commitFileManualScroll = false;
		} else if (matchesKey(data, Key.enter)) {
			const file = files[st.commitFileSelectedIndex];
			if (file) {
				if (expanded.has(file.path)) {
					expanded.delete(file.path);
				} else {
					expanded.add(file.path);
					void this.ensureCommitFileDiff(commit.hash, file, tui);
				}
				st.commitFileManualScroll = false;
			}
		} else if (data === "o") {
			const file = this.selectedCommitFile();
			if (file) void this.openPath(file.path).then(() => tui.requestRender());
		} else if (data === "f") {
			const file = this.selectedCommitFile();
			if (file) void this.revealPath(file.path).then(() => tui.requestRender());
		}

		tui.requestRender();
	}

	handleInput(data: string, tui: Tui): void {
		if (data === "q" && !this.st.searchMode && !this.st.reviewInput.active) {
			this.closeOverlay();
			return;
		}

		if (this.st.viewMode === "diff" && (this.st.searchMode || this.st.reviewInput.active)) {
			this.handleDiffModeInput(data, tui);
			return;
		}

		if (data === "S") {
			void this.stashChanges(tui).then(() => tui.requestRender());
			return;
		}

		if (matchesKey(data, Key.tab) || data === "v") {
			this.st.viewMode = toggleOverlayViewMode(this.st.viewMode);
			this.st.focus = "left";
			if (this.st.viewMode === "diff") {
				void this.ensureDiff(tui);
			} else {
				this.resetCommitFilesPanel();
				void this.ensureCommitFiles(tui);
			}
			tui.requestRender();
			return;
		}

		if (this.st.viewMode === "diff") this.handleDiffModeInput(data, tui);
		else this.handleCommitModeInput(data, tui);
	}

	// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: frame rendering composes multiple panes and headers in one pass for width-aware alignment.
	render(w: number, h: number, t: Theme): string[] {
		const st = this.st;

		const header: string[] = [];
		header.push(...new DynamicBorder((s: string) => t.fg("accent", s)).render(w));

		const branch = st.branch ? t.fg("muted", st.branch) : t.fg("dim", "(detached)");
		const baseInfo = st.baseBranch ? ` ${t.fg("dim", "vs")} ${t.fg("muted", st.baseBranch)}` : "";
		const scopeFileCount = st.filesByScope[st.scope].length;
		const fileCnt = t.fg(
			"muted",
			st.searchQuery
				? `${st.files.length}/${scopeFileCount} file${scopeFileCount !== 1 ? "s" : ""}`
				: `${scopeFileCount} file${scopeFileCount !== 1 ? "s" : ""}`,
		);
		const commitCnt = t.fg("muted", `${st.commits.length} commit${st.commits.length !== 1 ? "s" : ""}`);
		const mode = st.viewMode === "diff" ? t.fg("accent", "diff") : t.fg("accent", "commit");
		header.push(
			`  ${t.fg("accent", t.bold("DIFF"))} ${t.fg("dim", "|")} ${branch}${baseInfo} ${t.fg("dim", "·")} ${fileCnt} ${t.fg("dim", "·")} ${commitCnt} ${t.fg("dim", "·")} mode:${mode}`,
		);
		header.push(
			`  ${t.fg("dim", "scope:")}${t.fg("muted", scopeLabel(st.scope))} ${t.fg("dim", "· filter:")}${t.fg(st.searchMode ? "accent" : "muted", st.searchQuery || "-")} ${t.fg("dim", "· wrap:")}${t.fg(st.wrapLines ? "success" : "muted", st.wrapLines ? "on" : "off")} ${t.fg("dim", "· changed-only:")}${t.fg(st.changedOnly ? "success" : "muted", st.changedOnly ? "on" : "off")} ${t.fg("dim", "· reviews:")}${t.fg(st.reviewDrafts.length > 0 ? "accent" : "muted", String(st.reviewDrafts.length))}`,
		);

		const footer: string[] = [];
		if (st.reviewInput.active) {
			footer.push(
				truncateToWidth(
					`  ${t.fg("accent", "review>")} ${st.reviewInput.buffer || t.fg("dim", "type review message (line numbers go here too)")}`,
					w,
				),
			);
			footer.push(st.reviewInput.error ? t.fg("error", `  ${st.reviewInput.error}`) : "");
		} else {
			footer.push(st.error ? t.fg("error", `  ${st.error}`) : "");
		}

		const hint =
			st.viewMode === "diff"
				? st.reviewInput.active
					? `  Review draft · type message · Enter save · Esc cancel`
					: st.searchMode
						? "  Search mode · type to filter · Backspace delete · Enter/Esc close"
						: st.focus === "left"
							? "  ↑/↓ Select File  ·  / Search  ·  s Scope  ·  w Wrap  ·  c Changed-only  ·  r Review draft  ·  Enter → Diff  ·  Tab/v Commit  ·  o Open  ·  f Finder  ·  S Stash  ·  q/Esc Close"
							: "  ↑/↓ Scroll  ·  PgUp/PgDn Fast  ·  / Search  ·  s Scope  ·  w Wrap  ·  c Changed-only  ·  r Review draft  ·  Tab/v Commit  ·  o Open  ·  f Finder  ·  ←/Esc → Files  ·  q Close"
				: st.focus === "left"
					? "  ↑/↓ Select Commit  ·  Enter → Changed Files  ·  Tab/v Toggle Diff  ·  S Stash  ·  q/Esc Close"
					: "  ↑/↓ Select (overflow 시 line scroll)  ·  j/k Select File  ·  Enter Fold/Unfold Diff  ·  PgUp/PgDn Scroll  ·  Tab/v Toggle Diff  ·  o Open  ·  f Finder  ·  ←/Esc → Commits  ·  q Close";
		footer.push(t.fg("dim", hint));
		footer.push(...new DynamicBorder((s: string) => t.fg("accent", s)).render(w));

		const bodyH = Math.max(3, h - header.length - footer.length);
		const leftW = Math.max(14, Math.min(Math.floor(w * 0.28), 44));
		const rightW = Math.max(10, w - leftW - 3);
		this.lastRightWidth = rightW;

		const leftTitleLabel = st.viewMode === "diff" ? ` FILES · ${scopeFilesLabel(st.scope)}` : " COMMITS";
		const rightTitleLabel = st.viewMode === "diff" ? " DIFF" : " CHANGED FILES";
		const leftTitle = st.focus === "left" ? t.fg("accent", t.bold(leftTitleLabel)) : t.fg("dim", leftTitleLabel);
		const rightTitle = st.focus === "right" ? t.fg("accent", t.bold(rightTitleLabel)) : t.fg("dim", rightTitleLabel);

		const selectedFile = findFileByPath(st, st.selectedFilePath);
		const selectedFileReviewCount = selectedFile
			? st.reviewDrafts.filter((draft) => draft.filePath === selectedFile.path).length
			: 0;
		const fileLabel = selectedFile
			? `${t.fg(statusColor(selectedFile.status), icon(selectedFile.status))} ${t.fg(commitStateColor(selectedFile.commitState), `[${commitStateBadge(selectedFile.commitState)}]`)} ${t.fg(selectedFileReviewCount > 0 ? "accent" : "dim", selectedFileReviewCount > 0 ? `${selectedFileReviewCount} review${selectedFileReviewCount !== 1 ? "s" : ""}` : "no reviews")} ${t.fg("muted", fileDisplayPath(selectedFile))}`
			: t.fg("muted", "(no file)");

		const selectedCommit = st.commits[st.commitSelectedIndex];
		let commitLabel = t.fg("muted", "(no commit)");
		if (selectedCommit) {
			const commitFiles = st.commitFilesCache.get(selectedCommit.hash);
			const filesInfo = commitFiles
				? `${commitFiles.length} file${commitFiles.length !== 1 ? "s" : ""}`
				: st.commitFilesLoading.has(selectedCommit.hash)
					? "loading files…"
					: "files: -";
			if (selectedCommit.hash === UNCOMMITTED_HASH) {
				commitLabel = `${t.fg("warning", "●●●")} ${t.fg("warning", selectedCommit.subject)} ${t.fg("dim", `· ${filesInfo}`)}`;
			} else {
				commitLabel = `${t.fg("muted", selectedCommit.shortHash)} ${t.fg("text", selectedCommit.subject)} ${t.fg("dim", `· ${filesInfo}`)}`;
			}
		}

		const rightHeader = st.viewMode === "diff" ? `${rightTitle} ${fileLabel}` : `${rightTitle} ${commitLabel}`;
		const titleLine = `${truncateToWidth(leftTitle, leftW)}${" ".repeat(Math.max(0, leftW - visibleWidth(leftTitle)))} ${t.fg("dim", "│")} ${truncateToWidth(rightHeader, rightW)}`;

		const separatorLine = `${t.fg("dim", "─".repeat(leftW))} ${t.fg("dim", "┼")} ${t.fg("dim", "─".repeat(rightW))}`;
		const contentH = Math.max(1, bodyH - 2);

		const left = st.viewMode === "diff" ? renderFiles(t, st, leftW, contentH) : renderCommits(t, st, leftW, contentH);
		const right =
			st.viewMode === "diff" ? renderDiff(t, st, rightW, contentH) : renderCommitFiles(t, st, rightW, contentH);

		while (left.length < contentH) left.push("");
		while (right.length < contentH) right.push("");

		const body: string[] = [titleLine, separatorLine];
		for (let i = 0; i < contentH; i++) {
			const l = truncateToWidth(left[i] ?? "", leftW);
			const pad = Math.max(0, leftW - visibleWidth(l));
			const r = truncateToWidth(right[i] ?? "", rightW);
			body.push(`${l}${" ".repeat(pad)} ${t.fg("dim", "│")} ${r}`);
		}

		return [...header, ...body, ...footer].map((line) => truncateToWidth(expandTabs(line), w));
	}
}

// ─── Extension ─────────────────────────────────────────────────────────────

export default function diffOverlayExtension(pi: ExtensionAPI) {
	// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: command bootstrap assembles repo state, caches, and UI fallback in one flow.
	const handler = async (_args: string, ctx: ExtensionCommandContext) => {
		const root = await gitRoot(pi, ctx.cwd);
		if (!root) {
			if (ctx.hasUI) ctx.ui.notify("Not a git repository", "error");
			// biome-ignore lint/suspicious/noConsole: non-UI fallback needs plain terminal output.
			else console.log("Not a git repository");
			return;
		}

		const branch = await currentBranch(pi, root);
		const mergeBaseInfo = await findMergeBase(pi, root, branch);
		const mergeBase = mergeBaseInfo?.commit ?? null;
		const overlayData = await loadOverlayData(pi, root, mergeBase);
		const commits = [...overlayData.commits];
		const workingFiles = overlayData.filesByScope.working;
		const initialScope: OverlayDiffScope =
			overlayData.filesByScope.branch.length > 0 ? "branch" : workingFiles.length > 0 ? "working" : "last-commit";
		const files = overlayData.filesByScope[initialScope];
		const { treeNodes, expandedDirs } = rebuildTree(files);
		const firstVisibleRows = flattenVisibleTree(treeNodes, expandedDirs);
		const firstFileRow = firstVisibleRows.find((r) => r.type === "file");
		const initialSelectedFilePath = firstFileRow ? firstFileRow.fullPath : files.length > 0 ? files[0].path : null;

		if (overlayData.uncommittedFiles.length > 0) {
			commits.unshift({
				hash: UNCOMMITTED_HASH,
				shortHash: "•••",
				author: "",
				relativeDate: "now",
				subject: `Uncommitted Changes (${overlayData.uncommittedFiles.length} file${overlayData.uncommittedFiles.length !== 1 ? "s" : ""})`,
			});
		}

		const st: DiffState = {
			files,
			filesByScope: overlayData.filesByScope,
			scope: initialScope,
			searchQuery: "",
			searchMode: false,
			selectedIndex: 0,
			fileScrollOffset: 0,
			diffCache: new Map(),
			highlightedDiffCache: new Map(),
			diffScrollOffset: 0,
			diffScrollMemory: new Map(),
			selectedFilePathByScope: {
				branch: initialScope === "branch" ? initialSelectedFilePath : null,
				working: initialScope === "working" ? initialSelectedFilePath : null,
				"last-commit": initialScope === "last-commit" ? initialSelectedFilePath : null,
			},
			wrapLines: true,
			changedOnly: false,
			reviewDrafts: [],
			reviewInput: { active: false, buffer: "", error: null },

			treeNodes,
			expandedDirs,
			selectedFilePath: initialSelectedFilePath,

			commits,
			commitSelectedIndex: 0,
			commitScrollOffset: 0,
			commitFilesCache: new Map(),
			commitFilesLoading: new Set(),
			commitFileDiffCache: new Map(),
			commitFileDiffLoading: new Set(),
			commitExpandedByHash: new Map(),
			commitFileSelectedIndex: 0,
			commitFileScrollOffset: 0,
			commitFileManualScroll: false,

			viewMode: "diff",
			focus: "left",
			branch,
			mergeBase,
			baseBranch: mergeBaseInfo?.baseBranch ?? null,
			error: null,
		};

		// Pre-populate uncommitted files cache for commit mode
		if (overlayData.uncommittedFiles.length > 0) {
			st.commitFilesCache.set(
				UNCOMMITTED_HASH,
				overlayData.uncommittedFiles.map((f) => ({
					path: f.path,
					status: f.status,
					rawStatus: f.rawStatus,
					previousPath: f.previousPath ?? null,
				})),
			);
		}

		if (!ctx.hasUI) {
			if (files.length === 0) {
				// biome-ignore lint/suspicious/noConsole: non-UI fallback needs plain terminal output.
				console.log("No changes.");
				return;
			}
			// biome-ignore lint/suspicious/noConsole: non-UI fallback lists changed files in the terminal.
			for (const f of files) console.log(`${icon(f.status)} ${f.path}`);
			return;
		}

		if (st.selectedFilePath) {
			const firstFile = files.find((f) => f.path === st.selectedFilePath);
			if (firstFile) {
				st.diffCache.set(
					scopedDiffKey(st.scope, firstFile.path),
					await fileDiff(pi, root, firstFile, st.scope, mergeBase),
				);
			}
		}

		const reviewPrompt = await ctx.ui.custom<string | undefined>(
			(tui, theme, _kb, done) => {
				const overlay = new DiffOverlay(pi, root, st, (prompt) => done(prompt));
				const tuiRef = tui as Tui;
				return {
					render: (w) => overlay.render(w, tuiRef.terminal?.rows ?? 40, theme),
					handleInput: (data) => overlay.handleInput(data, tuiRef),
					invalidate: () => {},
				};
			},
			{ overlay: true, overlayOptions: { width: "100%", maxHeight: "100%", anchor: "center" } },
		);
		if (reviewPrompt) {
			ctx.ui.setEditorText(reviewPrompt);
			ctx.ui.notify("Moved review feedback into the editor.", "info");
		}
	};

	pi.registerCommand("diff", {
		description: "Git diff viewer — diff mode + commit mode (per-commit foldable file diffs)",
		handler,
	});
}
