import type { ExtensionAPI, ExtensionContext, Theme } from "@mariozechner/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";

import { formatNameStatus } from "../utils/auto-name-utils.ts";
import { formatContextUsageBar } from "../utils/format-utils.ts";
import type { RepoStatusSnapshot } from "../utils/repo-status.ts";
import { ELAPSED_STATUS_KEY, NAME_STATUS_KEY } from "../utils/status-keys.ts";
import { type CustomStyleConfig, colorize } from "./config.ts";
import { createFooterStateManager, type FooterStateManager } from "./footer-state.ts";

const BAR_WIDTH = 10;

type StatusStyler = (theme: Theme, text: string) => string;

type FooterStatusData = {
	getExtensionStatuses: () => ReadonlyMap<string, string>;
	getGitBranch: () => string | null;
	onBranchChange: (listener: () => void) => () => void;
};

const STATUS_STYLE_MAP: Record<string, StatusStyler> = {
	[NAME_STATUS_KEY]: (theme, text) => {
		const chip = ` ${theme.fg("text", text)} `;
		return theme.bg("selectedBg", chip);
	},
	[ELAPSED_STATUS_KEY]: (theme, text) => theme.fg("success", text),
};

function sanitizeStatusText(text: string): string {
	return text
		.replace(/[\r\n\t]/g, " ")
		.replace(/ +/g, " ")
		.trim();
}

function styleStatus(theme: Theme, key: string, text: string): string {
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

function clamp(n: number, min: number, max: number): number {
	return Math.max(min, Math.min(max, n));
}

function getFolderName(cwd: string): string {
	const parts = cwd.split(/[\\/]/).filter(Boolean);
	return parts.length > 0 ? parts[parts.length - 1] : cwd || "unknown";
}

function formatCwdLabel(cwd: string, cwdIcon: string): string {
	const normalized = cwd.replace(/\\/g, "/").replace(/\/+$/, "");
	const parts = normalized.split("/").filter(Boolean);
	const last = parts[parts.length - 1] ?? cwd;
	return cwdIcon ? `${cwdIcon} ${last}` : last;
}

function buildGitStatusBlock(config: CustomStyleConfig, theme: Theme, repoStatus: RepoStatusSnapshot): string {
	const gitStatusColor = (text: string) => colorize(theme, config.colors.gitStatus, text);
	const parts = [
		repoStatus.isDirty ? "*" : "",
		repoStatus.prNumber !== null ? `#${repoStatus.prNumber}` : "",
		repoStatus.ahead > 0 ? `${config.icons.ahead}${repoStatus.ahead}` : "",
		repoStatus.behind > 0 ? `${config.icons.behind}${repoStatus.behind}` : "",
	].filter(Boolean);

	return parts.length > 0 ? gitStatusColor(`[${parts.join(" ")}]`) : "";
}

function getContextColor(config: CustomStyleConfig, percent: number): string {
	const remaining = 100 - percent;
	if (remaining <= 15) return config.colors.contextError;
	if (remaining <= 40) return config.colors.contextWarning;
	return config.colors.contextNormal;
}

function buildLeftSection(
	ctx: ExtensionContext,
	config: CustomStyleConfig,
	theme: Theme,
	repoName: string | null,
	repoStatus: RepoStatusSnapshot,
	branch: string | null,
): string {
	const cwd = ctx.sessionManager.getCwd();
	const folder = getFolderName(cwd);
	const displayName = repoName || folder;
	const cwdLabel = colorize(theme, config.colors.cwdText, formatCwdLabel(cwd, config.icons.cwd));
	const nameLabel = displayName !== folder ? colorize(theme, "accent", displayName) : "";
	const gitColor = (text: string) => colorize(theme, config.colors.git, text);
	const gitIcon = gitColor(config.icons.git);
	const statusBlock = buildGitStatusBlock(config, theme, repoStatus);
	const branchLabel = branch
		? `${colorize(theme, "text", "on")} ${gitIcon} ${gitColor(branch)}${statusBlock ? ` ${statusBlock}` : ""}`
		: "";

	return [cwdLabel, nameLabel, branchLabel].filter(Boolean).join(" ");
}

function buildRightSection(
	config: CustomStyleConfig,
	theme: Theme,
	separator: string,
	statusEntries: ReadonlyArray<readonly [string, string]>,
	percent: number,
): string {
	const mcpStatusEntry = statusEntries.find(([, text]) => /\bMCP\b/i.test(text));
	const bar = formatContextUsageBar(percent, BAR_WIDTH);
	const contextColor = getContextColor(config, percent);

	return [mcpStatusEntry ? colorize(theme, "dim", mcpStatusEntry[1]) : "", colorize(theme, contextColor, bar)]
		.filter(Boolean)
		.join(separator);
}

function buildSecondaryLine(
	theme: Theme,
	width: number,
	statusEntries: ReadonlyArray<readonly [string, string]>,
): string | null {
	const renderedStatuses = statusEntries
		.filter(([, text]) => !/\bMCP\b/i.test(text))
		.map(([key, text]) => styleStatus(theme, key, text));
	if (renderedStatuses.length === 0) return null;
	const delimiter = theme.fg("dim", " · ");
	return truncateToWidth(` ${renderedStatuses.join(delimiter)}`, width);
}

export function installFooter(pi: ExtensionAPI, ctx: ExtensionContext, config: CustomStyleConfig) {
	if (!ctx.hasUI) return;

	ctx.ui.setFooter((tui, theme, footerData) => {
		const stateManager: FooterStateManager = createFooterStateManager(
			pi,
			ctx,
			() => tui.requestRender(),
			(listener) => footerData.onBranchChange(listener),
		);
		const separator = colorize(theme, config.colors.separator, " | ");

		return {
			dispose() {
				stateManager.dispose();
			},
			invalidate() {},
			render(width: number): string[] {
				const state = stateManager.getState();
				const branch = footerData.getGitBranch();
				const statusEntries = buildFooterStatusEntries(ctx, footerData);
				const innerWidth = Math.max(1, width - 2);
				const percent = clamp(Math.round(ctx.getContextUsage()?.percent ?? 0), 0, 100);
				const left = buildLeftSection(ctx, config, theme, state.repoName, state.repoStatus, branch);
				const right = buildRightSection(config, theme, separator, statusEntries, percent);
				const leftWidth = visibleWidth(left);
				const rightWidth = visibleWidth(right);
				const content =
					leftWidth >= innerWidth
						? truncateToWidth(left, innerWidth)
						: leftWidth + 1 + rightWidth <= innerWidth
							? `${left}${" ".repeat(innerWidth - leftWidth - rightWidth)}${right}`
							: left;
				const lines = [` ${content} `];
				const secondaryLine = buildSecondaryLine(theme, width, statusEntries);
				if (secondaryLine) lines.push(secondaryLine);
				return lines;
			},
		};
	});
}
