import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

const CURRENT_PR_VIEW_ARGS = ["pr", "view", "--json", "number,title,url"] as const;
const REVIEW_THREADS_PAGE_SIZE = 100;
const REVIEW_COMMENTS_PAGE_SIZE = 100;

const REVIEW_THREADS_QUERY = [
	"query($owner:String!, $repo:String!, $number:Int!, $after:String) {",
	"  repository(owner:$owner, name:$repo) {",
	"    pullRequest(number:$number) {",
	"      reviewThreads(first:100, after:$after) {",
	"        pageInfo { hasNextPage endCursor }",
	"        nodes {",
	"          id",
	"          isResolved",
	"          isOutdated",
	"          path",
	"          line",
	"          originalLine",
	"          startLine",
	"          originalStartLine",
	"          comments(first:100) {",
	"            totalCount",
	"            pageInfo { hasNextPage endCursor }",
	"            nodes {",
	"              author { login }",
	"              body",
	"              url",
	"              createdAt",
	"            }",
	"          }",
	"        }",
	"      }",
	"    }",
	"  }",
	"}",
].join("\n");

const REVIEW_THREAD_COMMENTS_QUERY = [
	"query($threadId:ID!, $after:String) {",
	"  node(id:$threadId) {",
	"    ... on PullRequestReviewThread {",
	"      comments(first:100, after:$after) {",
	"        totalCount",
	"        pageInfo { hasNextPage endCursor }",
	"        nodes {",
	"          author { login }",
	"          body",
	"          url",
	"          createdAt",
	"        }",
	"      }",
	"    }",
	"  }",
	"}",
].join("\n");

export interface PullRequestInfo {
	number: number;
	title: string | null;
	url: string;
	owner: string;
	repo: string;
}

export interface PullRequestReviewComment {
	author: string | null;
	body: string;
	url: string | null;
	createdAt: string | null;
}

export interface PullRequestReviewThread {
	id: string;
	path: string | null;
	line: number | null;
	originalLine: number | null;
	startLine: number | null;
	originalStartLine: number | null;
	comments: PullRequestReviewComment[];
}

export interface PullRequestReviewCommentsSummary {
	pullRequest: PullRequestInfo;
	threads: PullRequestReviewThread[];
}

export type CurrentPullRequestResult =
	| { ok: true; pullRequest: PullRequestInfo }
	| { ok: false; reason: "not-found" | "gh-error" | "parse-error"; detail: string | null };

interface PageInfo {
	hasNextPage: boolean;
	endCursor: string | null;
}

interface ParsedReviewThreadsPage {
	threads: Array<{
		id: string;
		isResolved: boolean;
		isOutdated: boolean;
		path: string | null;
		line: number | null;
		originalLine: number | null;
		startLine: number | null;
		originalStartLine: number | null;
		comments: PullRequestReviewComment[];
		commentsPageInfo: PageInfo;
	}>;
	pageInfo: PageInfo;
}

interface ParsedReviewCommentsPage {
	comments: PullRequestReviewComment[];
	pageInfo: PageInfo;
}

