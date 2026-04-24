import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { fetchUnresolvedPullRequestReviewCommentsCount, isNoPullRequestError } from "./github-pr-review-comments.ts";
import { type CheckSummary, parseGitStatusPorcelainV2, summarizeChecks } from "./git-utils.ts";

const GIT_STATUS_ARGS = ["status", "--porcelain=v2", "--branch", "--untracked-files=normal"] as const;
const PR_VIEW_ARGS = [
	"pr",
	"view",
	"--json",
	"number,title,url,state,reviewDecision,latestReviews,statusCheckRollup",
] as const;
const GIT_POLL_INTERVAL_MS = 3000;
const PR_POLL_INTERVAL_MS = 30_000;

export type ReviewStatusState = "approved" | "changes_requested" | "commented" | "review";

export interface ReviewStatusSummary {
	state: ReviewStatusState;
}

export interface RepoStatusSnapshot {
	branch: string | null;
	isDirty: boolean;
	ahead: number;
	behind: number;
	prNumber: number | null;
	prTitle: string | null;
	prUrl: string | null;
	review: ReviewStatusSummary | null;
	checks: CheckSummary | null;
	unresolvedInlineComments: number | null;
}

export interface RepoStatusTracker {
	getSnapshot(): RepoStatusSnapshot;
	subscribe(listener: () => void): () => void;
	refreshNow(): void;
	dispose(): void;
}

type GithubReviewState = "APPROVED" | "CHANGES_REQUESTED" | "COMMENTED" | "DISMISSED" | "PENDING";
type GithubReviewDecision = "APPROVED" | "CHANGES_REQUESTED" | "REVIEW_REQUIRED";
type GithubPullRequestState = "OPEN" | "CLOSED" | "MERGED";

type GhPrViewJson = {
	number?: unknown;
	title?: unknown;
	url?: unknown;
	state?: unknown;
	reviewDecision?: unknown;
	latestReviews?: unknown;
	statusCheckRollup?: unknown;
};

const EMPTY_SNAPSHOT: RepoStatusSnapshot = {
	branch: null,
	isDirty: false,
	ahead: 0,
	behind: 0,
	prNumber: null,
	prTitle: null,
	prUrl: null,
	review: null,
	checks: null,
	unresolvedInlineComments: null,
};

function snapshotsEqual(left: RepoStatusSnapshot, right: RepoStatusSnapshot): boolean {
	return (
		left.branch === right.branch &&
		left.isDirty === right.isDirty &&
		left.ahead === right.ahead &&
		left.behind === right.behind &&
		left.prNumber === right.prNumber &&
		left.prTitle === right.prTitle &&
		left.prUrl === right.prUrl &&
		left.unresolvedInlineComments === right.unresolvedInlineComments &&
		reviewSummariesEqual(left.review, right.review) &&
		checkSummariesEqual(left.checks, right.checks)
	);
}

function reviewSummariesEqual(left: ReviewStatusSummary | null, right: ReviewStatusSummary | null): boolean {
	return left?.state === right?.state;
}

function checkSummariesEqual(left: CheckSummary | null, right: CheckSummary | null): boolean {
	return (
		left?.total === right?.total &&
		left?.success === right?.success &&
		left?.failed === right?.failed &&
		left?.pending === right?.pending &&
		left?.neutral === right?.neutral
	);
}

function normalizeExecText(text: string | undefined): string {
	return (text ?? "").trim();
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
	return state as GithubReviewState | null;
}

function readReviewDecision(value: unknown): GithubReviewDecision | null {
	if (value === "APPROVED" || value === "CHANGES_REQUESTED" || value === "REVIEW_REQUIRED") {
		return value;
	}
	return null;
}

function parseReviewSummary(reviewDecision: unknown, latestReviews: unknown): ReviewStatusSummary {
	const decision = readReviewDecision(reviewDecision);
	const reviewStates = asArray(latestReviews)
		.map(extractReviewState)
		.filter((state): state is GithubReviewState => Boolean(state));

	if (decision === "CHANGES_REQUESTED") {
		return { state: "changes_requested" };
	}
	if (decision === "APPROVED") {
		return { state: "approved" };
	}
	if (reviewStates.includes("CHANGES_REQUESTED")) {
		return { state: "changes_requested" };
	}
	if (reviewStates.includes("COMMENTED")) {
		return { state: "commented" };
	}
	if (!decision && reviewStates.includes("APPROVED")) {
		return { state: "approved" };
	}
	return { state: "review" };
}

