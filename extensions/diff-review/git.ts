import { readFile } from "node:fs/promises";
import { extname, join } from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type {
	ChangeStatus,
	ReviewCommitInfo,
	ReviewFile,
	ReviewFileComparison,
	ReviewFileContents,
	ReviewScope,
} from "./types.js";

interface ChangedPath {
	status: ChangeStatus;
	oldPath: string | null;
	newPath: string | null;
}

interface ReviewFileSeed {
	path: string;
	worktreeStatus: ChangeStatus | null;
	hasWorkingTreeFile: boolean;
	inGitDiff: boolean;
	gitDiff: ReviewFileComparison | null;
}

async function runGit(pi: ExtensionAPI, repoRoot: string, args: string[]): Promise<string> {
	const result = await pi.exec("git", args, { cwd: repoRoot });
	if (result.code !== 0) {
		const message = result.stderr.trim() || result.stdout.trim() || `git ${args.join(" ")} failed`;
		throw new Error(message);
	}
	return result.stdout;
}

async function runGitAllowFailure(pi: ExtensionAPI, repoRoot: string, args: string[]): Promise<string> {
	const result = await pi.exec("git", args, { cwd: repoRoot });
	if (result.code !== 0) {
		return "";
	}
	return result.stdout;
}

export async function getRepoRoot(pi: ExtensionAPI, cwd: string): Promise<string> {
	const result = await pi.exec("git", ["rev-parse", "--show-toplevel"], { cwd });
	if (result.code !== 0) {
		throw new Error("Not inside a git repository.");
	}
	return result.stdout.trim();
}

async function hasHead(pi: ExtensionAPI, repoRoot: string): Promise<boolean> {
	const result = await pi.exec("git", ["rev-parse", "--verify", "HEAD"], { cwd: repoRoot });
	return result.code === 0;
}

function parseNameStatusLine(parts: string[]): ChangedPath | null {
	const code = (parts[0] ?? "")[0];

	if (code === "R") {
		const oldPath = parts[1] ?? null;
		const newPath = parts[2] ?? null;
		if (oldPath == null || newPath == null) return null;
		return { status: "renamed", oldPath, newPath };
	}

	const path = parts[1] ?? null;
	if (path == null) return null;

	if (code === "M") return { status: "modified", oldPath: path, newPath: path };
	if (code === "A") return { status: "added", oldPath: null, newPath: path };
	if (code === "D") return { status: "deleted", oldPath: path, newPath: null };
	return null;
}

function parseNameStatus(output: string): ChangedPath[] {
	const lines = output
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter((line) => line.length > 0);

	const changes: ChangedPath[] = [];
	for (const line of lines) {
		const change = parseNameStatusLine(line.split("\t"));
		if (change != null) changes.push(change);
	}
	return changes;
}

function parseUntrackedPaths(output: string): ChangedPath[] {
	return output
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter((line) => line.length > 0)
		.map((path) => ({
			status: "added" as const,
			oldPath: null,
			newPath: path,
		}));
}

function parseTrackedPaths(output: string): string[] {
	return output
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter((line) => line.length > 0);
}

function mergeChangedPaths(tracked: ChangedPath[], untracked: ChangedPath[]): ChangedPath[] {
	const seen = new Set(tracked.map((change) => `${change.status}:${change.oldPath ?? ""}:${change.newPath ?? ""}`));
	const merged = [...tracked];

	for (const change of untracked) {
		const key = `${change.status}:${change.oldPath ?? ""}:${change.newPath ?? ""}`;
		if (seen.has(key)) continue;
		merged.push(change);
		seen.add(key);
	}

	return merged;
}

function uniquePaths(paths: string[]): string[] {
	return [...new Set(paths)];
}

function toDisplayPath(change: ChangedPath): string {
	if (change.status === "renamed") {
		return `${change.oldPath ?? ""} -> ${change.newPath ?? ""}`;
	}
	return change.newPath ?? change.oldPath ?? "(unknown)";
}

function toComparison(change: ChangedPath): ReviewFileComparison {
	return {
		status: change.status,
		oldPath: change.oldPath,
		newPath: change.newPath,
		displayPath: toDisplayPath(change),
		hasOriginal: change.oldPath != null,
		hasModified: change.newPath != null,
	};
}

