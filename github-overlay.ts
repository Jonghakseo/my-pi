import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { DynamicBorder } from "@mariozechner/pi-coding-agent";
import { Key, matchesKey, truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";

const PR_VIEW_FIELDS = [
	"number",
	"title",
	"url",
	"state",
	"isDraft",
	"reviewDecision",
	"reviewRequests",
	"reviews",
	"labels",
	"statusCheckRollup",
	"headRefName",
	"baseRefName",
	"author",
	"updatedAt",
	"mergeStateStatus",
].join(",");

const COMMENTS_PER_PAGE = 100;
const MAX_COMMENT_PAGES = 50;

type CheckState = "success" | "failed" | "pending" | "neutral";

type OverlayFetchResult = {
	data: GithubOverlayData | null;
	error: string | null;
	warnings: string[];
};

interface OverlayState {
	loading: boolean;
	refreshing: boolean;
	data: GithubOverlayData | null;
	error: string | null;
	warnings: string[];
	lastUpdated: string | null;
}

interface OverlayTheme {
	fg: (color: string, text: string) => string;
	bold: (text: string) => string;
}

interface OverlayTui {
	requestRender: () => void;
	height?: number;
}

interface GithubOverlayData {
	repo: string;
	pr: PullRequestInfo;
	checkSummary: {
		total: number;
		success: number;
		failed: number;
		pending: number;
		neutral: number;
	};
	generalComments: GeneralComment[];
	files: FileThreadGroup[];
	totalThreads: number;
	totalInlineComments: number;
}

interface PullRequestInfo {
	number: number;
	title: string;
	url: string;
	state: string;
	isDraft: boolean;
	reviewDecision: string;
	mergeStateStatus: string;
	headRefName: string;
	baseRefName: string;
	author: string;
	updatedAt: string;
	labels: string[];
	requestedReviewers: string[];
	latestReviews: ReviewInfo[];
	checks: CheckInfo[];
}

interface ReviewInfo {
	author: string;
	state: string;
	submittedAt: string | null;
}

interface CheckInfo {
	name: string;
	kind: "check-run" | "status-context";
	state: CheckState;
	detail: string;
	url: string | null;
}

interface GeneralComment {
	id: string;
	source: "issue-comment" | "review-summary";
	author: string;
	body: string;
	createdAt: string | null;
	url: string | null;
	reviewState?: string;
}

interface InlineReviewComment {
	id: number;
	path: string;
	line: number | null;
	originalLine: number | null;
	side: string | null;
	inReplyToId: number | null;
	author: string;
	body: string;
	createdAt: string | null;
	url: string | null;
}

interface ReviewThread {
	rootId: number;
	path: string;
	line: number | null;
	originalLine: number | null;
	side: string | null;
	comments: InlineReviewComment[];
}

interface FileThreadGroup {
	path: string;
	threads: ReviewThread[];
	commentCount: number;
}

type OverlayCommentItem =
	| {
			key: string;
			kind: "general";
			comment: GeneralComment;
	  }
	| {
			key: string;
			kind: "inline";
			filePath: string;
			thread: ReviewThread;
	  };

interface OverlayRenderResult {
	lines: string[];
	itemKeys: string[];
	itemLineByKey: Map<string, number>;
}

function asRecord(value: unknown): Record<string, unknown> | null {
	if (!value || typeof value !== "object" || Array.isArray(value)) return null;
	return value as Record<string, unknown>;
}

function asString(value: unknown): string | null {
	if (typeof value !== "string") return null;
	const trimmed = value.trim();
	return trimmed.length ? trimmed : null;
}

function asBoolean(value: unknown): boolean | null {
	if (typeof value !== "boolean") return null;
	return value;
}

function asNumber(value: unknown): number | null {
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (typeof value === "string") {
		const parsed = Number(value);
		if (Number.isFinite(parsed)) return parsed;
	}
	return null;
}

function asArray(value: unknown): unknown[] {
	return Array.isArray(value) ? value : [];
}

function safeJsonParse<T>(text: string): T | null {
	try {
		return JSON.parse(text) as T;
	} catch {
		return null;
	}
}

function toEpochMs(value: string | null): number {
	if (!value) return 0;
	const parsed = Date.parse(value);
	return Number.isFinite(parsed) ? parsed : 0;
}

function formatIso(value: string | null): string {
	if (!value) return "-";
	const date = new Date(value);
	if (Number.isNaN(date.getTime())) return value;
	return date.toLocaleString();
}

function formatStateLabel(value: string | null): string {
	if (!value) return "UNKNOWN";
	return value.replace(/_/g, " ").toUpperCase();
}

function normalizeWhitespace(text: string): string {
	return text.replace(/\r/g, "").replace(/\t/g, "  ");
}

function splitLongToken(token: string, maxWidth: number): string[] {
	if (token.length <= maxWidth) return [token];
	const out: string[] = [];
	for (let index = 0; index < token.length; index += maxWidth) {
		out.push(token.slice(index, index + maxWidth));
	}
	return out;
}

function wrapText(text: string, maxWidth: number): string[] {
	if (maxWidth <= 1) return [text];
	const normalized = normalizeWhitespace(text);
	const lines = normalized.split("\n");
	const wrapped: string[] = [];

	for (const rawLine of lines) {
		const line = rawLine.trimEnd();
		if (!line.trim()) {
			wrapped.push("");
			continue;
		}

		const words = line.split(/\s+/).flatMap((word) => splitLongToken(word, maxWidth));
		let current = "";

		for (const word of words) {
			if (!current) {
				current = word;
				continue;
			}

			if (`${current} ${word}`.length <= maxWidth) {
				current = `${current} ${word}`;
			} else {
				wrapped.push(current);
				current = word;
			}
		}

		if (current) {
			wrapped.push(current);
		}
	}

	if (!wrapped.length) {
		wrapped.push("");
	}

	return wrapped;
}

function toSingleLinePreview(text: string, maxLength: number): string {
	const normalized = normalizeWhitespace(text).replace(/\n+/g, " ").replace(/\s+/g, " ").trim();
	if (!normalized) return "(empty)";
	if (normalized.length <= maxLength) return normalized;
	return `${normalized.slice(0, Math.max(0, maxLength - 1))}…`;
}

async function runGh(
	pi: ExtensionAPI,
	cwd: string,
	args: string[],
): Promise<{ ok: true; stdout: string } | { ok: false; error: string }> {
	const result = await pi.exec("gh", args, { cwd });
	if (result.code === 0) {
		return { ok: true, stdout: result.stdout ?? "" };
	}

	const stderr = (result.stderr ?? "").trim();
	const stdout = (result.stdout ?? "").trim();
	const detail = stderr || stdout || "Unknown gh error";
	return { ok: false, error: detail };
}

async function runGhJson<T>(
	pi: ExtensionAPI,
	cwd: string,
	args: string[],
): Promise<{ ok: true; data: T } | { ok: false; error: string }> {
	const result = await runGh(pi, cwd, args);
	if (!result.ok) return result;

	const parsed = safeJsonParse<T>(result.stdout);
	if (parsed === null) {
		return {
			ok: false,
			error: `Failed to parse JSON from gh ${args.join(" ")}`,
		};
	}
	return { ok: true, data: parsed };
}

async function getCurrentBranch(pi: ExtensionAPI, cwd: string): Promise<string | null> {
	const result = await pi.exec("git", ["branch", "--show-current"], { cwd });
	if (result.code !== 0) return null;
	const branch = (result.stdout ?? "").trim();
	return branch || null;
}

async function getRepoNameWithOwner(pi: ExtensionAPI, cwd: string): Promise<string | null> {
	const result = await runGh(pi, cwd, ["repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner"]);
	if (!result.ok) return null;
	const value = result.stdout.trim();
	return value || null;
}

function extractReviewerNames(value: unknown, out: Set<string>): void {
	if (value === null || value === undefined) return;

	if (typeof value === "string") {
		const trimmed = value.trim();
		if (trimmed) out.add(trimmed.startsWith("@") ? trimmed : `@${trimmed}`);
		return;
	}

	if (Array.isArray(value)) {
		for (const item of value) {
			extractReviewerNames(item, out);
		}
		return;
	}

	const record = asRecord(value);
	if (!record) return;

	const typename = asString(record.__typename);
	const login = asString(record.login);
	if (login) {
		out.add(`@${login}`);
	}

	const teamSlug = asString(record.slug);
	if (!login && teamSlug) {
		out.add(`team:${teamSlug}`);
	}

	const teamName = asString(record.name);
	if (!login && !teamSlug && teamName && typename === "Team") {
		out.add(`team:${teamName}`);
	}

	if (record.requestedReviewer !== undefined) {
		extractReviewerNames(record.requestedReviewer, out);
	}
	if (record.user !== undefined) {
		extractReviewerNames(record.user, out);
	}
	if (record.team !== undefined) {
		extractReviewerNames(record.team, out);
	}
}

function parseReviews(rawReviews: unknown): ReviewInfo[] {
	const reviews: ReviewInfo[] = [];
	for (const item of asArray(rawReviews)) {
		const record = asRecord(item);
		if (!record) continue;

		const authorRecord = asRecord(record.author);
		const author =
			asString(authorRecord?.login) ?? asString(authorRecord?.name) ?? asString(record.author) ?? "unknown";

		const state = formatStateLabel(asString(record.state));
		const submittedAt = asString(record.submittedAt);
		reviews.push({ author, state, submittedAt });
	}

	const byAuthor = new Map<string, ReviewInfo>();
	for (const review of reviews) {
		const existing = byAuthor.get(review.author);
		if (!existing) {
			byAuthor.set(review.author, review);
			continue;
		}

		if (toEpochMs(review.submittedAt) >= toEpochMs(existing.submittedAt)) {
			byAuthor.set(review.author, review);
		}
	}

	return Array.from(byAuthor.values()).sort((a, b) => a.author.localeCompare(b.author));
}

function mapCheckStateFromCheckRun(status: string, conclusion: string): CheckState {
	if (status && status !== "COMPLETED") return "pending";
	if (["SUCCESS", "NEUTRAL"].includes(conclusion)) return "success";
	if (["FAILURE", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED", "STARTUP_FAILURE"].includes(conclusion)) {
		return "failed";
	}
	if (!conclusion) return "pending";
	return "neutral";
}

function mapCheckStateFromStatusContext(state: string): CheckState {
	if (["SUCCESS"].includes(state)) return "success";
	if (["FAILURE", "ERROR"].includes(state)) return "failed";
	if (["PENDING", "EXPECTED"].includes(state)) return "pending";
	return "neutral";
}

function parseChecks(rawChecks: unknown): CheckInfo[] {
	const checks: CheckInfo[] = [];

	for (const item of asArray(rawChecks)) {
		const record = asRecord(item);
		if (!record) continue;

		const typename = asString(record.__typename);
		const isStatusContext = typename === "StatusContext" || record.context !== undefined;

		if (isStatusContext) {
			const name = asString(record.context) ?? "(status context)";
			const rawState = formatStateLabel(asString(record.state));
			const state = mapCheckStateFromStatusContext(rawState);
			const detail = rawState || "UNKNOWN";
			checks.push({
				name,
				kind: "status-context",
				state,
				detail,
				url: asString(record.targetUrl),
			});
			continue;
		}

		const name = asString(record.name) ?? "(check run)";
		const status = formatStateLabel(asString(record.status));
		const conclusion = formatStateLabel(asString(record.conclusion));
		if (conclusion === "SKIPPED") {
			continue;
		}
		const state = mapCheckStateFromCheckRun(status, conclusion);
		const detail = conclusion && conclusion !== "UNKNOWN" ? conclusion : status || "UNKNOWN";

		checks.push({
			name,
			kind: "check-run",
			state,
			detail,
			url: asString(record.detailsUrl),
		});
	}

	return checks;
}

function summarizeChecks(checks: CheckInfo[]): GithubOverlayData["checkSummary"] {
	const summary = {
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

function parseInlineReviewComment(value: unknown): InlineReviewComment | null {
	const record = asRecord(value);
	if (!record) return null;

	const id = asNumber(record.id);
	if (id === null) return null;

	const user = asRecord(record.user);
	const author = asString(user?.login) ?? asString(user?.name) ?? "unknown";
	const body = asString(record.body) ?? "";

	return {
		id,
		path: asString(record.path) ?? "(unknown file)",
		line: asNumber(record.line),
		originalLine: asNumber(record.original_line),
		side: asString(record.side),
		inReplyToId: asNumber(record.in_reply_to_id),
		author,
		body,
		createdAt: asString(record.created_at),
		url: asString(record.html_url),
	};
}

function parseIssueComment(value: unknown): GeneralComment | null {
	const record = asRecord(value);
	if (!record) return null;

	const id = asNumber(record.id);
	if (id === null) return null;

	const user = asRecord(record.user);
	const author = asString(user?.login) ?? asString(user?.name) ?? "unknown";

	return {
		id: `issue-${id}`,
		source: "issue-comment",
		author,
		body: asString(record.body) ?? "",
		createdAt: asString(record.created_at),
		url: asString(record.html_url),
	};
}

function parseReviewBodyComments(rawReviews: unknown): GeneralComment[] {
	const out: GeneralComment[] = [];

	for (const item of asArray(rawReviews)) {
		const record = asRecord(item);
		if (!record) continue;

		const body = asString(record.body);
		if (!body) continue;

		const authorRecord = asRecord(record.author);
		const author =
			asString(authorRecord?.login) ?? asString(authorRecord?.name) ?? asString(record.author) ?? "unknown";
		const reviewState = formatStateLabel(asString(record.state));
		const id = asString(record.id) ?? String(asNumber(record.id) ?? out.length + 1);

		out.push({
			id: `review-${id}`,
			source: "review-summary",
			author,
			body,
			createdAt: asString(record.submittedAt),
			url: asString(record.url),
			reviewState,
		});
	}

	return out;
}

function buildCommentItems(data: GithubOverlayData): OverlayCommentItem[] {
	const items: OverlayCommentItem[] = [];

	for (const comment of data.generalComments) {
		items.push({
			key: `general:${comment.id}`,
			kind: "general",
			comment,
		});
	}

	for (const file of data.files) {
		for (const thread of file.threads) {
			items.push({
				key: `inline:${file.path}:${thread.rootId}`,
				kind: "inline",
				filePath: file.path,
				thread,
			});
		}
	}

	return items;
}

function groupThreadsByFile(comments: InlineReviewComment[]): {
	files: FileThreadGroup[];
	totalThreads: number;
} {
	const byId = new Map<number, InlineReviewComment>();
	for (const comment of comments) {
		byId.set(comment.id, comment);
	}

	const rootCache = new Map<number, number>();
	const resolveRootId = (comment: InlineReviewComment): number => {
		const cached = rootCache.get(comment.id);
		if (cached !== undefined) return cached;

		let current = comment;
		const seen = new Set<number>([comment.id]);
		while (current.inReplyToId !== null) {
			const parent = byId.get(current.inReplyToId);
			if (!parent) break;
			if (seen.has(parent.id)) break;
			seen.add(parent.id);
			current = parent;
		}

		rootCache.set(comment.id, current.id);
		return current.id;
	};

	const threadMap = new Map<string, ReviewThread>();
	for (const comment of comments) {
		const rootId = resolveRootId(comment);
		const key = `${comment.path}::${rootId}`;
		let thread = threadMap.get(key);
		if (!thread) {
			thread = {
				rootId,
				path: comment.path,
				line: null,
				originalLine: null,
				side: null,
				comments: [],
			};
			threadMap.set(key, thread);
		}

		thread.comments.push(comment);
		if (thread.line === null && comment.line !== null) thread.line = comment.line;
		if (thread.originalLine === null && comment.originalLine !== null) {
			thread.originalLine = comment.originalLine;
		}
		if (thread.side === null && comment.side !== null) thread.side = comment.side;
	}

	for (const thread of threadMap.values()) {
		thread.comments.sort((a, b) => {
			const diff = toEpochMs(a.createdAt) - toEpochMs(b.createdAt);
			if (diff !== 0) return diff;
			return a.id - b.id;
		});
	}

	const fileMap = new Map<string, FileThreadGroup>();
	for (const thread of threadMap.values()) {
		let group = fileMap.get(thread.path);
		if (!group) {
			group = { path: thread.path, threads: [], commentCount: 0 };
			fileMap.set(thread.path, group);
		}
		group.threads.push(thread);
		group.commentCount += thread.comments.length;
	}

	for (const file of fileMap.values()) {
		file.threads.sort((a, b) => {
			const aLine = a.line ?? a.originalLine ?? Number.MAX_SAFE_INTEGER;
			const bLine = b.line ?? b.originalLine ?? Number.MAX_SAFE_INTEGER;
			if (aLine !== bLine) return aLine - bLine;
			return a.rootId - b.rootId;
		});
	}

	const files = Array.from(fileMap.values()).sort((a, b) => a.path.localeCompare(b.path));
	return {
		files,
		totalThreads: Array.from(threadMap.values()).length,
	};
}

function checkTone(theme: OverlayTheme, state: CheckState, text: string): string {
	if (state === "success") return theme.fg("success", text);
	if (state === "failed") return theme.fg("error", text);
	if (state === "pending") return theme.fg("warning", text);
	return theme.fg("muted", text);
}

function reviewTone(theme: OverlayTheme, state: string, text: string): string {
	if (state === "APPROVED") return theme.fg("success", text);
	if (state === "CHANGES REQUESTED") return theme.fg("error", text);
	if (state === "COMMENTED") return theme.fg("warning", text);
	return theme.fg("muted", text);
}

function checkIcon(state: CheckState): string {
	if (state === "success") return "✓";
	if (state === "failed") return "✗";
	if (state === "pending") return "…";
	return "·";
}

async function fetchOverlayData(pi: ExtensionAPI, cwd: string): Promise<OverlayFetchResult> {
	const warnings: string[] = [];

	const repoNameWithOwner = await getRepoNameWithOwner(pi, cwd);
	if (!repoNameWithOwner) {
		return {
			data: null,
			error: "GitHub 저장소를 찾지 못했습니다. gh 로그인/저장소 설정을 확인해주세요.",
			warnings,
		};
	}

	const [owner, repo] = repoNameWithOwner.split("/");
	if (!owner || !repo) {
		return {
			data: null,
			error: `저장소 식별자를 해석하지 못했습니다: ${repoNameWithOwner}`,
			warnings,
		};
	}

	const prResult = await runGhJson<Record<string, unknown>>(pi, cwd, ["pr", "view", "--json", PR_VIEW_FIELDS]);

	if (!prResult.ok) {
		const lowerError = prResult.error.toLowerCase();
		if (lowerError.includes("no pull requests found")) {
			const branch = await getCurrentBranch(pi, cwd);
			const branchSuffix = branch ? ` (branch: ${branch})` : "";
			return {
				data: null,
				error: `현재 브랜치에 연결된 PR이 없습니다${branchSuffix}.`,
				warnings,
			};
		}

		return {
			data: null,
			error: `PR 정보를 가져오지 못했습니다: ${prResult.error}`,
			warnings,
		};
	}

	const prData = prResult.data;
	const prNumber = asNumber(prData.number);
	if (prNumber === null) {
		return {
			data: null,
			error: "PR 번호를 읽지 못했습니다.",
			warnings,
		};
	}

	const requestedReviewersSet = new Set<string>();
	extractReviewerNames(prData.reviewRequests, requestedReviewersSet);

	const labels = asArray(prData.labels)
		.map((label) => asString(asRecord(label)?.name))
		.filter((label): label is string => Boolean(label));

	const checks = parseChecks(prData.statusCheckRollup);
	const checkSummary = summarizeChecks(checks);

	const prInfo: PullRequestInfo = {
		number: prNumber,
		title: asString(prData.title) ?? "(untitled)",
		url: asString(prData.url) ?? "",
		state: formatStateLabel(asString(prData.state)),
		isDraft: asBoolean(prData.isDraft) ?? false,
		reviewDecision: formatStateLabel(asString(prData.reviewDecision)),
		mergeStateStatus: formatStateLabel(asString(prData.mergeStateStatus)),
		headRefName: asString(prData.headRefName) ?? "(unknown)",
		baseRefName: asString(prData.baseRefName) ?? "(unknown)",
		author: asString(asRecord(prData.author)?.login) ?? asString(asRecord(prData.author)?.name) ?? "unknown",
		updatedAt: asString(prData.updatedAt) ?? "",
		labels,
		requestedReviewers: Array.from(requestedReviewersSet).sort((a, b) => a.localeCompare(b)),
		latestReviews: parseReviews(prData.reviews),
		checks,
	};

	const inlineComments: InlineReviewComment[] = [];
	for (let page = 1; page <= MAX_COMMENT_PAGES; page += 1) {
		const commentsResult = await runGhJson<unknown[]>(pi, cwd, [
			"api",
			`repos/${owner}/${repo}/pulls/${prNumber}/comments?per_page=${COMMENTS_PER_PAGE}&page=${page}`,
		]);

		if (!commentsResult.ok) {
			warnings.push(`인라인 리뷰 코멘트를 모두 가져오지 못했습니다: ${commentsResult.error}`);
			break;
		}

		const pageComments = commentsResult.data;
		for (const rawComment of pageComments) {
			const parsed = parseInlineReviewComment(rawComment);
			if (parsed) inlineComments.push(parsed);
		}

		if (pageComments.length < COMMENTS_PER_PAGE) break;
	}

	const generalComments: GeneralComment[] = parseReviewBodyComments(prData.reviews);
	for (let page = 1; page <= MAX_COMMENT_PAGES; page += 1) {
		const commentsResult = await runGhJson<unknown[]>(pi, cwd, [
			"api",
			`repos/${owner}/${repo}/issues/${prNumber}/comments?per_page=${COMMENTS_PER_PAGE}&page=${page}`,
		]);

		if (!commentsResult.ok) {
			warnings.push(`일반 코멘트를 모두 가져오지 못했습니다: ${commentsResult.error}`);
			break;
		}

		const pageComments = commentsResult.data;
		for (const rawComment of pageComments) {
			const parsed = parseIssueComment(rawComment);
			if (parsed) generalComments.push(parsed);
		}

		if (pageComments.length < COMMENTS_PER_PAGE) break;
	}

	generalComments.sort((a, b) => {
		const diff = toEpochMs(a.createdAt) - toEpochMs(b.createdAt);
		if (diff !== 0) return diff;
		return a.id.localeCompare(b.id);
	});

	const grouped = groupThreadsByFile(inlineComments);

	return {
		data: {
			repo: repoNameWithOwner,
			pr: prInfo,
			checkSummary,
			generalComments,
			files: grouped.files,
			totalThreads: grouped.totalThreads,
			totalInlineComments: inlineComments.length,
		},
		error: null,
		warnings,
	};
}

function renderOverlayContent(
	theme: OverlayTheme,
	state: OverlayState,
	width: number,
	selectedKey: string | null,
	expandedKeys: Set<string>,
): OverlayRenderResult {
	const lines: string[] = [];
	const itemKeys: string[] = [];
	const itemLineByKey = new Map<string, number>();

	const pushLine = (line: string) => {
		lines.push(truncateToWidth(line, width));
	};

	const pushWrapped = (text: string, indent: string, tone?: (value: string) => string) => {
		const maxBodyWidth = Math.max(20, width - visibleWidth(indent));
		for (const wrapped of wrapText(text, maxBodyWidth)) {
			const base = wrapped ? `${indent}${wrapped}` : indent;
			pushLine(tone ? tone(base) : base);
		}
	};

	if (state.loading && !state.data) {
		pushLine(theme.fg("muted", "  GitHub PR 정보를 불러오는 중..."));
		pushLine("");
		pushLine(theme.fg("dim", "  gh 로그인 상태와 저장소 연결을 확인하고 있습니다."));
		return { lines, itemKeys, itemLineByKey };
	}

	if (state.error && !state.data) {
		pushLine(theme.fg("error", `  ${state.error}`));
		pushLine("");
		pushLine(theme.fg("dim", "  힌트: gh auth status / gh repo view / gh pr view 를 확인해보세요."));
		return { lines, itemKeys, itemLineByKey };
	}

	if (!state.data) {
		pushLine(theme.fg("error", "  표시할 GitHub 데이터가 없습니다."));
		return { lines, itemKeys, itemLineByKey };
	}

	const data = state.data;
	const pr = data.pr;

	if (state.refreshing) {
		pushLine(theme.fg("warning", "  새로고침 중..."));
		pushLine("");
	}

	if (state.error) {
		pushLine(theme.fg("error", `  마지막 새로고침 에러: ${state.error}`));
		pushLine("");
	}

	if (state.warnings.length > 0) {
		for (const warning of state.warnings) {
			for (const wrapped of wrapText(`⚠ ${warning}`, Math.max(20, width - 4))) {
				pushLine(theme.fg("warning", `  ${wrapped}`));
			}
		}
		pushLine("");
	}

	pushLine(`  ${theme.fg("accent", theme.bold(`#${pr.number} ${pr.title}`))}`);
	if (pr.url) {
		pushLine(`  ${theme.fg("muted", pr.url)}`);
	}
	pushLine("");

	const stateInfo = [
		`state: ${pr.state}${pr.isDraft ? " (DRAFT)" : ""}`,
		`review: ${pr.reviewDecision}`,
		`merge: ${pr.mergeStateStatus}`,
		`author: @${pr.author}`,
	].join("  ·  ");
	pushLine(`  ${theme.fg("success", stateInfo)}`);
	pushLine(`  ${theme.fg("muted", `${pr.headRefName} → ${pr.baseRefName}`)}`);
	pushLine(
		`  ${theme.fg("muted", `updated: ${formatIso(pr.updatedAt || null)}${state.lastUpdated ? `  ·  loaded: ${formatIso(state.lastUpdated)}` : ""}`)}`,
	);
	pushLine("");

	const labels = pr.labels.length ? pr.labels.join(", ") : "(none)";
	const requestedReviewers = pr.requestedReviewers.length ? pr.requestedReviewers.join(", ") : "(none)";
	pushLine(`  ${theme.bold("Labels")}      ${theme.fg("muted", labels)}`);
	pushLine(`  ${theme.bold("Reviewers")}   ${theme.fg("muted", requestedReviewers)}`);

	if (pr.latestReviews.length > 0) {
		pushLine("");
		pushLine(`  ${theme.bold("Latest reviews")}`);
		for (const review of pr.latestReviews) {
			const stateLabel = review.state;
			const meta = `${review.author} · ${stateLabel}${review.submittedAt ? ` · ${formatIso(review.submittedAt)}` : ""}`;
			pushLine(`    ${reviewTone(theme, stateLabel, meta)}`);
		}
	}

	pushLine("");
	const summaryText =
		`total ${data.checkSummary.total}  ` +
		`✓${data.checkSummary.success}  ` +
		`✗${data.checkSummary.failed}  ` +
		`…${data.checkSummary.pending}  ` +
		`·${data.checkSummary.neutral}`;
	pushLine(`  ${theme.bold("CI checks")}  ${theme.fg("muted", summaryText)}`);

	if (pr.checks.length === 0) {
		pushLine(theme.fg("dim", "    (no checks)"));
	} else {
		for (const check of pr.checks) {
			const head = `${checkIcon(check.state)} ${check.name}`;
			const detail = `(${check.detail}${check.kind === "status-context" ? " · status" : ""})`;
			const line = `    ${head} ${detail}`;
			pushLine(checkTone(theme, check.state, line));
		}
	}

	const commentItems = buildCommentItems(data);
	pushLine("");
	pushLine(
		`  ${theme.bold("Comments")} ${theme.fg("muted", `(general ${data.generalComments.length}, inline ${data.totalThreads} threads/${data.totalInlineComments} comments)`)}`,
	);
	pushLine(`  ${theme.fg("dim", "↑/↓ 선택  •  Enter 열기/닫기")}`);

	if (commentItems.length === 0) {
		pushLine(theme.fg("dim", "    (no comments)"));
		return { lines, itemKeys, itemLineByKey };
	}

	for (let index = 0; index < commentItems.length; index += 1) {
		const item = commentItems[index];
		const isSelected = selectedKey === item.key;
		const isExpanded = expandedKeys.has(item.key);
		const cursor = isSelected ? theme.fg("accent", "▶") : theme.fg("dim", " ");
		const fold = theme.fg("warning", isExpanded ? "▼" : "▶");

		itemKeys.push(item.key);
		itemLineByKey.set(item.key, lines.length);

		if (item.kind === "general") {
			const source =
				item.comment.source === "issue-comment"
					? "일반"
					: item.comment.reviewState
						? `리뷰(${item.comment.reviewState})`
						: "리뷰";
			const headerText = `[${source}] @${item.comment.author} · ${formatIso(item.comment.createdAt)}`;
			pushLine(`  ${cursor} ${fold} 💬 ${isSelected ? theme.fg("accent", headerText) : theme.fg("muted", headerText)}`);

			if (isExpanded) {
				const body = item.comment.body || "(empty comment)";
				pushWrapped(body, "      ");
				if (item.comment.url) {
					pushLine(`      ${theme.fg("dim", item.comment.url)}`);
				}
			} else {
				pushLine(`      ${theme.fg("dim", toSingleLinePreview(item.comment.body, 120))}`);
			}
		} else {
			const lineRef = item.thread.line ?? item.thread.originalLine;
			const location = lineRef !== null ? `L${lineRef}` : "line ?";
			const side = item.thread.side ? ` · ${item.thread.side}` : "";
			const headerText = `${item.filePath} · ${location}${side} · ${item.thread.comments.length} comments`;
			pushLine(`  ${cursor} ${fold} 🧵 ${isSelected ? theme.fg("accent", headerText) : theme.fg("muted", headerText)}`);

			if (isExpanded) {
				for (const comment of item.thread.comments) {
					pushLine(`      ${theme.fg("muted", `@${comment.author} · ${formatIso(comment.createdAt)}`)}`);
					pushWrapped(comment.body || "(empty comment)", "        ");
					if (comment.url) {
						pushLine(`        ${theme.fg("dim", comment.url)}`);
					}
					pushLine("");
				}
				while (lines.length > 0 && lines[lines.length - 1] === "") {
					lines.pop();
				}
			} else {
				const participants = Array.from(new Set(item.thread.comments.map((comment) => `@${comment.author}`))).join(
					", ",
				);
				const previewSource = item.thread.comments[0]?.body ?? "";
				const preview = toSingleLinePreview(previewSource, 90);
				pushLine(`      ${theme.fg("dim", `${participants || "(no authors)"} · ${preview}`)}`);
			}
		}

		if (index < commentItems.length - 1) {
			pushLine("");
		}
	}

	while (lines.length > 0 && !lines[lines.length - 1]) {
		lines.pop();
	}

	return { lines, itemKeys, itemLineByKey };
}

function renderFrameBorder(width: number, top: boolean, theme: OverlayTheme): string {
	const inner = "─".repeat(Math.max(0, width - 2));
	const edge = top ? ["┌", "┐"] : ["└", "┘"];
	return theme.fg("accent", `${edge[0]}${inner}${edge[1]}`);
}

function renderFramedLine(content: string, contentWidth: number, theme: OverlayTheme): string {
	const clipped = truncateToWidth(content, Math.max(0, contentWidth));
	const pad = Math.max(0, contentWidth - visibleWidth(clipped));
	return `${theme.fg("accent", "│")} ${clipped}${" ".repeat(pad)} ${theme.fg("accent", "│")}`;
}

class GithubOverlayUI {
	private scrollOffset = 0;
	private totalLines: string[] = [];
	private commentKeys: string[] = [];
	private itemLineByKey = new Map<string, number>();
	private selectedIndex = 0;
	private expandedKeys = new Set<string>();

	constructor(
		private state: OverlayState,
		private onDone: () => void,
		private onRefresh: () => Promise<void>,
	) {}

	private selectedKey(): string | null {
		return this.commentKeys[this.selectedIndex] ?? null;
	}

	private clampSelection(): void {
		if (this.commentKeys.length === 0) {
			this.selectedIndex = 0;
			return;
		}
		this.selectedIndex = Math.max(0, Math.min(this.selectedIndex, this.commentKeys.length - 1));
	}

	private ensureSelectedVisible(visibleHeight: number): void {
		if (this.commentKeys.length === 0) return;
		const key = this.selectedKey();
		if (!key) return;
		const line = this.itemLineByKey.get(key);
		if (line === undefined) return;

		if (line < this.scrollOffset) {
			this.scrollOffset = line;
			return;
		}

		if (line >= this.scrollOffset + visibleHeight) {
			this.scrollOffset = Math.max(0, line - visibleHeight + 1);
		}
	}

	private toggleSelectedItem(): void {
		const key = this.selectedKey();
		if (!key) return;
		if (this.expandedKeys.has(key)) {
			this.expandedKeys.delete(key);
		} else {
			this.expandedKeys.add(key);
		}
	}

	handleInput(data: string, tui: OverlayTui): void {
		const maxScroll = Math.max(0, this.totalLines.length - 5);
		const hasSelectableComments = this.commentKeys.length > 0;

		if (matchesKey(data, Key.up) || data === "k") {
			if (hasSelectableComments) {
				this.selectedIndex = Math.max(0, this.selectedIndex - 1);
			} else {
				this.scrollOffset = Math.max(0, this.scrollOffset - 1);
			}
		} else if (matchesKey(data, Key.down) || data === "j") {
			if (hasSelectableComments) {
				this.selectedIndex = Math.min(this.commentKeys.length - 1, this.selectedIndex + 1);
			} else {
				this.scrollOffset = Math.min(maxScroll, this.scrollOffset + 1);
			}
		} else if (matchesKey(data, Key.enter) || data === " ") {
			if (hasSelectableComments) {
				this.toggleSelectedItem();
			}
		} else if (matchesKey(data, Key.pageUp)) {
			this.scrollOffset = Math.max(0, this.scrollOffset - 10);
		} else if (matchesKey(data, Key.pageDown)) {
			this.scrollOffset = Math.min(maxScroll, this.scrollOffset + 10);
		} else if (data === "g") {
			if (hasSelectableComments) {
				this.selectedIndex = 0;
			}
			this.scrollOffset = 0;
		} else if (data === "G") {
			if (hasSelectableComments) {
				this.selectedIndex = this.commentKeys.length - 1;
			}
			this.scrollOffset = maxScroll;
		} else if (data.toLowerCase() === "r") {
			void this.onRefresh();
		} else if (matchesKey(data, Key.escape) || data === "q") {
			this.onDone();
			return;
		}

		tui.requestRender();
	}

	render(width: number, height: number, theme: OverlayTheme): string[] {
		const frameContentWidth = Math.max(20, width - 4);
		const previousSelectedKey = this.selectedKey();

		let rendered = renderOverlayContent(theme, this.state, frameContentWidth, previousSelectedKey, this.expandedKeys);

		this.commentKeys = rendered.itemKeys;
		this.itemLineByKey = rendered.itemLineByKey;
		this.clampSelection();

		const normalizedSelectedKey = this.selectedKey();
		if (normalizedSelectedKey !== previousSelectedKey) {
			rendered = renderOverlayContent(theme, this.state, frameContentWidth, normalizedSelectedKey, this.expandedKeys);
			this.commentKeys = rendered.itemKeys;
			this.itemLineByKey = rendered.itemLineByKey;
		}

		this.totalLines = rendered.lines;

		const headerHeight = 3;
		const footerHeight = 3;
		const frameOverhead = 4;
		const visibleHeight = Math.max(3, height - headerHeight - footerHeight - frameOverhead);

		this.ensureSelectedVisible(visibleHeight);

		const maxScroll = Math.max(0, this.totalLines.length - visibleHeight);
		if (this.scrollOffset > maxScroll) {
			this.scrollOffset = maxScroll;
		}

		const canScroll = this.totalLines.length > visibleHeight;
		const scrollPct = canScroll && maxScroll > 0 ? Math.round((this.scrollOffset / maxScroll) * 100) : 0;
		const visible = this.totalLines.slice(this.scrollOffset, this.scrollOffset + visibleHeight);
		while (visible.length < visibleHeight) {
			visible.push("");
		}

		const header: string[] = [];
		header.push(...new DynamicBorder((s: string) => theme.fg("accent", s)).render(width));
		header.push(
			`${theme.fg("accent", theme.bold("  GITHUB"))} ${theme.fg("dim", "|")} ${theme.fg("muted", this.state.data ? `${this.state.data.repo} PR #${this.state.data.pr.number}` : "current branch PR")}`,
		);
		header.push("");

		const body: string[] = [];
		body.push(renderFrameBorder(width, true, theme));
		body.push(renderFramedLine("", frameContentWidth, theme));
		for (const line of visible) {
			body.push(renderFramedLine(line, frameContentWidth, theme));
		}
		body.push(renderFramedLine("", frameContentWidth, theme));
		body.push(renderFrameBorder(width, false, theme));

		const footer: string[] = [];
		footer.push("");
		const selectionHint =
			this.commentKeys.length > 0
				? theme.fg("muted", `  ·  selected ${this.selectedIndex + 1}/${this.commentKeys.length}`)
				: "";
		const scrollHint = canScroll
			? theme.fg("success", ` ${scrollPct}%`) +
				theme.fg(
					"dim",
					` (${this.scrollOffset + 1}–${Math.min(this.scrollOffset + visibleHeight, this.totalLines.length)}/${this.totalLines.length})`,
				)
			: "";
		footer.push(
			theme.fg("dim", "  ↑/↓/j/k Select  •  Enter Toggle  •  PgUp/PgDn Scroll  •  r Refresh  •  q/Esc Close") +
				selectionHint +
				scrollHint,
		);
		footer.push(...new DynamicBorder((s: string) => theme.fg("accent", s)).render(width));

		return [...header, ...body, ...footer];
	}
}

function renderPlainSummary(result: OverlayFetchResult): string {
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

export default function githubOverlay(pi: ExtensionAPI) {
	pi.registerCommand("github", {
		description: "Show current-branch PR with CI, labels, reviewers, general+inline comments (collapsible)",
		handler: async (_args, ctx) => {
			if (!ctx.hasUI) {
				const result = await fetchOverlayData(pi, ctx.cwd);
				console.log(renderPlainSummary(result));
				return;
			}

			const state: OverlayState = {
				loading: true,
				refreshing: false,
				data: null,
				error: null,
				warnings: [],
				lastUpdated: null,
			};

			let refreshPromise: Promise<void> | null = null;
			const refresh = async (tui?: OverlayTui) => {
				if (refreshPromise) {
					await refreshPromise;
					return;
				}

				refreshPromise = (async () => {
					const hasExistingData = Boolean(state.data);
					state.loading = !hasExistingData;
					state.refreshing = hasExistingData;
					if (tui) tui.requestRender();

					const result = await fetchOverlayData(pi, ctx.cwd);
					state.loading = false;
					state.refreshing = false;
					if (result.data) {
						state.data = result.data;
					} else if (!hasExistingData) {
						state.data = null;
					}
					state.error = result.error;
					state.warnings = result.warnings;
					state.lastUpdated = new Date().toISOString();
					if (tui) tui.requestRender();
				})();

				try {
					await refreshPromise;
				} finally {
					refreshPromise = null;
				}
			};

			await ctx.ui.custom<void>(
				(tui, theme, _kb, done) => {
					const overlayTui = tui as unknown as OverlayTui;
					const overlayTheme = theme as unknown as OverlayTheme;
					const component = new GithubOverlayUI(
						state,
						() => done(undefined),
						async () => {
							await refresh(overlayTui);
						},
					);

					void refresh(overlayTui);

					return {
						render: (w) => component.render(w, overlayTui.height ?? 40, overlayTheme),
						handleInput: (data) => component.handleInput(data, overlayTui),
						invalidate: () => {},
					};
				},
				{
					overlay: true,
					overlayOptions: { width: "92%", maxHeight: "90%", anchor: "center" },
				},
			);
		},
	});
}
