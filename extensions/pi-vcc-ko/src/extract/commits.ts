import { unwrapHeaderLines } from "../core/format.ts";
import type { NormalizedBlock } from "../types.ts";

export interface CommitInfo {
	hash?: string;
	message: string;
}

/** Commits kept in persisted state (newest win). */
export const COMMIT_STORE_LIMIT = 30;
/** Commits shown in the summary (newest win). */
export const COMMIT_DISPLAY_LIMIT = 8;

const COMMIT_CMD_RE = /\bgit\s+commit\b/;
const COMMIT_MSG_RE = /git\s+commit[^\n]*?-m\s+(?:"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'|\$?'((?:[^'\\]|\\.)*)')/;
// git's own confirmation line: `[main abc1234] msg`, `[main (root-commit) abc1234] msg`,
// `[detached HEAD abc1234] msg`. Only this line proves which hash a commit got;
// any other hex string in the output (git log, file hashes, push ranges) does not.
const COMMIT_OUTPUT_RE = /^\[[^\]\n]*?\s([0-9a-f]{7,40})\]\s+(.*)$/gm;
// Output that shows the commit did not happen (hook failure, nothing staged, ...).
const COMMIT_FAILED_RE =
	/(?:^|\n)\s*(?:error|fatal):|nothing to commit|no changes added to commit|hook[^\n]{0,40}fail|exited with code [1-9]/i;

const firstLineOf = (text: string): string => {
	const line = text.split(/\\n|\n/)[0] ?? "";
	return line.trim();
};

const cleanMessage = (msg: string): string => msg.replace(/\\"/g, '"').replace(/\\'/g, "'").trim();

const normMessage = (m: string): string => m.trim().replace(/\s+/g, " ").toLowerCase();

const sameHash = (a: string, b: string): boolean => a.startsWith(b) || b.startsWith(a);

const hashFromOutput = (output: string, message: string): string | undefined => {
	const lines = [...output.matchAll(COMMIT_OUTPUT_RE)];
	if (lines.length === 0) return undefined;
	const want = normMessage(message);
	const exact = lines.find((m) => normMessage(m[2]).startsWith(want.slice(0, 60)));
	return (exact ?? lines[0])[1];
};

/**
 * The tool result of the call at `index`. Paired by tool-call id when the
 * provider supplied one (parallel calls interleave results, so the next result
 * is not necessarily ours); otherwise the nearest following result, as before.
 */
const resultFor = (blocks: NormalizedBlock[], index: number, id: string | undefined): string | undefined => {
	if (id) {
		for (let j = index + 1; j < blocks.length; j++) {
			const r = blocks[j];
			if (r.kind === "tool_result" && r.toolCallId === id) return r.text;
		}
		return undefined;
	}
	for (let j = index + 1; j < Math.min(blocks.length, index + 3); j++) {
		const r = blocks[j];
		if (r.kind === "tool_result") return r.text;
	}
	return undefined;
};

/**
 * Add a commit, folding repeats: the same message seen once without and once
 * with its hash (or twice with the same hash) is one commit. Different hashes
 * with the same message stay separate commits.
 */
export const addCommit = (list: CommitInfo[], commit: CommitInfo): void => {
	const key = normMessage(commit.message);
	const idx = list.findIndex(
		(c) => normMessage(c.message) === key && (!c.hash || !commit.hash || sameHash(c.hash, commit.hash)),
	);
	if (idx < 0) {
		list.push(commit);
		return;
	}
	const existing = list[idx];
	const hash =
		existing.hash && commit.hash
			? existing.hash.length >= commit.hash.length
				? existing.hash
				: commit.hash
			: (existing.hash ?? commit.hash);
	list[idx] = hash ? { hash, message: existing.message } : { message: existing.message };
};

/**
 * Extract git commits from `git commit -m "..."` commands (bash tool calls and
 * user `!` executions) and read the hash from git's confirmation line in the
 * command's own output. A commit whose output shows it failed is skipped.
 */
export const extractCommits = (blocks: NormalizedBlock[]): CommitInfo[] => {
	const commits: CommitInfo[] = [];

	for (let i = 0; i < blocks.length; i++) {
		const b = blocks[i];
		let cmd: string;
		let output: string | undefined;
		if (b.kind === "tool_call" && b.name.toLowerCase() === "bash") {
			cmd = typeof b.args.command === "string" ? b.args.command : "";
			if (!COMMIT_CMD_RE.test(cmd)) continue;
			output = resultFor(blocks, i, b.id);
		} else if (b.kind === "bash") {
			cmd = b.command;
			if (!COMMIT_CMD_RE.test(cmd)) continue;
			output = b.output;
		} else {
			continue;
		}
		const m = cmd.match(COMMIT_MSG_RE);
		if (!m) continue;
		const message = firstLineOf(cleanMessage(m[1] ?? m[2] ?? m[3] ?? ""));
		if (!message) continue;

		let hash: string | undefined;
		if (output !== undefined) {
			hash = hashFromOutput(output, message);
			if (!hash && COMMIT_FAILED_RE.test(output)) continue;
		}
		addCommit(commits, hash ? { hash, message } : { message });
	}

	return commits;
};

/** Cumulative merge in chronological order, previous commits first. */
export const mergeCommits = (prev: CommitInfo[], fresh: CommitInfo[], limit = COMMIT_STORE_LIMIT): CommitInfo[] => {
	const out: CommitInfo[] = [];
	for (const c of [...prev, ...fresh]) addCommit(out, c);
	return out.length > limit ? out.slice(-limit) : out;
};

export const formatCommits = (commits: CommitInfo[], limit = COMMIT_DISPLAY_LIMIT): string[] =>
	commits.slice(-limit).map((c) => `${c.hash ? `${c.hash}: ` : ""}${c.message}`);

/** Parse a rendered [Commits] section from a summary written without structured state. */
export const parseCommitSection = (section: string): CommitInfo[] => {
	const out: CommitInfo[] = [];
	for (const line of unwrapHeaderLines(section)) {
		if (!line.startsWith("- ")) continue;
		const body = line.slice(2).trim();
		if (!body) continue;
		const m = /^([0-9a-f]{7,40}):\s+(.+)$/.exec(body);
		addCommit(out, m ? { hash: m[1], message: m[2] } : { message: body });
	}
	return out;
};

/** Validate persisted state read back from a session file. */
export const readCommits = (raw: unknown): CommitInfo[] | undefined => {
	if (!Array.isArray(raw)) return undefined;
	const out: CommitInfo[] = [];
	for (const item of raw) {
		if (!item || typeof item !== "object") continue;
		const { hash, message } = item as { hash?: unknown; message?: unknown };
		if (typeof message !== "string" || !message) continue;
		out.push(typeof hash === "string" && hash ? { hash, message } : { message });
	}
	return out;
};
