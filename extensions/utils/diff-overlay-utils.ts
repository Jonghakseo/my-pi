/**
 * Pure utilities for /diff overlay file/commit views.
 */

export type DiffFileStatus = "added" | "deleted" | "modified" | "renamed" | "copied" | "untracked";

export type CommitState = "committed" | "uncommitted" | "both";

export type OverlayViewMode = "diff" | "commit";

export interface ParsedDiffEntry {
	path: string;
	status: DiffFileStatus;
	rawStatus: string;
}

export interface MergedDiffEntry extends ParsedDiffEntry {
	commitState: CommitState;
}

export interface BranchCommitEntry {
	hash: string;
	shortHash: string;
	author: string;
	relativeDate: string;
	subject: string;
}

/** Map git diff --name-status code to overlay status. */
export function mapDiffStatusCode(code: string): DiffFileStatus {
	const c = code.charAt(0);
	if (c === "A") return "added";
	if (c === "D") return "deleted";
	if (c === "R") return "renamed";
	if (c === "C") return "copied";
	return "modified";
}

/** Parse git status porcelain (XY) code to overlay status. */
export function parseStatus(code: string): DiffFileStatus {
	const second = code.charAt(1);
	const effective = second !== " " && second !== "?" ? second : code.charAt(0);
	if (code === "??") return "untracked";
	if (effective === "A") return "added";
	if (effective === "D") return "deleted";
	if (effective === "R") return "renamed";
	if (effective === "C") return "copied";
	return "modified";
}

/**
 * Parse `git diff --name-status -z` output.
 *
 * Format (NUL-separated):
 * - normal: <status>\0<path>\0
 * - rename/copy: <status>\0<oldPath>\0<newPath>\0
 */
export function parseNameStatusZ(stdout: string): ParsedDiffEntry[] {
	if (!stdout) return [];

	const tokens = stdout.split("\0").filter((token) => token.length > 0);
	const entries: ParsedDiffEntry[] = [];

	for (let i = 0; i < tokens.length; i++) {
		const rawCode = (tokens[i] ?? "").trim();
		if (!rawCode) continue;

		const code = rawCode.charAt(0);
		if (code === "R" || code === "C") {
			const newPath = tokens[i + 2];
			if (!newPath) break;
			entries.push({
				path: newPath,
				status: mapDiffStatusCode(rawCode),
				rawStatus: rawCode,
			});
			i += 2;
			continue;
		}

		const filePath = tokens[i + 1];
		if (!filePath) break;
		entries.push({
			path: filePath,
			status: mapDiffStatusCode(rawCode),
			rawStatus: rawCode,
		});
		i += 1;
	}

	return entries;
}

/**
 * Parse `git status --porcelain=1 -z` output.
 *
 * Format (NUL-separated):
 * - normal: "XY <path>"\0
 * - rename/copy: "R? <oldPath>"\0"<newPath>"\0
 */
export function parsePorcelainStatusZ(stdout: string): ParsedDiffEntry[] {
	if (!stdout) return [];

	const statusParts = stdout.split("\0").filter(Boolean);
	const entries: ParsedDiffEntry[] = [];

	for (let i = 0; i < statusParts.length; i++) {
		const entry = statusParts[i] ?? "";
		if (entry.length < 4) continue;

		const raw = entry.slice(0, 2);
		let filePath = entry.slice(3);
		if ((raw.startsWith("R") || raw.startsWith("C")) && statusParts[i + 1]) {
			filePath = statusParts[i + 1] ?? filePath;
			i += 1;
		}
		if (!filePath) continue;

		entries.push({
			path: filePath,
			status: parseStatus(raw),
			rawStatus: raw.trim() || raw,
		});
	}

	return entries;
}

function toCommitState(hasCommitted: boolean, hasWorking: boolean): CommitState {
	if (hasCommitted && hasWorking) return "both";
	if (hasCommitted) return "committed";
	return "uncommitted";
}

const FILE_STATUS_ORDER: Record<DiffFileStatus, number> = {
	modified: 0,
	added: 1,
	untracked: 2,
	renamed: 3,
	deleted: 4,
	copied: 5,
};

/** Merge committed-file set + working-file set into final overlay file rows. */
export function mergeDiffEntries(
	committedEntries: ParsedDiffEntry[],
	workingEntries: ParsedDiffEntry[],
): MergedDiffEntry[] {
	const byPath = new Map<
		string,
		{
			committed?: ParsedDiffEntry;
			working?: ParsedDiffEntry;
		}
	>();

	for (const entry of committedEntries) {
		const prev = byPath.get(entry.path);
		if (prev) prev.committed = entry;
		else byPath.set(entry.path, { committed: entry });
	}

	for (const entry of workingEntries) {
		const prev = byPath.get(entry.path);
		if (prev) prev.working = entry;
		else byPath.set(entry.path, { working: entry });
	}

	const merged: MergedDiffEntry[] = [];
	for (const [filePath, value] of byPath.entries()) {
		const source = value.working ?? value.committed;
		if (!source) continue;

		merged.push({
			path: filePath,
			status: source.status,
			rawStatus: source.rawStatus,
			commitState: toCommitState(Boolean(value.committed), Boolean(value.working)),
		});
	}

	merged.sort(
		(a, b) => (FILE_STATUS_ORDER[a.status] ?? 9) - (FILE_STATUS_ORDER[b.status] ?? 9) || a.path.localeCompare(b.path),
	);
	return merged;
}

