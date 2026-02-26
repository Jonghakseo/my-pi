/**
 * Pi Pi style footer (first-line focused)
 *
 * - Replaces the built-in footer via ctx.ui.setFooter()
 * - First line follows the style you requested
 * - Second line (optional) shows extension statuses from ctx.ui.setStatus()
 */

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";
import { PURPOSE_STATUS_KEY } from "./utils/status-keys.ts";

const BAR_WIDTH = 10;

type StatusStyler = (theme: any, text: string) => string;

const STATUS_STYLE_MAP: Record<string, StatusStyler> = {
	[PURPOSE_STATUS_KEY]: (theme, text) => {
		const chip = ` ${theme.fg("text", text)} `;
		return theme.bg("selectedBg", chip);
	},
};

function clamp(n: number, min: number, max: number): number {
	return Math.max(min, Math.min(max, n));
}

function getFolderName(cwd: string): string {
	const parts = cwd.split(/[\\/]/).filter(Boolean);
	return parts.length > 0 ? parts[parts.length - 1] : cwd || "unknown";
}

function sanitizeStatusText(text: string): string {
	return text.replace(/[\r\n\t]/g, " ").replace(/ +/g, " ").trim();
}

function styleStatus(theme: any, key: string, text: string): string {
	const style = STATUS_STYLE_MAP[key];
	return style ? style(theme, text) : text;
}

function installFooter(ctx: ExtensionContext) {
	if (!ctx.hasUI) return;

	ctx.ui.setFooter((tui, theme, footerData) => ({
		dispose: footerData.onBranchChange(() => tui.requestRender()),
		invalidate() {},
		render(width: number): string[] {
			const model = ctx.model?.id || "no-model";
			const usage = ctx.getContextUsage();
			const pct = clamp(Math.round(usage?.percent ?? 0), 0, 100);
			const filled = Math.round((pct / 100) * BAR_WIDTH);
			const bar = "#".repeat(filled) + "-".repeat(BAR_WIDTH - filled);

			const statusEntries = Array.from(footerData.getExtensionStatuses().entries())
				.map(([key, text]) => [key, sanitizeStatusText(text)] as const)
				.filter(([, text]) => Boolean(text));
			const statusTexts = statusEntries.map(([, text]) => text);

			const active = statusTexts.filter((s) => /research(ing)?/i.test(s)).length;
			const done = statusTexts.filter((s) => /(^|\s)(done|✓)(\s|$)/i.test(s)).length;

			const folder = getFolderName(ctx.sessionManager.getCwd());
			const branch = footerData.getGitBranch();
			const projectRef = branch ? `${folder} - ${branch}` : `${folder} - no-branch`;

			const left =
				theme.fg("dim", ` ${model}`) +
				theme.fg("muted", " · ") +
				theme.fg("accent", projectRef);

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
	}));
}

export default function (pi: ExtensionAPI) {
	pi.on("session_start", async (_event, ctx) => {
		installFooter(ctx);
	});

	pi.on("session_switch", async (_event, ctx) => {
		installFooter(ctx);
	});

	pi.on("session_fork", async (_event, ctx) => {
		installFooter(ctx);
	});

	pi.on("session_tree", async (_event, ctx) => {
		installFooter(ctx);
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		if (!ctx.hasUI) return;
		ctx.ui.setFooter(undefined);
	});
}
