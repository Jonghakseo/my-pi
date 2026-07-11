import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	mergeDiffEntries,
	parseGitLogOutput,
	parseNameStatusZ,
	parsePorcelainStatusZ,
	type BranchCommitEntry,
	type DiffFileStatus,
	type OverlayDiffScope,
} from "./diff-overlay-utils.js";
import { UNCOMMITTED_HASH } from "./overlay-utils.js";
import type { CommitFile, DiffFile } from "./types.js";

// ─── Git helpers ───────────────────────────────────────────────────────────

export async function gitRoot(pi: ExtensionAPI, cwd: string): Promise<string | null> {
	const r = await pi.exec("git", ["rev-parse", "--show-toplevel"], { cwd });
	return r.code === 0 ? (r.stdout ?? "").trim() || null : null;
}

export async function currentBranch(pi: ExtensionAPI, cwd: string): Promise<string> {
	const r = await pi.exec("git", ["branch", "--show-current"], { cwd });
	return r.code === 0 ? (r.stdout ?? "").trim() || "HEAD" : "HEAD";
}

export interface MergeBaseInfo {
	commit: string;
	baseBranch: string;
}

export async function findMergeBase(pi: ExtensionAPI, cwd: string, branch: string): Promise<MergeBaseInfo | null> {
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

export async function workingTreeFiles(pi: ExtensionAPI, cwd: string): Promise<DiffFile[]> {
	const r = await pi.exec("git", ["--no-optional-locks", "status", "--porcelain=1", "-uall", "-z"], { cwd });
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

export async function loadOverlayData(pi: ExtensionAPI, cwd: string, mergeBase: string | null): Promise<OverlayData> {
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

export async function commitFilesForHash(pi: ExtensionAPI, cwd: string, commitHash: string): Promise<CommitFile[]> {
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

export async function commitFileDiff(
	pi: ExtensionAPI,
	cwd: string,
	commitHash: string,
	file: CommitFile,
): Promise<string> {
	if (commitHash === UNCOMMITTED_HASH) {
		return workingTreeFileDiff(pi, cwd, file);
	}

	const primary = await pi.exec(
		"git",
		["show", "--no-color", "--format=", "--diff-merges=first-parent", commitHash, "--", file.path],
		{ cwd },
	);
	if (primary.code === 0 && (primary.stdout ?? "").trim()) return (primary.stdout ?? "").trim();

	const fallback = await pi.exec("git", ["show", "--no-color", "--format=", commitHash, "--", file.path], { cwd });
	if (fallback.code === 0 && (fallback.stdout ?? "").trim()) return (fallback.stdout ?? "").trim();
	return "(no diff available)";
}

export async function fileDiff(
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