export function commitStateBadge(state: CommitState): string {
	if (state === "committed") return "C";
	if (state === "uncommitted") return "W";
	return "C+W";
}

export function toggleOverlayViewMode(mode: OverlayViewMode): OverlayViewMode {
	return mode === "diff" ? "commit" : "diff";
}

// ─── File Tree Types ───────────────────────────────────────────────────────

export interface DirTreeNode {
	type: "dir";
	/** Display name — may include collapsed segments like "src/utils" */
	name: string;
	/** Full directory path (e.g., "src/utils") */
	fullPath: string;
	children: FileTreeNode[];
}

export interface FileLeafNode {
	type: "file";
	/** Basename only */
	name: string;
	/** Full file path */
	fullPath: string;
}

export type FileTreeNode = DirTreeNode | FileLeafNode;

export interface VisibleDirRow {
	type: "dir";
	depth: number;
	fullPath: string;
	name: string;
	expanded: boolean;
}

export interface VisibleFileRow {
	type: "file";
	depth: number;
	fullPath: string;
	name: string;
}

export type VisibleRow = VisibleDirRow | VisibleFileRow;

// ─── File Tree Builders ────────────────────────────────────────────────────

interface TempDir {
	children: Map<string, TempDir>;
	files: string[]; // full paths of files directly in this dir
}

/**
 * Build a hierarchical file tree from a list of file paths.
 * Directories come first (alphabetical), then files (alphabetical).
 */
export function buildFileTree(paths: string[]): FileTreeNode[] {
	const root: TempDir = { children: new Map(), files: [] };

	for (const filePath of paths) {
		const parts = filePath.split("/");
		let current = root;

		for (let i = 0; i < parts.length - 1; i++) {
			const dirName = parts[i];
			if (!current.children.has(dirName)) {
				current.children.set(dirName, { children: new Map(), files: [] });
			}
			current = current.children.get(dirName)!;
		}
		current.files.push(filePath);
	}

	function convert(dir: TempDir, parentPath: string): FileTreeNode[] {
		const nodes: FileTreeNode[] = [];
		const sortedDirs = [...dir.children.entries()].sort(([a], [b]) => a.localeCompare(b));
		const sortedFiles = [...dir.files].sort((a, b) => {
			const aName = a.split("/").pop() ?? a;
			const bName = b.split("/").pop() ?? b;
			return aName.localeCompare(bName);
		});

		for (const [name, subDir] of sortedDirs) {
			const fullPath = parentPath ? `${parentPath}/${name}` : name;
			nodes.push({ type: "dir", name, fullPath, children: convert(subDir, fullPath) });
		}
		for (const filePath of sortedFiles) {
			nodes.push({ type: "file", name: filePath.split("/").pop() ?? filePath, fullPath: filePath });
		}
		return nodes;
	}

	return convert(root, "");
}

/**
 * Collapse single-child directory chains.
 * e.g., `src` → `components` (only child) → files ⇒ `src/components` → files
 */
export function collapseFileTree(nodes: FileTreeNode[]): FileTreeNode[] {
	return nodes.map((node) => {
		if (node.type === "file") return node;

		let collapsed: DirTreeNode = { ...node, children: collapseFileTree(node.children) };

		while (collapsed.children.length === 1 && collapsed.children[0].type === "dir") {
			const child = collapsed.children[0];
			collapsed = {
				type: "dir",
				name: `${collapsed.name}/${child.name}`,
				fullPath: child.fullPath,
				children: child.children,
			};
		}

		return collapsed;
	});
}

/**
 * Flatten the file tree into visible rows based on which directories are expanded.
 */
export function flattenVisibleTree(
	nodes: FileTreeNode[],
	expandedDirs: Set<string>,
	depth = 0,
): VisibleRow[] {
	const rows: VisibleRow[] = [];
	for (const node of nodes) {
		if (node.type === "file") {
			rows.push({ type: "file", depth, fullPath: node.fullPath, name: node.name });
		} else {
			const expanded = expandedDirs.has(node.fullPath);
			rows.push({ type: "dir", depth, fullPath: node.fullPath, name: node.name, expanded });
			if (expanded) {
				rows.push(...flattenVisibleTree(node.children, expandedDirs, depth + 1));
			}
		}
	}
	return rows;
}

/**
 * Collect all directory paths from a file tree (for initializing all-expanded state).
 */
export function collectAllDirPaths(nodes: FileTreeNode[]): string[] {
	const paths: string[] = [];
	for (const node of nodes) {
		if (node.type === "dir") {
			paths.push(node.fullPath);
			paths.push(...collectAllDirPaths(node.children));
		}
	}
	return paths;
}

