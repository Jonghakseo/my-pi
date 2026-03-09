import { execSync } from "node:child_process";
import type { ExtensionAPI, ExtensionContext, ThemeColor } from "@mariozechner/pi-coding-agent";
import { DynamicBorder } from "@mariozechner/pi-coding-agent";
import { visibleWidth } from "@mariozechner/pi-tui";

/**
 * Idle screensaver extension
 * Shows a full-screen overlay after 15 min of inactivity.
 * Dismissed by any keypress.
 */

const IDLE_MS = 15 * 60 * 1000; // 15 minutes
const PURPOSE_ENTRY_TYPE = "purpose:set" as const;

let idleTimer: ReturnType<typeof setTimeout> | null = null;
let agentRunning = false;
type ScreensaverTui = { terminal?: { rows?: number } };
type ScreensaverTheme = { fg: (color: ThemeColor, text: string) => string; bold: (text: string) => string };

let overlayActive = false;
let askUserQuestionActive = false;
let latestCtx: ExtensionContext | null = null;

// CustomEntry shape — matches the actual SDK structure used by purpose.ts
type CustomEntry = {
	type: "custom";
	customType: string;
	data: Record<string, unknown>;
	[key: string]: unknown;
};

function isCustomEntry(entry: unknown): entry is CustomEntry {
	if (typeof entry !== "object" || entry === null) return false;
	const e = entry as Record<string, unknown>;
	return e.type === "custom" && typeof e.customType === "string";
}

/** Read the most-recently-set purpose from the session branch (mirrors purpose.ts logic). */
function readPurposeFromSession(ctx: NonNullable<typeof latestCtx>): string {
	const branch = ctx.sessionManager.getBranch();
	for (let i = branch.length - 1; i >= 0; i--) {
		const entry = branch[i];
		if (!isCustomEntry(entry)) continue;
		if (entry.customType !== PURPOSE_ENTRY_TYPE) continue;
		const purpose = entry.data.purpose;
		if (typeof purpose === "string") {
			return purpose.trim(); // 빈값이어도 즉시 반환 — 최신 엔트리가 authoritative
		}
	}
	return "";
}

// ── Timer helpers ─────────────────────────────────────────────────────────────

function clearIdleTimer(): void {
	if (idleTimer) {
		clearTimeout(idleTimer);
		idleTimer = null;
	}
}

function scheduleIdleTimer(): void {
	clearIdleTimer();
	if (agentRunning || overlayActive || askUserQuestionActive) return;
	idleTimer = setTimeout(() => {
		void showScreensaver();
	}, IDLE_MS);
}

// ── Screensaver logic ─────────────────────────────────────────────────────────

async function showScreensaver(): Promise<void> {
	if (!latestCtx?.hasUI) return;

	overlayActive = true;
	clearIdleTimer();

	// Resolve title: prefer session purpose, fallback to folder/branch or session name
	const purposeText = readPurposeFromSession(latestCtx);

	let title: string;
	if (purposeText) {
		title = purposeText;
	} else {
		const folder = latestCtx.sessionManager.getCwd();
		const sessionName = latestCtx.sessionManager.getSessionName() ?? "Pi";
		let branch = "";
		try {
			branch = execSync("git branch --show-current", {
				cwd: folder,
				encoding: "utf8",
				stdio: ["pipe", "pipe", "pipe"],
			}).trim();
		} catch {}
		title = branch ? `${folder.split("/").pop()}/${branch}` : sessionName;
	}

	await latestCtx.ui.custom(
		(tui: ScreensaverTui, theme: ScreensaverTheme, _kb: unknown, done: (v: undefined) => void) => ({
			render: (w: number) => renderScreensaver(w, (tui.terminal?.rows as number | undefined) ?? 40, title, theme),
			handleInput: (_data: string) => {
				done(undefined);
			},
			invalidate: () => {},
		}),
		{ overlay: true, overlayOptions: { width: "100%", maxHeight: "100%", anchor: "center" } },
	);

	overlayActive = false;
	scheduleIdleTimer();
}

// ── Screensaver renderer ──────────────────────────────────────────────────────

