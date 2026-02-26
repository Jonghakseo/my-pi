/**
 * Formatting and display utility functions for the Subagent tool.
 */

import * as os from "node:os";

// ─── Token / Usage Formatting ────────────────────────────────────────────────

export function formatTokens(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	return `${(count / 1000000).toFixed(1)}M`;
}

export function formatUsageStats(
	usage: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		cost: number;
		contextTokens?: number;
		turns?: number;
	},
	model?: string,
): string {
	const parts: string[] = [];
	if (usage.turns) parts.push(`${usage.turns} turn${usage.turns > 1 ? "s" : ""}`);
	if (usage.input) parts.push(`↑${formatTokens(usage.input)}`);
	if (usage.output) parts.push(`↓${formatTokens(usage.output)}`);
	if (usage.cacheRead) parts.push(`R${formatTokens(usage.cacheRead)}`);
	if (usage.cacheWrite) parts.push(`W${formatTokens(usage.cacheWrite)}`);
	if (usage.cost) parts.push(`$${usage.cost.toFixed(4)}`);
	if (usage.contextTokens && usage.contextTokens > 0) {
		parts.push(`ctx:${formatTokens(usage.contextTokens)}`);
	}
	if (model) parts.push(model);
	return parts.join(" ");
}

// ─── Context Usage ───────────────────────────────────────────────────────────

export function normalizeModelRef(modelRef: string): { provider?: string; id: string } {
	const cleaned = modelRef.trim().split(":")[0] ?? modelRef.trim();
	if (cleaned.includes("/")) {
		const [provider, ...idParts] = cleaned.split("/");
		return { provider, id: idParts.join("/") };
	}
	return { id: cleaned };
}

export function resolveContextWindow(ctx: any, modelRef?: string): number | undefined {
	const fallback = ctx?.model?.contextWindow;
	if (!ctx?.modelRegistry || typeof ctx.modelRegistry.getAll !== "function") return fallback;
	const models = ctx.modelRegistry.getAll() as Array<{ provider: string; id: string; contextWindow?: number }>;
	if (!modelRef) return fallback;

	const normalized = normalizeModelRef(modelRef);
	if (normalized.provider) {
		const exact = models.find((m) => m.provider === normalized.provider && m.id === normalized.id);
		if (exact?.contextWindow) return exact.contextWindow;
	}

	const byId = models.find((m) => m.id === normalized.id);
	if (byId?.contextWindow) return byId.contextWindow;

	return fallback;
}

export function getUsedContextPercent(contextTokens?: number, contextWindow?: number): number | undefined {
	if (!contextWindow || contextWindow <= 0) return undefined;
	if (contextTokens === undefined || contextTokens === null || contextTokens < 0) return undefined;
	return Math.max(0, Math.min(100, Math.round((contextTokens / contextWindow) * 100)));
}

export function getRemainingContextPercent(usedPercent?: number): number | undefined {
	if (usedPercent === undefined || usedPercent === null) return undefined;
	return Math.max(0, Math.min(100, 100 - usedPercent));
}

export function formatContextUsageBar(percent: number, width = 10): string {
	const clamped = Math.max(0, Math.min(100, Math.round(percent)));
	const barWidth = Math.max(4, width);
	const filled = Math.round((clamped / 100) * barWidth);
	return `[${"#".repeat(filled)}${"-".repeat(barWidth - filled)}] ${clamped}%`;
}

export function getContextBarColorByRemaining(remainingPercent: number): "warning" | "error" | undefined {
	if (remainingPercent <= 15) return "error";
	if (remainingPercent <= 40) return "warning";
	return undefined;
}

// ─── Agent Name Coloring ─────────────────────────────────────────────────────

// Vibrant ANSI-256 foreground colors for per-agent name coloring
// High saturation, diverse hues — readable on dark backgrounds
export const AGENT_NAME_PALETTE = [39, 208, 114, 204, 220, 141, 81, 209, 156, 177];

export function agentBgIndex(name: string): number {
	let h = 0;
	for (let i = 0; i < name.length; i++) {
		h = ((h << 5) - h + name.charCodeAt(i)) | 0;
	}
	return Math.abs(h) % AGENT_NAME_PALETTE.length;
}

// ─── Tool Call Formatting ────────────────────────────────────────────────────