function buildBranchFileId(path: string, hasWorkingTreeFile: boolean, gitDiff: ReviewFileComparison | null): string {
	return ["branch", path, hasWorkingTreeFile ? "working" : "gone", gitDiff?.displayPath ?? ""].join("::");
}

function buildCommitFileId(sha: string, comparison: ReviewFileComparison): string {
	return ["commit", sha, comparison.displayPath].join("::");
}

function createReviewFile(seed: ReviewFileSeed): ReviewFile {
	return {
		id: buildBranchFileId(seed.path, seed.hasWorkingTreeFile, seed.gitDiff),
		path: seed.path,
		worktreeStatus: seed.worktreeStatus,
		hasWorkingTreeFile: seed.hasWorkingTreeFile,
		inGitDiff: seed.inGitDiff,
		gitDiff: seed.gitDiff,
	};
}

async function getRevisionContent(pi: ExtensionAPI, repoRoot: string, revision: string, path: string): Promise<string> {
	const result = await pi.exec("git", ["show", `${revision}:${path}`], { cwd: repoRoot });
	if (result.code !== 0) {
		return "";
	}
	return result.stdout;
}

async function getWorkingTreeContent(repoRoot: string, path: string): Promise<string> {
	try {
		return await readFile(join(repoRoot, path), "utf8");
	} catch {
		return "";
	}
}

function isReviewableFilePath(path: string): boolean {
	const lowerPath = path.toLowerCase();
	const fileName = lowerPath.split("/").pop() ?? lowerPath;
	const extension = extname(fileName);

	if (fileName.length === 0) return false;

	const binaryExtensions = new Set([
		".7z",
		".a",
		".avi",
		".avif",
		".bin",
		".bmp",
		".class",
		".dll",
		".dylib",
		".eot",
		".exe",
		".gif",
		".gz",
		".ico",
		".jar",
		".jpeg",
		".jpg",
		".lockb",
		".map",
		".mov",
		".mp3",
		".mp4",
		".o",
		".otf",
		".pdf",
		".png",
		".pyc",
		".so",
		".svgz",
		".tar",
		".ttf",
		".wasm",
		".webm",
		".webp",
		".woff",
		".woff2",
		".zip",
	]);

	if (binaryExtensions.has(extension)) return false;
	if (fileName.endsWith(".min.js") || fileName.endsWith(".min.css")) return false;

	return true;
}

function compareReviewFiles(a: ReviewFile, b: ReviewFile): number {
	return a.path.localeCompare(b.path);
}

function upsertSeed(seeds: Map<string, ReviewFileSeed>, key: string, create: () => ReviewFileSeed): ReviewFileSeed {
	const existing = seeds.get(key);
	if (existing != null) return existing;
	const seed = create();
	seeds.set(key, seed);
	return seed;
}

export async function getReviewWindowData(
	pi: ExtensionAPI,
	cwd: string,
): Promise<{ repoRoot: string; files: ReviewFile[]; commits: ReviewCommitInfo[] }> {
	const repoRoot = await getRepoRoot(pi, cwd);
	const repositoryHasHead = await hasHead(pi, repoRoot);

	const trackedDiffOutput = repositoryHasHead
		? await runGit(pi, repoRoot, ["diff", "--find-renames", "-M", "--name-status", "HEAD", "--"])
		: "";
	const untrackedOutput = await runGitAllowFailure(pi, repoRoot, ["ls-files", "--others", "--exclude-standard"]);
	const trackedFilesOutput = await runGitAllowFailure(pi, repoRoot, ["ls-files", "--cached"]);
	const deletedFilesOutput = await runGitAllowFailure(pi, repoRoot, ["ls-files", "--deleted"]);

	const worktreeChanges = mergeChangedPaths(
		parseNameStatus(trackedDiffOutput),
		parseUntrackedPaths(untrackedOutput),
	).filter((change) => isReviewableFilePath(change.newPath ?? change.oldPath ?? ""));
	const deletedPaths = new Set(parseTrackedPaths(deletedFilesOutput));
	const currentPaths = uniquePaths([...parseTrackedPaths(trackedFilesOutput), ...parseTrackedPaths(untrackedOutput)])
		.filter((path) => !deletedPaths.has(path))
		.filter(isReviewableFilePath);

	const seeds = new Map<string, ReviewFileSeed>();

	for (const path of currentPaths) {
		seeds.set(path, {
			path,
			worktreeStatus: null,
			hasWorkingTreeFile: true,
			inGitDiff: false,
			gitDiff: null,
		});
	}

	for (const change of worktreeChanges) {
		const key = change.newPath ?? change.oldPath ?? toDisplayPath(change);
		const seed = upsertSeed(seeds, key, () => ({
			path: key,
			worktreeStatus: null,
			hasWorkingTreeFile: change.newPath != null,
			inGitDiff: false,
			gitDiff: null,
		}));
		seed.worktreeStatus = change.status;
		seed.hasWorkingTreeFile = change.newPath != null;
		seed.inGitDiff = true;
		seed.gitDiff = toComparison(change);
	}

	const files = [...seeds.values()].map(createReviewFile).sort(compareReviewFiles);
	const commits = repositoryHasHead ? await listRecentCommits(pi, repoRoot, 100) : [];

	return { repoRoot, files, commits };
}