function renderScreensaver(width: number, height: number, title: string, theme: ScreensaverTheme): string[] {
	const lines: string[] = [];

	// Border color helper
	const bc = (s: string): string => theme.fg("accent", s);

	// Top/bottom horizontal rules via DynamicBorder
	const hRule = new DynamicBorder(bc).render(width)[0] ?? bc("─".repeat(width));

	// Side border chars
	const L = bc("│");
	const R = bc("│");
	const innerWidth = width - 2;

	const emptyLine = (): string => L + " ".repeat(innerWidth) + R;

	const placeLine = (chars: string): string => {
		const vw = visibleWidth(chars);
		return L + chars + " ".repeat(Math.max(0, innerWidth - vw)) + R;
	};

	const centerLine = (text: string): string => {
		const tw = visibleWidth(text);
		const pad = Math.max(0, Math.floor((innerWidth - tw) / 2));
		return placeLine(" ".repeat(pad) + text);
	};

	// ── Title separators (no box) ───────────────────────────────
	const compact = title.trim();
	const spread = compact.length <= 24 ? compact.split("").join(" ") : compact;
	const titleText = spread || "Pi";

	const separatorWidth = Math.min(innerWidth - 4, Math.max(visibleWidth(titleText) + 8, 24));
	const separator = bc("─".repeat(Math.max(1, separatorWidth)));
	const topSeparatorLine = centerLine(separator);
	const titleLine = centerLine(theme.fg("accent", titleText) as string);
	const bottomSeparatorLine = centerLine(separator);

	// ── Layout ───────────────────────────────────────────────────
	const TITLE_BLOCK_H = 3;
	const FOOTER_H = 1;
	const innerHeight = height - 2;

	const contentH = TITLE_BLOCK_H + FOOTER_H;
	const topPad = Math.max(0, Math.floor((innerHeight - contentH) / 2) - 1);

	// ── Render ───────────────────────────────────────────────────
	// 1. Top border
	lines.push(hRule);

	// 2. Top padding
	for (let i = 0; i < topPad; i++) lines.push(emptyLine());

	// 3. Title with top/bottom separators (3 lines)
	lines.push(topSeparatorLine);
	lines.push(titleLine);
	lines.push(bottomSeparatorLine);

	// 4. Fill until footer
	while (lines.length < height - 2) lines.push(emptyLine());

	// 5. Footer hint
	if (lines.length === height - 2) {
		lines.push(centerLine(theme.fg("dim", "Press any key to dismiss") as string));
	}

	// 6. Bottom border
	while (lines.length < height - 1) lines.push(emptyLine());
	lines.push(hRule);

	return lines;
}

// ── Extension entry point ─────────────────────────────────────────────────────

export default function idleScreensaver(pi: ExtensionAPI): void {
	pi.on("input", (event, ctx) => {
		latestCtx = ctx;
		if (event.source !== "extension") {
			scheduleIdleTimer();
		}
	});

	pi.on("agent_start", (_event, ctx) => {
		latestCtx = ctx;
		agentRunning = true;
		clearIdleTimer();
	});

	pi.on("agent_end", (_event, ctx) => {
		latestCtx = ctx;
		agentRunning = false;
		scheduleIdleTimer();
	});

	pi.on("tool_execution_start", (event, ctx) => {
		latestCtx = ctx;
		if (event.toolName === "AskUserQuestion") {
			askUserQuestionActive = true;
			clearIdleTimer();
		}
	});

	pi.on("tool_execution_end", (event, ctx) => {
		latestCtx = ctx;
		if (event.toolName === "AskUserQuestion") {
			askUserQuestionActive = false;
			scheduleIdleTimer();
		}
	});

	pi.on("session_start", (_event, ctx) => {
		latestCtx = ctx;
		scheduleIdleTimer();
	});

	pi.on("session_switch", (_event, ctx) => {
		latestCtx = ctx;
		clearIdleTimer();
		overlayActive = false;
		scheduleIdleTimer();
	});

	pi.on("session_shutdown", () => {
		clearIdleTimer();
	});

	scheduleIdleTimer();
}