function parseCheckState(check: unknown): "success" | "failed" | "pending" | "neutral" {
	if (!isRecord(check)) return "neutral";
	const state = readString(check.state)?.toUpperCase();
	const status = readString(check.status)?.toUpperCase();
	const conclusion = readString(check.conclusion)?.toUpperCase();
	if ((status && status !== "COMPLETED") || state === "PENDING" || state === "EXPECTED") return "pending";
	if (state === "SUCCESS" || conclusion === "SUCCESS" || conclusion === "NEUTRAL") return "success";
	if (
		state === "FAILURE" ||
		state === "ERROR" ||
		conclusion === "FAILURE" ||
		conclusion === "TIMED_OUT" ||
		conclusion === "CANCELLED" ||
		conclusion === "ACTION_REQUIRED" ||
		conclusion === "STARTUP_FAILURE"
	)
		return "failed";
	if (!state && !conclusion) return "pending";
	return "neutral";
}

function parseCheckSummary(statusCheckRollup: unknown): CheckSummary | null {
	const checks = asArray(statusCheckRollup)
		.map((check) => ({
			name: readString(isRecord(check) ? check.name : null) ?? "check",
			kind: "check-run" as const,
			state: parseCheckState(check),
			detail: "",
			url: null,
		}))
		.filter(Boolean);
	if (checks.length === 0) return null;
	return summarizeChecks(checks);
}

function readPullRequestState(value: unknown): GithubPullRequestState | null {
	if (value === "OPEN" || value === "CLOSED" || value === "MERGED") {
		return value;
	}
	return null;
}

function emptyPrSnapshot(): Pick<
	RepoStatusSnapshot,
	"prNumber" | "prTitle" | "prUrl" | "review" | "checks" | "unresolvedInlineComments"
> {
	return {
		prNumber: null,
		prTitle: null,
		prUrl: null,
		review: null,
		checks: null,
		unresolvedInlineComments: null,
	};
}

function parsePrSnapshot(
	stdout: string,
): Pick<RepoStatusSnapshot, "prNumber" | "prTitle" | "prUrl" | "review" | "checks" | "unresolvedInlineComments"> {
	try {
		const parsed = JSON.parse(stdout) as GhPrViewJson;
		const prState = readPullRequestState(parsed.state);
		if (prState === "CLOSED" || prState === "MERGED") return emptyPrSnapshot();
		return {
			prNumber: readNumber(parsed.number),
			prTitle: readString(parsed.title),
			prUrl: readString(parsed.url),
			review: parseReviewSummary(parsed.reviewDecision, parsed.latestReviews),
			checks: parseCheckSummary(parsed.statusCheckRollup),
			unresolvedInlineComments: null,
		};
	} catch {
		return emptyPrSnapshot();
	}
}

