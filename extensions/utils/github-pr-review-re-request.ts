import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type { PullRequestInfo } from "./github-pr-review-comments.ts";

const PR_REVIEWERS_VIEW_JSON_FIELDS = "latestReviews,reviewRequests" as const;

type GithubReviewState = "APPROVED" | "CHANGES_REQUESTED" | "COMMENTED" | "DISMISSED" | "PENDING";

interface ExecResultLike {
	code: number;
	stdout?: string;
	stderr?: string;
}

interface PullRequestReviewerRecord {
	kind: "user" | "team";
	key: string;
	label: string;
	state: GithubReviewState | null;
	isRequested: boolean;
}

export interface PullRequestReviewReRequestPlan {
	totalReviewerCount: number;
	approvedReviewerCount: number;
	targetUsers: string[];
	targetTeams: string[];
	targetLabels: string[];
	approvedLabels: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asArray(value: unknown): unknown[] {
	return Array.isArray(value) ? value : [];
}

function readString(value: unknown): string | null {
	return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function readNestedString(record: Record<string, unknown>, ...keys: string[]): string | null {
	let current: unknown = record;
	for (const key of keys) {
		if (!isRecord(current)) return null;
		current = current[key];
	}
	return readString(current);
}

function extractReviewState(review: unknown): GithubReviewState | null {
	if (!isRecord(review)) return null;
	const state =
		readString(review.state) ?? readString(review.reviewDecision) ?? readNestedString(review, "latestReview", "state");
	if (!state) return null;
	return state as GithubReviewState;
}

function extractReviewAuthor(review: unknown): string | null {
	if (!isRecord(review)) return null;
	return readNestedString(review, "author", "login") ?? readNestedString(review, "login");
}

function extractRequestedUser(request: unknown): { key: string; label: string } | null {
	if (!isRecord(request)) return null;
	const login =
		readNestedString(request, "requestedReviewer", "login") ?? readString(request.login) ?? readString(request.name);
	if (!login) return null;
	return { key: login, label: `@${login}` };
}

function extractRequestedTeam(request: unknown): { key: string; label: string } | null {
	if (!isRecord(request)) return null;
	const reviewer = isRecord(request.requestedReviewer) ? request.requestedReviewer : request;
	const slug = readString(reviewer.slug);
	if (!slug) return null;
	const org = readNestedString(reviewer, "organization", "login");
	return {
		key: slug,
		label: org ? `@${org}/${slug}` : `@${slug}`,
	};
}

export function parsePullRequestReviewReRequestPlan(stdout: string): PullRequestReviewReRequestPlan | null {
	try {
		const parsed = JSON.parse(stdout) as { latestReviews?: unknown; reviewRequests?: unknown };
		const reviewers = new Map<string, PullRequestReviewerRecord>();

		for (const request of asArray(parsed.reviewRequests)) {
			const team = extractRequestedTeam(request);
			if (team) {
				reviewers.set(`team:${team.key}`, {
					kind: "team",
					key: team.key,
					label: team.label,
					state: null,
					isRequested: true,
				});
				continue;
			}
			const user = extractRequestedUser(request);
			if (!user) continue;
			reviewers.set(`user:${user.key}`, {
				kind: "user",
				key: user.key,
				label: user.label,
				state: null,
				isRequested: true,
			});
		}

		for (const review of asArray(parsed.latestReviews)) {
			const reviewer = extractReviewAuthor(review);
			const state = extractReviewState(review);
			if (!reviewer || !state) continue;
			const reviewerKey = `user:${reviewer}`;
			const existing = reviewers.get(reviewerKey);
			reviewers.set(reviewerKey, {
				kind: "user",
				key: reviewer,
				label: `@${reviewer}`,
				state,
				isRequested: existing?.isRequested ?? false,
			});
		}

		const allReviewers = [...reviewers.values()].sort((left, right) => left.label.localeCompare(right.label));
		const approvedLabels = allReviewers
			.filter((reviewer) => reviewer.kind === "user" && reviewer.state === "APPROVED")
			.map((reviewer) => reviewer.label);
		const targetUsers = allReviewers
			.filter((reviewer) => reviewer.kind === "user" && reviewer.state !== "APPROVED")
			.map((reviewer) => reviewer.key);
		const targetTeams = allReviewers.filter((reviewer) => reviewer.kind === "team").map((reviewer) => reviewer.key);
		const targetLabels = allReviewers
			.filter((reviewer) => (reviewer.kind === "team" ? true : reviewer.state !== "APPROVED"))
			.map((reviewer) => reviewer.label);

		return {
			totalReviewerCount: allReviewers.length,
			approvedReviewerCount: approvedLabels.length,
			targetUsers,
			targetTeams,
			targetLabels,
			approvedLabels,
		};
	} catch {
		return null;
	}
}

function buildPullRequestReviewReRequestArgs(
	pullRequest: PullRequestInfo,
	plan: Pick<PullRequestReviewReRequestPlan, "targetUsers" | "targetTeams">,
): string[] {
	const args = [
		"api",
		"--method",
		"POST",
		"-H",
		"Accept: application/vnd.github+json",
		"-H",
		"X-GitHub-Api-Version: 2022-11-28",
		`repos/${pullRequest.owner}/${pullRequest.repo}/pulls/${pullRequest.number}/requested_reviewers`,
	] as string[];
	for (const reviewer of plan.targetUsers) {
		args.push("-f", `reviewers[]=${reviewer}`);
	}
	for (const team of plan.targetTeams) {
		args.push("-f", `team_reviewers[]=${team}`);
	}
	return args;
}

async function execGh(pi: ExtensionAPI, cwd: string, args: string[]): Promise<ExecResultLike> {
	return pi.exec("gh", args, { cwd });
}

export async function fetchPullRequestReviewReRequestPlan(
	pi: ExtensionAPI,
	cwd: string,
	pullRequest: PullRequestInfo,
): Promise<PullRequestReviewReRequestPlan | null> {
	const result = await execGh(pi, cwd, [
		"pr",
		"view",
		String(pullRequest.number),
		"--json",
		PR_REVIEWERS_VIEW_JSON_FIELDS,
	]);
	if (result.code !== 0) return null;
	return parsePullRequestReviewReRequestPlan(result.stdout ?? "");
}

export async function requestPullRequestReviewReRequest(
	pi: ExtensionAPI,
	cwd: string,
	pullRequest: PullRequestInfo,
	plan: Pick<PullRequestReviewReRequestPlan, "targetUsers" | "targetTeams">,
): Promise<ExecResultLike> {
	return execGh(pi, cwd, buildPullRequestReviewReRequestArgs(pullRequest, plan));
}

export const GITHUB_PR_REVIEW_RE_REQUEST_INTERNALS = {
	PR_REVIEWERS_VIEW_JSON_FIELDS,
	buildPullRequestReviewReRequestArgs,
};
