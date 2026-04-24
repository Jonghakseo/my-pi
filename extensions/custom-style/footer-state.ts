import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { subscribeRepoStatusInvalidation } from "../utils/repo-status-events.ts";
import { createRepoStatusTracker, type RepoStatusSnapshot } from "../utils/repo-status.ts";
import { type RuntimeInfo, readRuntimeInfo } from "./runtime.ts";

const CODEX_FAST_STATE_FILE = join(homedir(), ".pi", "agent", "state", "codex-fast-mode.json");
const CODEX_FAST_SUPPORTED_PROVIDER = "openai-codex";
const FOOTER_STATE_REFRESH_INTERVAL_MS = 3000;

type FastModeState = { enabled: boolean };

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function loadCodexFastModeState(): FastModeState {
	try {
		const parsed = JSON.parse(readFileSync(CODEX_FAST_STATE_FILE, "utf8"));
		if (isRecord(parsed) && typeof parsed.enabled === "boolean") {
			return { enabled: parsed.enabled };
		}
	} catch {
		// missing/corrupt state — default off
	}
	return { enabled: false };
}

export function isCodexFastModeEnabled(): boolean {
	return loadCodexFastModeState().enabled;
}

export function shouldUseCodexFastBadge(provider: string | undefined, isFastModeEnabled: boolean): boolean {
	return isFastModeEnabled && provider === CODEX_FAST_SUPPORTED_PROVIDER;
}

export interface FooterState {
	repoStatus: RepoStatusSnapshot;
	isCodexFastModeEnabled: boolean;
	repoName: string | null;
	runtime: RuntimeInfo | undefined;
}

export interface FooterStateManager {
	getState(): FooterState;
	dispose(): void;
}

async function getRepoName(pi: ExtensionAPI, cwd: string): Promise<string | null> {
	const result = await pi.exec("git", ["remote", "get-url", "origin"], { cwd });
	if (result.code !== 0 || !result.stdout?.trim()) return null;
	const url = result.stdout.trim();
	const match = url.match(/\/([^/]+?)(?:\.git)?$/);
	return match?.[1] ?? null;
}

export function createFooterStateManager(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	requestRender: () => void,
	onBranchChange: (listener: () => void) => () => void,
): FooterStateManager {
	let disposed = false;
	let repoName: string | null = null;
	let isCodexFastModeEnabled = loadCodexFastModeState().enabled;
	let runtime: RuntimeInfo | undefined;
	const cwd = ctx.sessionManager.getCwd();
	const repoStatusTracker = createRepoStatusTracker(pi, cwd);

	const refreshCodexFastModeState = () => {
		if (disposed) return;
		const next = loadCodexFastModeState().enabled;
		if (next !== isCodexFastModeEnabled) {
			isCodexFastModeEnabled = next;
			requestRender();
		}
	};

	const refreshProjectState = async () => {
		if (disposed) return;
		const [nextRepoName, nextRuntime] = await Promise.all([getRepoName(pi, cwd), readRuntimeInfo(cwd)]);
		if (disposed) return;
		repoName = nextRepoName;
		runtime = nextRuntime;
		requestRender();
	};

	const unsubscribeRepoStatus = repoStatusTracker.subscribe(() => {
		if (!disposed) requestRender();
	});

	void refreshProjectState();
	refreshCodexFastModeState();

	const stateTimer = setInterval(() => {
		refreshCodexFastModeState();
	}, FOOTER_STATE_REFRESH_INTERVAL_MS);

	const unsubscribeBranch = onBranchChange(() => {
		refreshCodexFastModeState();
		repoStatusTracker.refreshNow();
		void refreshProjectState();
	});

	const unsubscribeRepoStatusInvalidation = subscribeRepoStatusInvalidation(() => {
		repoStatusTracker.resetPrStatus();
	});

	return {
		getState(): FooterState {
			return {
				repoStatus: repoStatusTracker.getSnapshot(),
				isCodexFastModeEnabled,
				repoName,
				runtime,
			};
		},
		dispose() {
			disposed = true;
			unsubscribeBranch();
			unsubscribeRepoStatusInvalidation();
			unsubscribeRepoStatus();
			repoStatusTracker.dispose();
			clearInterval(stateTimer);
		},
	};
}
