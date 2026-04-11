/**
 * Custom footer (first-line focused)
 *
 * - Replaces the built-in footer via ctx.ui.setFooter()
 * - First line follows the style you requested
 * - Second line (optional) shows extension statuses from ctx.ui.setStatus()
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext, Theme, ThemeColor } from "@mariozechner/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";
import { formatNameStatus } from "./utils/auto-name-utils.ts";
import { formatContextUsageBar } from "./utils/format-utils.ts";
import { createRepoStatusTracker, type RepoStatusSnapshot } from "./utils/repo-status.ts";
import { ELAPSED_STATUS_KEY, NAME_STATUS_KEY } from "./utils/status-keys.ts";

const BAR_WIDTH = 10;
const FOOTER_STATE_REFRESH_INTERVAL_MS = 3000;
const CODEX_FAST_STATE_FILE = join(homedir(), ".pi", "agent", "state", "codex-fast-mode.json");
const CODEX_FAST_SUPPORTED_PROVIDER = "openai-codex";
const CODEX_FAST_SUPPORTED_MODEL_ID = "gpt-5.4";

type ThemeBg = Parameters<Theme["bg"]>[0];
type FooterTheme = {
	fg: (color: ThemeColor, text: string) => string;
	bg: (color: ThemeBg, text: string) => string;
	bold: (text: string) => string;
};

type StatusStyler = (theme: FooterTheme, text: string) => string;

type FastModeState = {
	enabled: boolean;
};

type FooterStatusData = {
	getExtensionStatuses: () => ReadonlyMap<string, string>;
	getGitBranch: () => string | null;
	onBranchChange: (listener: () => void) => () => void;
};

type BranchTokenKey = "dirty" | "ahead" | "behind" | "pr";

type BranchToken = {
	key: BranchTokenKey;
	plain: string;
	styled: string;
	position: "prefix" | "suffix";
};

const STATUS_STYLE_MAP: Record<string, StatusStyler> = {
	[NAME_STATUS_KEY]: (theme, text) => {
		const chip = ` ${theme.fg("text", text)} `;
		return theme.bg("selectedBg", chip);
	},
	[ELAPSED_STATUS_KEY]: (theme, text) => theme.fg("success", text),
};

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
		// Ignore missing/corrupt state and fall back to default.
	}

	return { enabled: false };
}

function shouldUseCodexFastBadge(
	provider: string | undefined,
	modelId: string | undefined,
	isFastModeEnabled: boolean,
): boolean {
	return isFastModeEnabled && provider === CODEX_FAST_SUPPORTED_PROVIDER && modelId === CODEX_FAST_SUPPORTED_MODEL_ID;
}

function clamp(n: number, min: number, max: number): number {
	return Math.max(min, Math.min(max, n));
}

function getFolderName(cwd: string): string {
	const parts = cwd.split(/[\\/]/).filter(Boolean);
	return parts.length > 0 ? parts[parts.length - 1] : cwd || "unknown";
}

async function getRepoName(pi: ExtensionAPI, cwd: string): Promise<string | null> {
	const result = await pi.exec("git", ["remote", "get-url", "origin"], { cwd });
	if (result.code !== 0 || !result.stdout?.trim()) return null;
	const url = result.stdout.trim();
	const match = url.match(/\/([^/]+?)(?:\.git)?$/);
	return match?.[1] ?? null;
}

function sanitizeStatusText(text: string): string {
	return text
		.replace(/[\r\n\t]/g, " ")
		.replace(/ +/g, " ")
		.trim();
}

function styleStatus(theme: FooterTheme, key: string, text: string): string {
	const style = STATUS_STYLE_MAP[key];
	return style ? style(theme, text) : text;
}

function buildFooterStatusEntries(ctx: ExtensionContext, footerData: FooterStatusData) {
	const statusEntries = Array.from(footerData.getExtensionStatuses().entries())
		.filter(([key]) => key !== NAME_STATUS_KEY)
		.map(([key, text]) => [key, sanitizeStatusText(text)] as const)
		.filter(([, text]) => Boolean(text));
	const sessionName = ctx.sessionManager.getSessionName();
	if (sessionName) {
		statusEntries.unshift([NAME_STATUS_KEY, formatNameStatus(sessionName)]);
	}
	return statusEntries;
}

function buildBranchTokens(theme: FooterTheme, repoStatus: RepoStatusSnapshot): BranchToken[] {
	const tokens: BranchToken[] = [];

	if (repoStatus.isDirty) {
		tokens.push({
			key: "dirty",
			plain: "*",
			styled: theme.fg("warning", "*"),
			position: "prefix",
		});
	}

	if (repoStatus.ahead > 0) {
		tokens.push({
			key: "ahead",
			plain: ` ↑${repoStatus.ahead}`,
			styled: theme.fg("accent", ` ↑${repoStatus.ahead}`),
			position: "suffix",
		});
	}

	if (repoStatus.behind > 0) {
		tokens.push({
			key: "behind",
			plain: ` ↓${repoStatus.behind}`,
			styled: theme.fg("accent", ` ↓${repoStatus.behind}`),
			position: "suffix",
		});
	}

	if (repoStatus.prNumber !== null) {
		tokens.push({
			key: "pr",
			plain: ` #${repoStatus.prNumber}`,
			styled: theme.fg("accent", ` #${repoStatus.prNumber}`),
			position: "suffix",
		});
	}

	return tokens;
}

function buildBranchDisplay(
	theme: FooterTheme,
	branchText: string,
	repoStatus: RepoStatusSnapshot,
	maxWidth: number,
	showBranchTokens: boolean,
): string {
	if (!showBranchTokens) {
		return theme.fg("accent", branchText);
	}

	const tokens = buildBranchTokens(theme, repoStatus);
	const includedKeys = new Set(tokens.map((token) => token.key));
	const dropOrder: BranchTokenKey[] = ["pr", "behind", "ahead", "dirty"];

	const compose = () => {
		const prefixTokens = tokens.filter((token) => token.position === "prefix" && includedKeys.has(token.key));
		const suffixTokens = tokens.filter((token) => token.position === "suffix" && includedKeys.has(token.key));
		const plain = `${prefixTokens.map((token) => token.plain).join("")}${branchText}${suffixTokens
			.map((token) => token.plain)
			.join("")}`;
		const styled = `${prefixTokens.map((token) => token.styled).join("")}${theme.fg("accent", branchText)}${suffixTokens
			.map((token) => token.styled)
			.join("")}`;
		return {
			plain,
			styled,
			width: visibleWidth(plain),
		};
	};

	let rendered = compose();
	while (rendered.width > maxWidth) {
		const nextKey = dropOrder.find((key) => includedKeys.has(key));
		if (!nextKey) break;
		includedKeys.delete(nextKey);
		rendered = compose();
	}

	return rendered.styled;
}

function buildFooterLineParts(
	theme: FooterTheme,
	ctx: ExtensionContext,
	footerData: FooterStatusData,
	repoName: string | null,
	repoStatus: RepoStatusSnapshot,
	isCodexFastModeEnabled: boolean,
	width: number,
) {
	const model = ctx.model?.id || "no-model";
	const modelLabel = shouldUseCodexFastBadge(ctx.model?.provider, ctx.model?.id, isCodexFastModeEnabled)
		? `${model} ⚡`
		: model;
	const usage = ctx.getContextUsage();
	const pct = clamp(Math.round(usage?.percent ?? 0), 0, 100);
	const bar = formatContextUsageBar(pct, BAR_WIDTH);
	const statusEntries = buildFooterStatusEntries(ctx, footerData);
	const statusTexts = statusEntries.map(([, text]) => text);
	const active = statusTexts.filter((s) => /research(ing)?/i.test(s)).length;
	const done = statusTexts.filter((s) => /(^|\s)(done|✓)(\s|$)/i.test(s)).length;
	const folder = getFolderName(ctx.sessionManager.getCwd());
	const displayName = repoName || folder;
	const branch = footerData.getGitBranch();
	const branchText = branch ?? "no-branch";
	const leftPrefix =
		theme.fg("dim", ` ${modelLabel}`) + theme.fg("muted", " · ") + theme.fg("accent", `${displayName} - `);
	const mid =
		active > 0
			? theme.fg("accent", ` ◉ ${active} researching`)
			: done > 0
				? theme.fg("success", ` ✓ ${done} done`)
				: "";
	const remaining = 100 - pct;
	const barColor = remaining <= 15 ? "error" : remaining <= 40 ? "warning" : "dim";
	const right = theme.fg(barColor, `${bar} `);
	const maxLeftWidth = Math.max(0, width - visibleWidth(mid) - visibleWidth(right) - 1);
	const branchDisplay = buildBranchDisplay(
		theme,
		branchText,
		repoStatus,
		Math.max(0, maxLeftWidth - visibleWidth(leftPrefix)),
		branch !== null,
	);
	const left = leftPrefix + branchDisplay;
	const pad = " ".repeat(Math.max(1, width - visibleWidth(left) - visibleWidth(mid) - visibleWidth(right)));
	return { statusEntries, left, mid, right, pad };
}

function installFooter(pi: ExtensionAPI, ctx: ExtensionContext) {
	if (!ctx.hasUI) return;

	ctx.ui.setFooter((tui, theme, footerData) => {
		let disposed = false;
		let footerStateTimer: ReturnType<typeof setInterval> | undefined;
		let repoName: string | null = null;
		let isCodexFastModeEnabled = loadCodexFastModeState().enabled;
		const repoStatusTracker = createRepoStatusTracker(pi, ctx.sessionManager.getCwd());

		const fetchRepoName = async () => {
			if (disposed) return;
			repoName = await getRepoName(pi, ctx.sessionManager.getCwd());
			if (!disposed) tui.requestRender();
		};

		const refreshCodexFastModeState = () => {
			if (disposed) return;
			const nextIsCodexFastModeEnabled = loadCodexFastModeState().enabled;
			if (nextIsCodexFastModeEnabled !== isCodexFastModeEnabled) {
				isCodexFastModeEnabled = nextIsCodexFastModeEnabled;
				tui.requestRender();
			}
		};

		const unsubscribeRepoStatus = repoStatusTracker.subscribe(() => {
			if (!disposed) {
				tui.requestRender();
			}
		});

		void fetchRepoName();
		refreshCodexFastModeState();
		footerStateTimer = setInterval(() => {
			refreshCodexFastModeState();
		}, FOOTER_STATE_REFRESH_INTERVAL_MS);

		const unsubscribeBranch = footerData.onBranchChange(() => {
			refreshCodexFastModeState();
			repoStatusTracker.refreshNow();
		});

		return {
			dispose() {
				disposed = true;
				unsubscribeBranch();
				unsubscribeRepoStatus();
				repoStatusTracker.dispose();
				if (footerStateTimer) {
					clearInterval(footerStateTimer);
					footerStateTimer = undefined;
				}
			},
			invalidate() {},
			render(width: number): string[] {
				const { statusEntries, left, mid, right, pad } = buildFooterLineParts(
					theme,
					ctx,
					footerData,
					repoName,
					repoStatusTracker.getSnapshot(),
					isCodexFastModeEnabled,
					width,
				);
				const lines = [truncateToWidth(left + mid + pad + right, width)];
				if (statusEntries.length > 0) {
					const delimiter = theme.fg("dim", " · ");
					const renderedStatuses = statusEntries.map(([key, text]) => styleStatus(theme, key, text));
					lines.push(truncateToWidth(` ${renderedStatuses.join(delimiter)}`, width));
				}
				return lines;
			},
		};
	});
}

export default function (pi: ExtensionAPI) {
	pi.on("session_start", async (_event, ctx) => {
		installFooter(pi, ctx);
	});

	pi.on("session_tree", async (_event, ctx) => {
		installFooter(pi, ctx);
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		if (!ctx.hasUI) return;
		ctx.ui.setFooter(undefined);
	});
}
