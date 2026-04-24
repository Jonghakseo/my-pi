import type { ExtensionAPI, ExtensionContext, Theme } from "@mariozechner/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";

import { formatNameStatus } from "../utils/auto-name-utils.ts";
import { formatContextUsageBar } from "../utils/format-utils.ts";
import type { CheckSummary } from "../utils/git-utils.ts";
import type { RepoStatusSnapshot } from "../utils/repo-status.ts";
import { NAME_STATUS_KEY } from "../utils/status-keys.ts";
import { type CustomStyleConfig, colorize } from "./config.ts";
import { createFooterStateManager, type FooterStateManager } from "./footer-state.ts";

const BAR_WIDTH = 10;
const LINE1_SEPARATOR = " / ";
const LINE2_RIGHT_SEPARATOR = " | ";
const CONTEXT_SEPARATOR = "   ";
const BRANCH_ICON = "";
const REVIEW_ICON = "󰱼";
const REVIEW_APPROVED_ICON = "󰄬";
const REVIEW_CHANGES_REQUESTED_ICON = "󰅖";
const REVIEW_COMMENTED_ICON = "󰆨";
const INLINE_COMMENT_ICON = "󰍡";
const CI_PENDING_ICON = "󰑓";
const CI_SUCCESS_ICON = "󰗠";
const CI_FAILED_ICON = "";

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

function getContextColor(config: CustomStyleConfig, percent: number): string {
	const remaining = 100 - percent;
	if (remaining <= 15) return config.colors.contextError;
	if (remaining <= 40) return config.colors.contextWarning;
	return config.colors.contextNormal;
}

function buildLine1Left(
	ctx: ExtensionContext,
	config: CustomStyleConfig,
	theme: Theme,
	repoName: string | null,
	statusEntries: ReadonlyArray<readonly [string, string]>,
): string {
	const cwd = ctx.sessionManager.getCwd();
	const folder = getFolderName(cwd);
	const cwdLabel = colorize(theme, config.colors.cwdText, formatCwdLabel(cwd, config.icons.cwd));
	const repoLabel = repoName && repoName !== folder ? theme.fg("accent", `(${repoName})`) : "";
	const sessionLabel = statusEntries
		.filter(([key]) => key === NAME_STATUS_KEY)
		.map(([key, text]) => styleStatus(theme, key, text))[0];
	return (
		[cwdLabel, repoLabel].filter(Boolean).join(" ") +
		(sessionLabel ? `${theme.fg("dim", LINE1_SEPARATOR)}${sessionLabel}` : "")
	);
}

function splitContextBarParts(percent: number): { bar: string; percentLabel: string } {
	const [bar = "", percentLabel = ""] = formatContextUsageBar(percent, BAR_WIDTH).split(/ (?=\d+%$)/u);
	return { bar, percentLabel };
}

function buildLine1Right(
	config: CustomStyleConfig,
	theme: Theme,
	statusEntries: ReadonlyArray<readonly [string, string]>,
	percent: number,
): string {
	const mcpStatusEntry = statusEntries.find(([, text]) => /\bMCP\b/i.test(text));
	const auxiliaryStatuses = statusEntries
		.filter(([key, text]) => key !== NAME_STATUS_KEY && !/\bMCP\b/i.test(text))
		.map(([key, text]) => styleStatus(theme, key, text))
		.filter(Boolean)
		.join(theme.fg("dim", "  "));
	const { bar, percentLabel } = splitContextBarParts(percent);
	const contextColor = getContextColor(config, percent);
	return [
		auxiliaryStatuses,
		mcpStatusEntry ? colorize(theme, "dim", mcpStatusEntry[1]) : "",
		bar ? colorize(theme, contextColor, bar) : "",
		percentLabel ? colorize(theme, contextColor, percentLabel) : "",
	]
		.filter(Boolean)
		.join(CONTEXT_SEPARATOR);
}

function buildPrLabel(theme: Theme, repoStatus: RepoStatusSnapshot): string {
	if (repoStatus.prNumber === null) return "";
	const prText = `#${repoStatus.prNumber}${repoStatus.prTitle ? ` ${repoStatus.prTitle}` : ""}`;
	return theme.fg("accent", prText);
}

