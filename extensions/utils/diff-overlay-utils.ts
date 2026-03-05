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
export function mergeDiffEntries(committedEntries: ParsedDiffEntry[], workingEntries: ParsedDiffEntry[]): MergedDiffEntry[] {
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

	merged.sort((a, b) => (FILE_STATUS_ORDER[a.status] ?? 9) - (FILE_STATUS_ORDER[b.status] ?? 9) || a.path.localeCompare(b.path));
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
