import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { type CheckSummary, parseGitStatusPorcelainV2, summarizeChecks } from "./git-utils.ts";

const GIT_STATUS_ARGS = ["status", "--porcelain=v2", "--branch", "--untracked-files=normal"] as const;
const PR_VIEW_ARGS = [
	"pr",
	"view",
	"--json",
	"number,title,reviewDecision,latestReviews,reviewRequests,statusCheckRollup",
] as const;
const GIT_POLL_INTERVAL_MS = 3000;
const PR_POLL_INTERVAL_MS = 30_000;

export interface ReviewStatusSummary {
	approved: number;
	total: number;
}

export interface RepoStatusSnapshot {
	branch: string | null;
	isDirty: boolean;
	ahead: number;
	behind: number;
	prNumber: number | null;
	prTitle: string | null;
	review: ReviewStatusSummary | null;
	checks: CheckSummary | null;
}

export interface RepoStatusTracker {
	getSnapshot(): RepoStatusSnapshot;
	subscribe(listener: () => void): () => void;
	refreshNow(): void;
	dispose(): void;
}

type GithubReviewState = "APPROVED" | "CHANGES_REQUESTED" | "COMMENTED" | "DISMISSED" | "PENDING";

type GhPrViewJson = {
	number?: unknown;
	title?: unknown;
	latestReviews?: unknown;
	reviewRequests?: unknown;
	statusCheckRollup?: unknown;
};

const EMPTY_SNAPSHOT: RepoStatusSnapshot = {
	branch: null,
	isDirty: false,
	ahead: 0,
	behind: 0,
	prNumber: null,
	prTitle: null,
	review: null,
	checks: null,
};

function snapshotsEqual(left: RepoStatusSnapshot, right: RepoStatusSnapshot): boolean {
	return (
		left.branch === right.branch &&
		left.isDirty === right.isDirty &&
		left.ahead === right.ahead &&
		left.behind === right.behind &&
		left.prNumber === right.prNumber &&
		left.prTitle === right.prTitle &&
		reviewSummariesEqual(left.review, right.review) &&
		checkSummariesEqual(left.checks, right.checks)
	);
}

function reviewSummariesEqual(left: ReviewStatusSummary | null, right: ReviewStatusSummary | null): boolean {
	return left?.approved === right?.approved && left?.total === right?.total;
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

function isNoPullRequestError(text: string): boolean {
	return text.toLowerCase().includes("no pull requests found");
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

function extractReviewerKey(review: unknown): string | null {
	if (!isRecord(review)) return null;
	return (
		readNestedString(review, "author", "login") ??
		readNestedString(review, "requestedReviewer", "login") ??
		readNestedString(review, "requestedReviewer", "name") ??
		readNestedString(review, "login") ??
		readNestedString(review, "name")
	);
}

function extractReviewState(review: unknown): GithubReviewState | null {
	if (!isRecord(review)) return null;
	const state =
		readString(review.state) ?? readString(review.reviewDecision) ?? readNestedString(review, "latestReview", "state");
	return state as GithubReviewState | null;
}

function parseReviewSummary(reviewRequests: unknown, latestReviews: unknown): ReviewStatusSummary | null {
	const requestedReviewerKeys = new Set<string>();
	for (const request of asArray(reviewRequests)) {
		const reviewerKey = extractReviewerKey(request);
		if (reviewerKey) requestedReviewerKeys.add(reviewerKey);
	}

	const latestReviewByReviewer = new Map<string, GithubReviewState>();
	for (const review of asArray(latestReviews)) {
		const reviewerKey = extractReviewerKey(review);
		const state = extractReviewState(review);
		if (!reviewerKey || !state) continue;
		latestReviewByReviewer.set(reviewerKey, state);
	}

	const approvedReviewers = new Set<string>();
	for (const [reviewerKey, state] of latestReviewByReviewer) {
		if (state === "APPROVED") approvedReviewers.add(reviewerKey);
	}

	const totalReviewers = new Set([...requestedReviewerKeys, ...latestReviewByReviewer.keys()]);
	if (totalReviewers.size === 0) return null;
	return {
		approved: approvedReviewers.size,
		total: totalReviewers.size,
	};
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

function parsePrSnapshot(stdout: string): Pick<RepoStatusSnapshot, "prNumber" | "prTitle" | "review" | "checks"> {
	try {
		const parsed = JSON.parse(stdout) as GhPrViewJson;
		return {
			prNumber: readNumber(parsed.number),
			prTitle: readString(parsed.title),
			review: parseReviewSummary(parsed.reviewRequests, parsed.latestReviews),
			checks: parseCheckSummary(parsed.statusCheckRollup),
		};
	} catch {
		return {
			prNumber: null,
			prTitle: null,
			review: null,
			checks: null,
		};
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
		setSnapshot({ ...snapshot, prNumber: null, prTitle: null, review: null, checks: null });
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
			review: branchChanged ? null : snapshot.review,
			checks: branchChanged ? null : snapshot.checks,
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
			setSnapshot({
				...snapshot,
				...parsePrSnapshot(result.stdout ?? ""),
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
