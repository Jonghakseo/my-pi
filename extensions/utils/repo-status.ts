import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { parseGitStatusPorcelainV2 } from "./git-utils.ts";

const GIT_STATUS_ARGS = ["status", "--porcelain=v2", "--branch", "--untracked-files=normal"] as const;
const PR_VIEW_ARGS = ["pr", "view", "--json", "number,url"] as const;
const GIT_POLL_INTERVAL_MS = 3000;
const PR_POLL_INTERVAL_MS = 20_000;

export interface RepoStatusSnapshot {
	branch: string | null;
	isDirty: boolean;
	ahead: number;
	behind: number;
	prNumber: number | null;
}

export interface RepoStatusTracker {
	getSnapshot(): RepoStatusSnapshot;
	subscribe(listener: () => void): () => void;
	refreshNow(): void;
	dispose(): void;
}

const EMPTY_SNAPSHOT: RepoStatusSnapshot = {
	branch: null,
	isDirty: false,
	ahead: 0,
	behind: 0,
	prNumber: null,
};

function snapshotsEqual(left: RepoStatusSnapshot, right: RepoStatusSnapshot): boolean {
	return (
		left.branch === right.branch &&
		left.isDirty === right.isDirty &&
		left.ahead === right.ahead &&
		left.behind === right.behind &&
		left.prNumber === right.prNumber
	);
}

function parsePrNumber(stdout: string): number | null {
	try {
		const parsed = JSON.parse(stdout) as { number?: unknown };
		return typeof parsed.number === "number" && Number.isFinite(parsed.number) ? parsed.number : null;
	} catch {
		return null;
	}
}

function normalizeExecText(text: string | undefined): string {
	return (text ?? "").trim();
}

function isNoPullRequestError(text: string): boolean {
	return text.toLowerCase().includes("no pull requests found");
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

	const clearPrNumber = () => {
		setSnapshot({ ...snapshot, prNumber: null });
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
			clearPrNumber();
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
			clearPrNumber();
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
				prNumber: parsePrNumber(result.stdout ?? ""),
			});
		} catch {
			if (!shouldDiscardPrResult(requestedBranch)) {
				clearPrNumber();
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