export async function listRecentCommits(
	pi: ExtensionAPI,
	repoRoot: string,
	limit: number,
): Promise<ReviewCommitInfo[]> {
	// Use a record separator that won't appear inside subjects/names.
	const sep = "\x1f";
	const format = ["%H", "%h", "%s", "%an", "%aI"].join(sep);
	const output = await runGitAllowFailure(pi, repoRoot, ["log", `-${limit}`, `--format=${format}`]);
	return output
		.split(/\r?\n/)
		.map((line) => line.trimEnd())
		.filter((line) => line.length > 0)
		.map((line) => {
			const [sha, shortSha, subject, authorName, authorDate] = line.split(sep);
			return {
				sha: sha ?? "",
				shortSha: shortSha ?? (sha ?? "").slice(0, 7),
				subject: subject ?? "",
				authorName: authorName ?? "",
				authorDate: authorDate ?? "",
			} satisfies ReviewCommitInfo;
		})
		.filter((c) => c.sha.length > 0);
}

export async function getCommitFiles(pi: ExtensionAPI, repoRoot: string, sha: string): Promise<ReviewFile[]> {
	const output = await runGitAllowFailure(pi, repoRoot, [
		"diff-tree",
		"--root",
		"--find-renames",
		"-M",
		"--name-status",
		"--no-commit-id",
		"-r",
		sha,
	]);
	const changes = parseNameStatus(output).filter((change) =>
		isReviewableFilePath(change.newPath ?? change.oldPath ?? ""),
	);
	return changes
		.map((change): ReviewFile => {
			const comparison = toComparison(change);
			const path = change.newPath ?? change.oldPath ?? comparison.displayPath;
			return {
				id: buildCommitFileId(sha, comparison),
				path,
				worktreeStatus: null,
				hasWorkingTreeFile: false,
				inGitDiff: true,
				gitDiff: comparison,
			};
		})
		.sort(compareReviewFiles);
}

export async function loadReviewFileContents(
	pi: ExtensionAPI,
	repoRoot: string,
	file: ReviewFile,
	scope: ReviewScope,
	commitSha: string | null = null,
): Promise<ReviewFileContents> {
	if (scope === "all") {
		const content = file.hasWorkingTreeFile ? await getWorkingTreeContent(repoRoot, file.path) : "";
		return { originalContent: content, modifiedContent: content };
	}

	const comparison = file.gitDiff;
	if (comparison == null) {
		return { originalContent: "", modifiedContent: "" };
	}

	if (scope === "commits") {
		if (!commitSha) return { originalContent: "", modifiedContent: "" };
		const originalContent =
			comparison.oldPath == null ? "" : await getRevisionContent(pi, repoRoot, `${commitSha}^`, comparison.oldPath);
		const modifiedContent =
			comparison.newPath == null ? "" : await getRevisionContent(pi, repoRoot, commitSha, comparison.newPath);
		return { originalContent, modifiedContent };
	}

	// scope === "branch": working tree vs HEAD.
	const originalContent =
		comparison.oldPath == null ? "" : await getRevisionContent(pi, repoRoot, "HEAD", comparison.oldPath);
	const modifiedContent = comparison.newPath == null ? "" : await getWorkingTreeContent(repoRoot, comparison.newPath);
	return { originalContent, modifiedContent };
}
