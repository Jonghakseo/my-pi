/**
 * Pure git/diff/CI utilities extracted from diff-overlay.ts and github-overlay.ts.
 *
 * All functions are deterministic and side-effect free.
 */

// ─── Types ─────────────────────────────────────────────────────────────────

export type DiffFileStatus = "added" | "deleted" | "renamed" | "copied" | "modified" | "untracked";

export type CheckState = "success" | "failed" | "pending" | "neutral";

export interface GitStatusPorcelainV2Summary {
	head: string | null;
	upstream: string | null;
	ahead: number;
	behind: number;
	isDetached: boolean;
	isDirty: boolean;
}

export interface CheckInfo {
	name: string;
	kind: "check-run" | "status-context";
	state: CheckState;
	detail: string;
	url: string | null;
}

export interface CheckSummary {
	total: number;
	success: number;
	failed: number;
	pending: number;
	neutral: number;
}

export interface OverlayFetchResult {
	data: { pr: { number: number }; repo: string } | null;
	error: string | null;
	warnings: string[];
}

// ─── Git status parsing ────────────────────────────────────────────────────

const BRANCH_HEAD_PREFIX = "# branch.head ";
const BRANCH_UPSTREAM_PREFIX = "# branch.upstream ";
const BRANCH_AB_PREFIX = "# branch.ab ";

/** Parse `git status --porcelain=v2 --branch` output into a footer-friendly summary. */
export function parseGitStatusPorcelainV2(output: string): GitStatusPorcelainV2Summary {
	let head: string | null = null;
	let upstream: string | null = null;
	let ahead = 0;
	let behind = 0;
	let isDetached = false;
	let isDirty = false;

	for (const rawLine of output.split(/\r?\n/u)) {
		const line = rawLine.trimEnd();
		if (!line) continue;

		if (line.startsWith(BRANCH_HEAD_PREFIX)) {
			const value = line.slice(BRANCH_HEAD_PREFIX.length).trim();
			if (!value || value === "(detached)" || value === "(unknown)") {
				head = null;
				isDetached = value === "(detached)";
			} else {
				head = value;
				isDetached = false;
			}
			continue;
		}

		if (line.startsWith(BRANCH_UPSTREAM_PREFIX)) {
			const value = line.slice(BRANCH_UPSTREAM_PREFIX.length).trim();
			upstream = value || null;
			continue;
		}

		if (line.startsWith(BRANCH_AB_PREFIX)) {
			const match = line
				.slice(BRANCH_AB_PREFIX.length)
				.trim()
				.match(/^\+(\d+)\s+-(\d+)$/u);
			if (match) {
				ahead = Number(match[1]);
				behind = Number(match[2]);
			}
			continue;
		}

		if (line.startsWith("# ") || line.startsWith("! ")) {
			continue;
		}

		isDirty = true;
	}

	return {
		head,
		upstream,
		ahead,
		behind,
		isDetached,
		isDirty,
	};
}

// ─── Diff status mapping (from diff-overlay.ts) ───────────────────────────

/** Map a single-char git diff status code to a friendly status. */
export function mapDiffStatusCode(code: string): DiffFileStatus {
	const c = code.charAt(0);
	if (c === "A") return "added";
	if (c === "D") return "deleted";
	if (c === "R") return "renamed";
	if (c === "C") return "copied";
	return "modified";
}

/** Parse a two-char git porcelain status code to a friendly status. */
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

/** Get an icon character for a diff file status. */
export function diffIcon(status: DiffFileStatus): string {
	if (status === "added" || status === "untracked") return "+";
	if (status === "deleted") return "-";
	if (status === "renamed") return "→";
	if (status === "copied") return "©";
	return "~";
}

/** Get a theme color name for a diff file status. */
export function diffStatusColor(status: DiffFileStatus): string {
	if (status === "added" || status === "untracked") return "success";
	if (status === "deleted") return "error";
	return "warning";
}

// ─── CI check mapping (from github-overlay.ts) ────────────────────────────

/** Map a check run's status/conclusion to a CheckState. */
export function mapCheckStateFromCheckRun(status: string, conclusion: string): CheckState {
	if (status && status !== "COMPLETED") return "pending";
	if (["SUCCESS", "NEUTRAL"].includes(conclusion)) return "success";
	if (["FAILURE", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED", "STARTUP_FAILURE"].includes(conclusion)) {
		return "failed";
	}
	if (!conclusion) return "pending";
	return "neutral";
}

/** Map a status context state to a CheckState. */
export function mapCheckStateFromStatusContext(state: string): CheckState {
	if (["SUCCESS"].includes(state)) return "success";
	if (["FAILURE", "ERROR"].includes(state)) return "failed";
	if (["PENDING", "EXPECTED"].includes(state)) return "pending";
	return "neutral";
}

/** Summarize an array of check results into counts by state. */
export function summarizeChecks(checks: CheckInfo[]): CheckSummary {
	const summary: CheckSummary = {
		total: checks.length,
		success: 0,
		failed: 0,
		pending: 0,
		neutral: 0,
	};

	for (const check of checks) {
		summary[check.state] += 1;
	}

	return summary;
}

// ─── Plain-text summary (from github-overlay.ts) ──────────────────────────

/** Render a plain-text summary of an overlay fetch result (for non-UI mode). */
export function renderPlainSummary(result: {
	data: {
		repo: string;
		pr: {
			number: number;
			title: string;
			url?: string;
			state: string;
			isDraft: boolean;
			reviewDecision: string;
			mergeStateStatus: string;
			headRefName: string;
			baseRefName: string;
			labels: string[];
			requestedReviewers: string[];
		};
		checkSummary: CheckSummary;
		generalComments: unknown[];
		totalThreads: number;
		totalInlineComments: number;
	} | null;
	error: string | null;
	warnings: string[];
}): string {
	if (result.error) {
		return `GitHub PR 조회 실패: ${result.error}`;
	}
	if (!result.data) {
		return "표시할 GitHub PR 데이터가 없습니다.";
	}

	const { data } = result;
	const lines: string[] = [];
	lines.push(`${data.repo} · PR #${data.pr.number}`);
	lines.push(`${data.pr.title}`);
	if (data.pr.url) lines.push(data.pr.url);
	lines.push(
		`state=${data.pr.state}${data.pr.isDraft ? " (draft)" : ""} review=${data.pr.reviewDecision} merge=${data.pr.mergeStateStatus}`,
	);
	lines.push(`${data.pr.headRefName} -> ${data.pr.baseRefName}`);
	lines.push(`labels: ${data.pr.labels.join(", ") || "(none)"}`);
	lines.push(`reviewers: ${data.pr.requestedReviewers.join(", ") || "(none)"}`);
	lines.push(
		`checks: total=${data.checkSummary.total} success=${data.checkSummary.success} failed=${data.checkSummary.failed} pending=${data.checkSummary.pending}`,
	);
	lines.push(`general comments: ${data.generalComments.length}`);
	lines.push(`inline threads: ${data.totalThreads}, comments: ${data.totalInlineComments}`);

	if (result.warnings.length > 0) {
		lines.push("");
		for (const warning of result.warnings) {
			lines.push(`warning: ${warning}`);
		}
	}

	return lines.join("\n");
}
