/**
 * Pi Pi style footer (first-line focused)
 *
 * - Replaces the built-in footer via ctx.ui.setFooter()
 * - First line follows the style you requested
 * - Second line (optional) shows extension statuses from ctx.ui.setStatus()
 */

import type { ExtensionAPI, ExtensionContext, Theme, ThemeColor } from "@mariozechner/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";
import { formatNameStatus } from "./utils/auto-name-utils.ts";
import { ELAPSED_STATUS_KEY, NAME_STATUS_KEY } from "./utils/status-keys.ts";

const BAR_WIDTH = 10;
const DIRTY_CHECK_INTERVAL_MS = 3000;

type ThemeBg = Parameters<Theme["bg"]>[0];
type FooterTheme = {
	fg: (color: ThemeColor, text: string) => string;
	bg: (color: ThemeBg, text: string) => string;
	bold: (text: string) => string;
};

type StatusStyler = (theme: FooterTheme, text: string) => string;

const STATUS_STYLE_MAP: Record<string, StatusStyler> = {
	[NAME_STATUS_KEY]: (theme, text) => {
		const chip = ` ${theme.fg("text", text)} `;
		return theme.bg("selectedBg", chip);
	},
	[ELAPSED_STATUS_KEY]: (theme, text) => theme.fg("success", text),
};

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

async function hasUncommittedChanges(pi: ExtensionAPI, cwd: string): Promise<boolean> {
	const result = await pi.exec("git", ["status", "--porcelain=1", "--untracked-files=normal"], { cwd });
	if (result.code !== 0) {
		return false;
	}
	return result.stdout.trim().length > 0;
}

function installFooter(pi: ExtensionAPI, ctx: ExtensionContext) {
	if (!ctx.hasUI) return;

	ctx.ui.setFooter((tui, theme, footerData) => {
		let hasDirtyChanges = false;
		let dirtyCheckInitialized = false;
		let dirtyCheckRunning = false;
		let disposed = false;
		let dirtyTimer: ReturnType<typeof setInterval> | undefined;
		let repoName: string | null = null;

		const fetchRepoName = async () => {
			if (disposed) return;
			repoName = await getRepoName(pi, ctx.sessionManager.getCwd());
			if (!disposed) tui.requestRender();
		};

		const refreshDirtyState = async () => {
			if (disposed || dirtyCheckRunning) return;

			const branch = footerData.getGitBranch();
			if (branch === null) {
				if (hasDirtyChanges || !dirtyCheckInitialized) {
					hasDirtyChanges = false;
					dirtyCheckInitialized = true;
					tui.requestRender();
				}
				return;
			}

			dirtyCheckRunning = true;
			try {
				const nextHasDirtyChanges = await hasUncommittedChanges(pi, ctx.sessionManager.getCwd());
				if (disposed) return;
				if (!dirtyCheckInitialized || nextHasDirtyChanges !== hasDirtyChanges) {
					hasDirtyChanges = nextHasDirtyChanges;
					dirtyCheckInitialized = true;
					tui.requestRender();
				}
			} catch {
				// Ignore git status errors in footer rendering path.
			} finally {
				dirtyCheckRunning = false;
			}
		};

		void fetchRepoName();
		void refreshDirtyState();
		dirtyTimer = setInterval(() => {
			void refreshDirtyState();
		}, DIRTY_CHECK_INTERVAL_MS);

		const unsubscribeBranch = footerData.onBranchChange(() => {
			tui.requestRender();
			void refreshDirtyState();
		});

		return {
			dispose() {
				disposed = true;
				unsubscribeBranch();
				if (dirtyTimer) {
					clearInterval(dirtyTimer);
					dirtyTimer = undefined;
				}
			},
			invalidate() {},
			render(width: number): string[] {
				const model = ctx.model?.id || "no-model";
				const usage = ctx.getContextUsage();
				const pct = clamp(Math.round(usage?.percent ?? 0), 0, 100);
				const filled = Math.round((pct / 100) * BAR_WIDTH);
				const bar = "#".repeat(filled) + "-".repeat(BAR_WIDTH - filled);

				const sessionName = ctx.sessionManager.getSessionName();
				const statusEntries = Array.from(footerData.getExtensionStatuses().entries())
					.filter(([key]) => key !== NAME_STATUS_KEY)
					.map(([key, text]) => [key, sanitizeStatusText(text)] as const)
					.filter(([, text]) => Boolean(text));
				if (sessionName) {
					statusEntries.unshift([NAME_STATUS_KEY, formatNameStatus(sessionName)]);
				}
				const statusTexts = statusEntries.map(([, text]) => text);

				const active = statusTexts.filter((s) => /research(ing)?/i.test(s)).length;
				const done = statusTexts.filter((s) => /(^|\s)(done|✓)(\s|$)/i.test(s)).length;

				const folder = getFolderName(ctx.sessionManager.getCwd());
				const displayName = repoName || folder;
				const branch = footerData.getGitBranch();
				const branchText = branch ?? "no-branch";
				const dirtyMark = branch && hasDirtyChanges ? theme.fg("warning", "*") : "";

				const left =
					theme.fg("dim", ` ${model}`) +
					theme.fg("muted", " · ") +
					theme.fg("accent", `${displayName} - `) +
					dirtyMark +
					theme.fg("accent", branchText);

				const mid =
					active > 0
						? theme.fg("accent", ` ◉ ${active} researching`)
						: done > 0
							? theme.fg("success", ` ✓ ${done} done`)
							: "";

				const remaining = 100 - pct;
				const barColor = remaining <= 15 ? "error" : remaining <= 40 ? "warning" : "dim";
				const right = theme.fg(barColor, `[${bar}] ${pct}% `);
				const pad = " ".repeat(Math.max(1, width - visibleWidth(left) - visibleWidth(mid) - visibleWidth(right)));

				const lines = [truncateToWidth(left + mid + pad + right, width)];

				if (statusEntries.length > 0) {
					const delimiter = theme.fg("dim", " · ");
					const renderedStatuses = statusEntries.map(([key, text]) => styleStatus(theme, key, text));
					const statusLine = truncateToWidth(` ${renderedStatuses.join(delimiter)}`, width);
					lines.push(statusLine);
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

	pi.on("session_switch", async (_event, ctx) => {
		installFooter(pi, ctx);
	});

	pi.on("session_fork", async (_event, ctx) => {
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
