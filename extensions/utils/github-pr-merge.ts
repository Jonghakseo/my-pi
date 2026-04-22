import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type { PullRequestInfo } from "./github-pr-review-comments.ts";

const PR_MERGE_VIEW_JSON_FIELDS = "headRefOid,isDraft,mergeStateStatus,reviewDecision" as const;

type PullRequestMergeStateStatus =
	| "BEHIND"
	| "BLOCKED"
	| "CLEAN"
	| "DIRTY"
	| "DRAFT"
	| "HAS_HOOKS"
	| "UNKNOWN"
	| "UNSTABLE";

type PullRequestReviewDecision = "APPROVED" | "CHANGES_REQUESTED" | "REVIEW_REQUIRED";

interface ExecResultLike {
	code: number;
	stdout?: string;
	stderr?: string;
}

export interface PullRequestMergeStatus {
	headRefOid: string | null;
	isDraft: boolean;
	mergeStateStatus: PullRequestMergeStateStatus | null;
	reviewDecision: PullRequestReviewDecision | null;
}

function readString(value: unknown): string | null {
	return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function readBoolean(value: unknown): boolean {
	return value === true;
}

export function parsePullRequestMergeStatus(stdout: string): PullRequestMergeStatus | null {
	try {
		const parsed = JSON.parse(stdout) as {
			headRefOid?: unknown;
			isDraft?: unknown;
			mergeStateStatus?: unknown;
			reviewDecision?: unknown;
		};
		return {
			headRefOid: readString(parsed.headRefOid),
			isDraft: readBoolean(parsed.isDraft),
			mergeStateStatus: readString(parsed.mergeStateStatus) as PullRequestMergeStateStatus | null,
			reviewDecision: readString(parsed.reviewDecision) as PullRequestReviewDecision | null,
		};
	} catch {
		return null;
	}
}

function buildPullRequestMergeArgs(pullRequest: PullRequestInfo, status: PullRequestMergeStatus): string[] {
	const args = ["pr", "merge", String(pullRequest.number), "--merge"] as string[];
	if (status.headRefOid) args.push("--match-head-commit", status.headRefOid);
	return args;
}

async function execGh(pi: ExtensionAPI, cwd: string, args: string[]): Promise<ExecResultLike> {
	return pi.exec("gh", args, { cwd });
}

export async function fetchPullRequestMergeStatus(
	pi: ExtensionAPI,
	cwd: string,
	pullRequest: PullRequestInfo,
): Promise<PullRequestMergeStatus | null> {
	const result = await execGh(pi, cwd, ["pr", "view", String(pullRequest.number), "--json", PR_MERGE_VIEW_JSON_FIELDS]);
	if (result.code !== 0) return null;
	return parsePullRequestMergeStatus(result.stdout ?? "");
}

export async function mergePullRequest(
	pi: ExtensionAPI,
	cwd: string,
	pullRequest: PullRequestInfo,
	status: PullRequestMergeStatus,
): Promise<ExecResultLike> {
	return execGh(pi, cwd, buildPullRequestMergeArgs(pullRequest, status));
}

export const GITHUB_PR_MERGE_INTERNALS = {
	PR_MERGE_VIEW_JSON_FIELDS,
	buildPullRequestMergeArgs,
};