interface ExecResultLike {
	code: number;
	stdout?: string;
	stderr?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asArray(value: unknown): unknown[] {
	return Array.isArray(value) ? value : [];
}

function readNumber(value: unknown): number | null {
	return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function readString(value: unknown): string | null {
	return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function readBoolean(value: unknown): boolean {
	return value === true;
}

function normalizeExecText(text: string | undefined): string {
	return (text ?? "").trim();
}

export function isNoPullRequestError(text: string): boolean {
	return text.toLowerCase().includes("no pull requests found");
}

export function parseGitHubPullUrl(url: string | null): { owner: string; repo: string; number: number } | null {
	if (!url) return null;
	const match = url.match(/^https:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)(?:\/.*)?$/u);
	if (!match) return null;
	return {
		owner: match[1],
		repo: match[2],
		number: Number(match[3]),
	};
}

export function parseCurrentPullRequest(stdout: string): PullRequestInfo | null {
	try {
		const parsed = JSON.parse(stdout) as { number?: unknown; title?: unknown; url?: unknown };
		const url = readString(parsed.url);
		const info = parseGitHubPullUrl(url);
		if (!info) return null;
		const number = readNumber(parsed.number) ?? info.number;
		return {
			number,
			title: readString(parsed.title),
			url: url ?? "",
			owner: info.owner,
			repo: info.repo,
		};
	} catch {
		return null;
	}
}

function readPageInfo(value: unknown): PageInfo {
	if (!isRecord(value)) {
		return { hasNextPage: false, endCursor: null };
	}
	return {
		hasNextPage: readBoolean(value.hasNextPage),
		endCursor: readString(value.endCursor),
	};
}

function parseReviewComment(comment: unknown): PullRequestReviewComment | null {
	if (!isRecord(comment)) return null;
	const body = typeof comment.body === "string" ? comment.body : "";
	return {
		author: isRecord(comment.author) ? readString(comment.author.login) : null,
		body,
		url: readString(comment.url),
		createdAt: readString(comment.createdAt),
	};
}

export function parseReviewThreadsPage(stdout: string): ParsedReviewThreadsPage | null {
	try {
		const parsed = JSON.parse(stdout) as {
			data?: {
				repository?: {
					pullRequest?: {
						reviewThreads?: {
							nodes?: unknown[];
							pageInfo?: unknown;
						};
					};
				};
			};
		};
		const reviewThreads = parsed.data?.repository?.pullRequest?.reviewThreads;
		if (!isRecord(reviewThreads)) return null;
		const pageInfo = readPageInfo(reviewThreads.pageInfo);
		const threads = asArray(reviewThreads.nodes)
			.map((thread) => {
				if (!isRecord(thread)) return null;
				const id = readString(thread.id);
				if (!id) return null;
				const commentsRecord = isRecord(thread.comments) ? thread.comments : null;
				const comments = asArray(commentsRecord?.nodes)
					.map((comment) => parseReviewComment(comment))
					.filter((comment): comment is PullRequestReviewComment => comment !== null);
				return {
					id,
					isResolved: readBoolean(thread.isResolved),
					isOutdated: readBoolean(thread.isOutdated),
					path: readString(thread.path),
					line: readNumber(thread.line),
					originalLine: readNumber(thread.originalLine),
					startLine: readNumber(thread.startLine),
					originalStartLine: readNumber(thread.originalStartLine),
					comments,
					commentsPageInfo: readPageInfo(commentsRecord?.pageInfo),
				};
			})
			.filter(
				(
					thread,
				): thread is {
					id: string;
					isResolved: boolean;
					isOutdated: boolean;
					path: string | null;
					line: number | null;
					originalLine: number | null;
					startLine: number | null;
					originalStartLine: number | null;
					comments: PullRequestReviewComment[];
					commentsPageInfo: PageInfo;
				} => thread !== null,
			);
		return { threads, pageInfo };
	} catch {
		return null;
	}
}

export function parseReviewCommentsPage(stdout: string): ParsedReviewCommentsPage | null {
	try {
		const parsed = JSON.parse(stdout) as {
			data?: {
				node?: {
					comments?: {
						nodes?: unknown[];
						pageInfo?: unknown;
					};
				};
			};
		};
		const comments = isRecord(parsed.data?.node?.comments) ? parsed.data?.node?.comments : null;
		if (!comments) return null;
		return {
			comments: asArray(comments.nodes)
				.map((comment) => parseReviewComment(comment))
				.filter((comment): comment is PullRequestReviewComment => comment !== null),
			pageInfo: readPageInfo(comments.pageInfo),
		};
	} catch {
		return null;
	}
}

export function countUnresolvedReviewComments(threads: PullRequestReviewThread[]): number {
	return threads.reduce((total, thread) => total + thread.comments.length, 0);
}

function formatThreadLocation(thread: PullRequestReviewThread): string {
	const path = thread.path ?? "(unknown file)";
	const start = thread.startLine ?? thread.originalStartLine;
	const end = thread.line ?? thread.originalLine;
	if (start && end && start !== end) return `${path}:${start}-${end}`;
	if (end) return `${path}:${end}`;
	if (start) return `${path}:${start}`;
	return path;
}

function formatCommentBody(body: string): string {
	const text = body.trim();
	if (!text) return "  _(no body)_";
	return text
		.split(/\r?\n/u)
		.map((line) => `  ${line || " "}`)
		.join("\n");
}

export function formatUnresolvedReviewCommentsForEditor(summary: PullRequestReviewCommentsSummary): string {
	const lines = [`## Unresolved PR review comments — PR #${summary.pullRequest.number}`];
	if (summary.pullRequest.title) lines.push(`Title: ${summary.pullRequest.title}`);
	lines.push(`URL: ${summary.pullRequest.url}`, "");

	summary.threads.forEach((thread, index) => {
		lines.push(`### ${index + 1}. ${formatThreadLocation(thread)}`);
		for (const comment of thread.comments) {
			lines.push(`- ${comment.author ?? "unknown"}${comment.url ? ` — ${comment.url}` : ""}`);
			lines.push(formatCommentBody(comment.body), "");
		}
	});

	return lines.join("\n").trimEnd();
}

function buildReviewThreadsArgs(pullRequest: PullRequestInfo, after: string | null): string[] {
	const args = [
		"api",
		"graphql",
		"-f",
		`query=${REVIEW_THREADS_QUERY}`,
		"-F",
		`owner=${pullRequest.owner}`,
		"-F",
		`repo=${pullRequest.repo}`,
		"-F",
		`number=${pullRequest.number}`,
	] as string[];
	if (after) {
		args.push("-F", `after=${after}`);
	}
	return args;
}

function buildReviewThreadCommentsArgs(threadId: string, after: string | null): string[] {
	const args = ["api", "graphql", "-f", `query=${REVIEW_THREAD_COMMENTS_QUERY}`, "-F", `threadId=${threadId}`];
	if (after) {
		args.push("-F", `after=${after}`);
	}
	return args;
}

async function execGh(pi: ExtensionAPI, cwd: string, args: string[]): Promise<ExecResultLike> {
	return pi.exec("gh", args, { cwd });
}

export async function fetchCurrentPullRequestInfo(pi: ExtensionAPI, cwd: string): Promise<CurrentPullRequestResult> {
	const result = await execGh(pi, cwd, [...CURRENT_PR_VIEW_ARGS]);
	if (result.code !== 0) {
		const detail = normalizeExecText(result.stderr) || normalizeExecText(result.stdout) || null;
		return {
			ok: false,
			reason: detail && isNoPullRequestError(detail) ? "not-found" : "gh-error",
			detail,
		};
	}

	const pullRequest = parseCurrentPullRequest(result.stdout ?? "");
	if (!pullRequest) {
		return { ok: false, reason: "parse-error", detail: normalizeExecText(result.stdout) || null };
	}
	return { ok: true, pullRequest };
}

async function fetchRemainingReviewThreadComments(
	pi: ExtensionAPI,
	cwd: string,
	threadId: string,
	initialComments: PullRequestReviewComment[],
	initialPageInfo: PageInfo,
): Promise<PullRequestReviewComment[] | null> {
	const comments = [...initialComments];
	let pageInfo = initialPageInfo;

	while (pageInfo.hasNextPage && pageInfo.endCursor) {
		const commentsResult = await execGh(pi, cwd, buildReviewThreadCommentsArgs(threadId, pageInfo.endCursor));
		if (commentsResult.code !== 0) return null;
		const commentsPage = parseReviewCommentsPage(commentsResult.stdout ?? "");
		if (!commentsPage) return null;
		comments.push(...commentsPage.comments);
		pageInfo = commentsPage.pageInfo;
	}

	return comments;
}

async function toUnresolvedReviewThread(
	pi: ExtensionAPI,
	cwd: string,
	thread: ParsedReviewThreadsPage["threads"][number],
): Promise<PullRequestReviewThread | null> {
	if (thread.isResolved) return null;
	const comments = await fetchRemainingReviewThreadComments(
		pi,
		cwd,
		thread.id,
		thread.comments,
		thread.commentsPageInfo,
	);
	if (!comments) return null;
	return {
		id: thread.id,
		path: thread.path,
		line: thread.line,
		originalLine: thread.originalLine,
		startLine: thread.startLine,
		originalStartLine: thread.originalStartLine,
		comments,
	};
}

export async function fetchUnresolvedPullRequestReviewThreads(
	pi: ExtensionAPI,
	cwd: string,
	pullRequest: PullRequestInfo,
): Promise<PullRequestReviewThread[] | null> {
	const unresolvedThreads: PullRequestReviewThread[] = [];
	let after: string | null = null;

	while (true) {
		const result = await execGh(pi, cwd, buildReviewThreadsArgs(pullRequest, after));
		if (result.code !== 0) return null;
		const page = parseReviewThreadsPage(result.stdout ?? "");
		if (!page) return null;

		for (const thread of page.threads) {
			const unresolvedThread = await toUnresolvedReviewThread(pi, cwd, thread);
			if (thread.isResolved) continue;
			if (!unresolvedThread) return null;
			unresolvedThreads.push(unresolvedThread);
		}

		if (!page.pageInfo.hasNextPage || !page.pageInfo.endCursor) break;
		after = page.pageInfo.endCursor;
	}

	return unresolvedThreads;
}

export async function fetchUnresolvedPullRequestReviewComments(
	pi: ExtensionAPI,
	cwd: string,
	pullRequest: PullRequestInfo,
): Promise<PullRequestReviewCommentsSummary | null> {
	const threads = await fetchUnresolvedPullRequestReviewThreads(pi, cwd, pullRequest);
	if (!threads) return null;
	return { pullRequest, threads };
}

export async function fetchUnresolvedPullRequestReviewCommentsCount(
	pi: ExtensionAPI,
	cwd: string,
	prUrl: string | null,
): Promise<number | null> {
	const info = parseGitHubPullUrl(prUrl);
	if (!info) return null;
	const summary = await fetchUnresolvedPullRequestReviewComments(pi, cwd, {
		number: info.number,
		title: null,
		url: prUrl ?? "",
		owner: info.owner,
		repo: info.repo,
	});
	if (!summary) return null;
	return countUnresolvedReviewComments(summary.threads);
}

export const GITHUB_PR_REVIEW_COMMENTS_INTERNALS = {
	CURRENT_PR_VIEW_ARGS,
	REVIEW_THREADS_PAGE_SIZE,
	REVIEW_COMMENTS_PAGE_SIZE,
};