// ─── Diff Syntax Highlight Utilities ───────────────────────────────────────

export type DiffLineCategory = "meta" | "hunk" | "added" | "removed" | "context";

export interface ParsedDiffLine {
	category: DiffLineCategory;
	/** Diff prefix character: "+", "-", " ", or "" for meta/hunk */
	prefix: string;
	/** Code content without the diff prefix */
	code: string;
	/** The full original line */
	originalLine: string;
}

/**
 * Parse raw unified diff output into structured lines with categories.
 *
 * Uses state tracking: lines before the first `@@` hunk header are meta.
 * If the diff has no header (e.g. untracked file `+ content`), all lines
 * are treated as code from the start.
 */
export function parseDiffLines(rawDiff: string): ParsedDiffLine[] {
	const lines = rawDiff.split("\n");
	// If the diff doesn't start with a standard diff header, assume raw code
	let inHunk = lines.length > 0 && !lines[0].startsWith("diff ");

	return lines.map((line): ParsedDiffLine => {
		// New diff block resets to meta mode
		if (line.startsWith("diff ")) {
			inHunk = false;
			return { category: "meta", prefix: "", code: "", originalLine: line };
		}

		// Hunk header enters code mode
		if (line.startsWith("@@")) {
			inHunk = true;
			return { category: "hunk", prefix: "", code: "", originalLine: line };
		}

		// Before first hunk: everything is meta
		if (!inHunk) {
			return { category: "meta", prefix: "", code: "", originalLine: line };
		}

		// Inside hunk: code lines
		if (line.startsWith("+")) {
			return { category: "added", prefix: "+", code: line.slice(1), originalLine: line };
		}
		if (line.startsWith("-")) {
			return { category: "removed", prefix: "-", code: line.slice(1), originalLine: line };
		}
		if (line.startsWith(" ")) {
			return { category: "context", prefix: " ", code: line.slice(1), originalLine: line };
		}

		// "\ No newline at end of file"
		if (line.startsWith("\\")) {
			return { category: "meta", prefix: "", code: "", originalLine: line };
		}

		// Empty line or unexpected: treat as context
		return { category: "context", prefix: "", code: line, originalLine: line };
	});
}

/**
 * Extract code content from parsed diff lines for bulk syntax highlighting.
 * Returns the joined code string and the indices of the source lines.
 */
export function extractCodeBlock(parsed: ParsedDiffLine[]): { code: string; indices: number[] } {
	const codeLines: string[] = [];
	const indices: number[] = [];

	for (let i = 0; i < parsed.length; i++) {
		const line = parsed[i];
		if (line.category === "added" || line.category === "removed" || line.category === "context") {
			codeLines.push(line.code);
			indices.push(i);
		}
	}

	return { code: codeLines.join("\n"), indices };
}

/**
 * Combine parsed diff structure with syntax-highlighted code lines.
 *
 * Pure function — the caller provides coloring callbacks so this can be
 * tested without a real theme.
 *
 * @param parsed          Structured diff lines from `parseDiffLines`
 * @param highlightedCode Highlighted lines (same count as code lines in parsed)
 * @param colorMeta       Callback to color meta lines (diff header, ---/+++)
 * @param colorHunk       Callback to color hunk headers (@@)
 * @param colorPrefix     Callback to color the diff prefix (+/-/space)
 */
export function applyHighlightToDiff(
	parsed: ParsedDiffLine[],
	highlightedCode: string[],
	colorMeta: (line: string) => string,
	colorHunk: (line: string) => string,
	colorPrefix: (category: "added" | "removed" | "context", prefix: string) => string,
): string[] {
	const result: string[] = [];
	let codeIdx = 0;

	for (const line of parsed) {
		if (line.category === "meta") {
			result.push(colorMeta(line.originalLine));
		} else if (line.category === "hunk") {
			result.push(colorHunk(line.originalLine));
		} else {
			const hlContent = highlightedCode[codeIdx] ?? line.code;
			codeIdx++;
			const coloredPrefix = colorPrefix(line.category, line.prefix);
			result.push(`${coloredPrefix}${hlContent}`);
		}
	}

	return result;
}

// ─── Git Log Parser ────────────────────────────────────────────────────────

/** Parse a git log stream produced by `%H%x1f%h%x1f%an%x1f%ar%x1f%s%x1e`. */
export function parseGitLogOutput(stdout: string): BranchCommitEntry[] {
	if (!stdout) return [];

	const rows = stdout
		.split("\x1e")
		.map((line) => line.trim())
		.filter(Boolean);

	const commits: BranchCommitEntry[] = [];
	for (const row of rows) {
		const [hash = "", shortHash = "", author = "", relativeDate = "", subject = ""] = row.split("\x1f");
		if (!hash || !shortHash) continue;
		commits.push({ hash, shortHash, author, relativeDate, subject });
	}

	return commits;
}