function buildLine2Left(
	config: CustomStyleConfig,
	theme: Theme,
	repoStatus: RepoStatusSnapshot,
	branch: string | null,
): string {
	if (!branch && repoStatus.prNumber === null) return "";
	const gitColor = (text: string) => colorize(theme, config.colors.git, text);
	const branchStatusParts = [
		repoStatus.isDirty ? "*" : "",
		repoStatus.ahead > 0 ? `${config.icons.ahead}${repoStatus.ahead}` : "",
		repoStatus.behind > 0 ? `${config.icons.behind}${repoStatus.behind}` : "",
	].filter(Boolean);
	const branchStatus = branchStatusParts.length > 0 ? ` ${branchStatusParts.join(" ")}` : "";
	const branchLabel = branch ? `${gitColor(BRANCH_ICON)} ${gitColor(branch)}${gitColor(branchStatus)}` : "";
	const branchPrefix = gitColor("└");
	const prLabel = buildPrLabel(theme, repoStatus);
	return [`${branchPrefix} ${branchLabel}`, prLabel].filter(Boolean).join(" ").trimEnd();
}

function buildReviewLabel(theme: Theme, repoStatus: RepoStatusSnapshot): string {
	if (!repoStatus.review) return "";
	switch (repoStatus.review.state) {
		case "approved":
			return `${theme.fg("success", REVIEW_APPROVED_ICON)}  ${theme.fg("text", "Approved")}`;
		case "changes_requested":
			return `${theme.fg("error", REVIEW_CHANGES_REQUESTED_ICON)}  ${theme.fg("text", "Changes")}`;
		case "commented":
			return `${theme.fg("warning", REVIEW_COMMENTED_ICON)}  ${theme.fg("text", "Commented")}`;
		case "review":
			return `${theme.fg("warning", REVIEW_ICON)}  ${theme.fg("text", "Reviewing")}`;
	}
	return "";
}

function buildCiSegment(theme: Theme, icon: string, color: "warning" | "success", count: number): string {
	if (count <= 0) return "";
	return `${theme.fg(color, icon)} ${theme.fg("text", String(count))}`;
}

function buildCiLabel(theme: Theme, checks: CheckSummary | null): string {
	if (!checks) return "";
	return [
		buildCiSegment(theme, CI_PENDING_ICON, "warning", checks.pending),
		buildCiSegment(theme, CI_SUCCESS_ICON, "success", checks.success),
		buildCiSegment(theme, CI_FAILED_ICON, "success", checks.failed),
	]
		.filter(Boolean)
		.join("  ");
}

function buildInlineCommentLabel(theme: Theme, repoStatus: RepoStatusSnapshot): string {
	if (!repoStatus.unresolvedInlineComments || repoStatus.unresolvedInlineComments <= 0) return "";
	return `${theme.fg("warning", INLINE_COMMENT_ICON)} ${theme.fg("text", String(repoStatus.unresolvedInlineComments))}`;
}

function buildLine2Right(theme: Theme, repoStatus: RepoStatusSnapshot): string {
	if (repoStatus.prNumber === null) return "";
	const separator = theme.fg("dim", LINE2_RIGHT_SEPARATOR);
	return [
		buildReviewLabel(theme, repoStatus),
		buildInlineCommentLabel(theme, repoStatus),
		buildCiLabel(theme, repoStatus.checks),
	]
		.filter(Boolean)
		.join(separator);
}

function renderAlignedLine(width: number, left: string, right: string): string {
	const innerWidth = Math.max(1, width - 2);
	if (!right) return ` ${truncateToWidth(left, innerWidth)} `;
	const rightWidth = visibleWidth(right);
	if (rightWidth >= innerWidth) return ` ${truncateToWidth(right, innerWidth)} `;
	const maxLeftWidth = Math.max(1, innerWidth - rightWidth - 1);
	const renderedLeft = truncateToWidth(left, maxLeftWidth);
	const paddingWidth = Math.max(1, innerWidth - visibleWidth(renderedLeft) - rightWidth);
	return ` ${renderedLeft}${" ".repeat(paddingWidth)}${right} `;
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

		return {
			dispose() {
				stateManager.dispose();
			},
			invalidate() {},
			render(width: number): string[] {
				const state = stateManager.getState();
				const branch = state.repoStatus.branch ?? footerData.getGitBranch();
				const statusEntries = buildFooterStatusEntries(ctx, footerData);
				const percent = clamp(Math.round(ctx.getContextUsage()?.percent ?? 0), 0, 100);
				const line1Left = buildLine1Left(ctx, config, theme, state.repoName, statusEntries);
				const line1Right = buildLine1Right(config, theme, statusEntries, percent);
				const line2Left = buildLine2Left(config, theme, state.repoStatus, branch);
				const line2Right = buildLine2Right(theme, state.repoStatus);
				const lines = [renderAlignedLine(width, line1Left, line1Right)];
				if (line2Left || line2Right) {
					lines.push(renderAlignedLine(width, line2Left, line2Right));
				}
				return lines;
			},
		};
	});
}