export function createRepoStatusTracker(pi: ExtensionAPI, cwd: string): RepoStatusTracker {
	let snapshot: RepoStatusSnapshot = EMPTY_SNAPSHOT;
	let disposed = false;
	let gitTimer: ReturnType<typeof setInterval> | undefined;
	let prTimer: ReturnType<typeof setInterval> | undefined;
	let gitRefreshRunning = false;
	let gitRefreshQueued = false;
	let prRefreshRunning = false;
	let prRefreshQueued = false;
	let queuedPrBranch: string | null = null;
	const listeners = new Set<() => void>();

	const emit = () => {
		for (const listener of listeners) {
			listener();
		}
	};

	const setSnapshot = (nextSnapshot: RepoStatusSnapshot) => {
		if (snapshotsEqual(snapshot, nextSnapshot)) {
			return false;
		}
		snapshot = nextSnapshot;
		emit();
		return true;
	};

	const clearPrData = () => {
		setSnapshot({
			...snapshot,
			prNumber: null,
			prTitle: null,
			prUrl: null,
			review: null,
			checks: null,
			unresolvedInlineComments: null,
		});
	};

	const clearSnapshot = () => {
		setSnapshot(EMPTY_SNAPSHOT);
	};

	const queuePrRefresh = (branch: string | null) => {
		prRefreshQueued = true;
		queuedPrBranch = branch;
	};

	const queueGitRefresh = () => {
		gitRefreshQueued = true;
	};

	const finishPrRefresh = (refreshPrState: (branch?: string | null) => Promise<void>) => {
		prRefreshRunning = false;
		if (!prRefreshQueued || disposed) return;
		const nextBranch = queuedPrBranch;
		prRefreshQueued = false;
		queuedPrBranch = null;
		void refreshPrState(nextBranch);
	};

	const finishGitRefresh = (refreshGitState: () => Promise<void>) => {
		gitRefreshRunning = false;
		if (!gitRefreshQueued || disposed) return;
		gitRefreshQueued = false;
		void refreshGitState();
	};

	const shouldDiscardPrResult = (requestedBranch: string) => disposed || snapshot.branch !== requestedBranch;

	const handlePrFailure = (stderr: string | undefined, stdout: string | undefined) => {
		const detail = normalizeExecText(stderr) || normalizeExecText(stdout);
		if (!detail || isNoPullRequestError(detail) || snapshot.prNumber !== null) {
			clearPrData();
		}
	};

	const applyGitStatus = (stdout: string) => {
		const parsed = parseGitStatusPorcelainV2(stdout);
		const nextBranch = parsed.isDetached ? null : parsed.head;
		const branchChanged = nextBranch !== snapshot.branch;
		setSnapshot({
			branch: nextBranch,
			isDirty: parsed.isDirty,
			ahead: nextBranch ? parsed.ahead : 0,
			behind: nextBranch ? parsed.behind : 0,
			prNumber: branchChanged ? null : snapshot.prNumber,
			prTitle: branchChanged ? null : snapshot.prTitle,
			prUrl: branchChanged ? null : snapshot.prUrl,
			review: branchChanged ? null : snapshot.review,
			checks: branchChanged ? null : snapshot.checks,
			unresolvedInlineComments: branchChanged ? null : snapshot.unresolvedInlineComments,
		});
		return { branchChanged, nextBranch };
	};

	const refreshPrState = async (branch: string | null = snapshot.branch) => {
		if (disposed) return;
		if (prRefreshRunning) {
			queuePrRefresh(branch);
			return;
		}
		if (!branch) {
			clearPrData();
			return;
		}

		prRefreshRunning = true;
		const requestedBranch = branch;
		try {
			const result = await pi.exec("gh", [...PR_VIEW_ARGS], { cwd });
			if (shouldDiscardPrResult(requestedBranch)) return;
			if (result.code !== 0) {
				handlePrFailure(result.stderr, result.stdout);
				return;
			}
			const nextPrSnapshot = parsePrSnapshot(result.stdout ?? "");
			const unresolvedInlineComments = await fetchUnresolvedPullRequestReviewCommentsCount(
				pi,
				cwd,
				nextPrSnapshot.prUrl,
			);
			if (shouldDiscardPrResult(requestedBranch)) return;
			setSnapshot({
				...snapshot,
				...nextPrSnapshot,
				unresolvedInlineComments,
			});
		} catch {
			if (!shouldDiscardPrResult(requestedBranch)) {
				clearPrData();
			}
		} finally {
			finishPrRefresh(refreshPrState);
		}
	};

	const refreshGitState = async () => {
		if (disposed) return;
		if (gitRefreshRunning) {
			queueGitRefresh();
			return;
		}

		gitRefreshRunning = true;
		try {
			const result = await pi.exec("git", [...GIT_STATUS_ARGS], { cwd });
			if (disposed) return;
			if (result.code !== 0) {
				clearSnapshot();
				return;
			}
			const { branchChanged, nextBranch } = applyGitStatus(result.stdout ?? "");
			if (branchChanged) {
				void refreshPrState(nextBranch);
			}
		} catch {
			if (!disposed) {
				clearSnapshot();
			}
		} finally {
			finishGitRefresh(refreshGitState);
		}
	};

	void refreshGitState();
	gitTimer = setInterval(() => {
		void refreshGitState();
	}, GIT_POLL_INTERVAL_MS);
	prTimer = setInterval(() => {
		void refreshPrState();
	}, PR_POLL_INTERVAL_MS);

	return {
		getSnapshot() {
			return snapshot;
		},
		subscribe(listener: () => void) {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},
		refreshNow() {
			void refreshGitState();
			void refreshPrState();
		},
		dispose() {
			disposed = true;
			listeners.clear();
			if (gitTimer) {
				clearInterval(gitTimer);
				gitTimer = undefined;
			}
			if (prTimer) {
				clearInterval(prTimer);
				prTimer = undefined;
			}
		},
	};
}