export function formatToolCall(
	toolName: string,
	args: Record<string, unknown>,
	themeFg: (color: any, text: string) => string,
): string {
	const shortenPath = (p: string) => {
		const home = os.homedir();
		return p.startsWith(home) ? `~${p.slice(home.length)}` : p;
	};

	switch (toolName) {
		case "bash": {
			const command = (args.command as string) || "...";
			const preview = command.length > 60 ? `${command.slice(0, 60)}...` : command;
			return themeFg("muted", "$ ") + themeFg("toolOutput", preview);
		}
		case "read": {
			const rawPath = (args.file_path || args.path || "...") as string;
			const filePath = shortenPath(rawPath);
			const offset = args.offset as number | undefined;
			const limit = args.limit as number | undefined;
			let text = themeFg("accent", filePath);
			if (offset !== undefined || limit !== undefined) {
				const startLine = offset ?? 1;
				const endLine = limit !== undefined ? startLine + limit - 1 : "";
				text += themeFg("warning", `:${startLine}${endLine ? `-${endLine}` : ""}`);
			}
			return themeFg("muted", "read ") + text;
		}
		case "write": {
			const rawPath = (args.file_path || args.path || "...") as string;
			const filePath = shortenPath(rawPath);
			const content = (args.content || "") as string;
			const lines = content.split("\n").length;
			let text = themeFg("muted", "write ") + themeFg("accent", filePath);
			if (lines > 1) text += themeFg("dim", ` (${lines} lines)`);
			return text;
		}
		case "edit": {
			const rawPath = (args.file_path || args.path || "...") as string;
			return themeFg("muted", "edit ") + themeFg("accent", shortenPath(rawPath));
		}
		case "ls": {
			const rawPath = (args.path || ".") as string;
			return themeFg("muted", "ls ") + themeFg("accent", shortenPath(rawPath));
		}
		case "find": {
			const pattern = (args.pattern || "*") as string;
			const rawPath = (args.path || ".") as string;
			return themeFg("muted", "find ") + themeFg("accent", pattern) + themeFg("dim", ` in ${shortenPath(rawPath)}`);
		}
		case "grep": {
			const pattern = (args.pattern || "") as string;
			const rawPath = (args.path || ".") as string;
			return (
				themeFg("muted", "grep ") + themeFg("accent", `/${pattern}/`) + themeFg("dim", ` in ${shortenPath(rawPath)}`)
			);
		}
		default: {
			const argsStr = JSON.stringify(args);
			const preview = argsStr.length > 50 ? `${argsStr.slice(0, 50)}...` : argsStr;
			return themeFg("accent", toolName) + themeFg("dim", ` ${preview}`);
		}
	}
}

export function shortenPathForPreview(p: string): string {
	const home = os.homedir();
	return p.startsWith(home) ? `~${p.slice(home.length)}` : p;
}

export function formatToolCallPlain(toolName: string, args: Record<string, unknown>): string {
	switch (toolName) {
		case "bash": {
			const command = (args.command as string) || "...";
			const preview = command.length > 60 ? `${command.slice(0, 60)}...` : command;
			return `$ ${preview}`;
		}
		case "read": {
			const rawPath = (args.file_path || args.path || "...") as string;
			const filePath = shortenPathForPreview(rawPath);
			const offset = args.offset as number | undefined;
			const limit = args.limit as number | undefined;
			if (offset !== undefined || limit !== undefined) {
				const startLine = offset ?? 1;
				const endLine = limit !== undefined ? startLine + limit - 1 : "";
				return `read ${filePath}:${startLine}${endLine ? `-${endLine}` : ""}`;
			}
			return `read ${filePath}`;
		}
		case "write": {
			const rawPath = (args.file_path || args.path || "...") as string;
			const filePath = shortenPathForPreview(rawPath);
			const content = (args.content || "") as string;
			const lines = content.split("\n").length;
			return lines > 1 ? `write ${filePath} (${lines} lines)` : `write ${filePath}`;
		}
		case "edit": {
			const rawPath = (args.file_path || args.path || "...") as string;
			return `edit ${shortenPathForPreview(rawPath)}`;
		}
		case "ls": {
			const rawPath = (args.path || ".") as string;
			return `ls ${shortenPathForPreview(rawPath)}`;
		}
		case "find": {
			const pattern = (args.pattern || "*") as string;
			const rawPath = (args.path || ".") as string;
			return `find ${pattern} in ${shortenPathForPreview(rawPath)}`;
		}
		case "grep": {
			const pattern = (args.pattern || "") as string;
			const rawPath = (args.path || ".") as string;
			return `grep /${pattern}/ in ${shortenPathForPreview(rawPath)}`;
		}
		default: {
			const argsStr = JSON.stringify(args);
			const preview = argsStr.length > 50 ? `${argsStr.slice(0, 50)}...` : argsStr;
			return `${toolName} ${preview}`;
		}
	}
}

// ─── Text Truncation ─────────────────────────────────────────────────────────

/** Truncate text to at most `maxLines` lines, appending "..." if truncated. */
export function truncateLines(text: string, maxLines = 2): string {
	const lines = text.split("\n");
	if (lines.length <= maxLines) return text;
	return lines.slice(0, maxLines).join("\n") + "\n...";
}
