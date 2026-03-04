import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { DynamicBorder } from "@mariozechner/pi-coding-agent";
import { visibleWidth } from "@mariozechner/pi-tui";
import { execSync } from "child_process";
/**
 * Idle screensaver extension
 * Shows a full-screen overlay after 5 min of inactivity.
 * Dismissed by any keypress.
 */

const IDLE_MS = 5 * 60 * 1000; // 5 minutes
const PURPOSE_ENTRY_TYPE = "purpose:set";

let idleTimer: ReturnType<typeof setTimeout> | null = null;
let agentRunning = false;
let overlayActive = false;
let askUserQuestionActive = false;
let latestCtx: ExtensionContext | null = null;

// Custom session entry shape written by purpose.ts
interface PurposeSessionEntry {
	type: string;
	content?: unknown;
}

function isPurposeEntry(e: unknown): e is PurposeSessionEntry {
	return typeof e === "object" && e !== null && (e as PurposeSessionEntry).type === PURPOSE_ENTRY_TYPE;
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
	const entries = latestCtx.sessionManager.getEntries();
	const purposeEntry = [...(entries as PurposeSessionEntry[])].reverse().find((e) => e.type === PURPOSE_ENTRY_TYPE);

	let title: string;
	if (purposeEntry?.content && typeof purposeEntry.content === "string") {
		title = purposeEntry.content;
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
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		(tui: any, theme: any, _kb: unknown, done: (v: undefined) => void) => ({
			render: (w: number) =>
				renderScreensaver(w, (tui.terminal?.rows as number | undefined) ?? 40, title, theme),
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

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function renderScreensaver(width: number, height: number, title: string, theme: any): string[] {
	const lines: string[] = [];

	// Border color helper
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	const bc = (s: string): string => theme.fg("accent", s) as string;

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

	// ── Title double-box ─────────────────────────────────────────
	const compact = title.trim();
	const spread = compact.length <= 24 ? compact.split("").join(" ") : compact;

	const doubleBoxW = Math.min(innerWidth - 4, Math.max(visibleWidth(spread) + 8, 40));
	const dblLeft = Math.floor((innerWidth - doubleBoxW) / 2);
	const leftPad = " ".repeat(dblLeft);

	const titleInBox =
		visibleWidth(spread) <= doubleBoxW - 4
			? spread.padStart(Math.floor((doubleBoxW - 2 + spread.length) / 2)).padEnd(doubleBoxW - 2)
			: spread.slice(0, doubleBoxW - 4);

	const placeBoxLine = (chars: string): string => {
		const vw = visibleWidth(leftPad + chars);
		return L + leftPad + chars + " ".repeat(Math.max(0, innerWidth - vw)) + R;
	};

	const topDoubleBar = "╔" + "═".repeat(doubleBoxW - 2) + "╗";
	const titleBar = "║" + " " + titleInBox + " " + "║";
	const midDoubleBar = "║" + " ".repeat(doubleBoxW - 2) + "║";
	const botDoubleBar = "╚" + "═".repeat(doubleBoxW - 2) + "╝";

	// ── Layout ───────────────────────────────────────────────────
	const TITLE_BOX_H = 4;
	const FOOTER_H = 1;
	const innerHeight = height - 2;

	const contentH = TITLE_BOX_H + FOOTER_H;
	const topPad = Math.max(0, Math.floor((innerHeight - contentH) / 2) - 1);

	// ── Render ───────────────────────────────────────────────────
	// 1. Top border
	lines.push(hRule);

	// 2. Top padding
	for (let i = 0; i < topPad; i++) lines.push(emptyLine());

	// 3. Title double-box (4 lines)
	lines.push(placeBoxLine(topDoubleBar));
	lines.push(placeBoxLine(titleBar));
	lines.push(placeBoxLine(midDoubleBar));
	lines.push(placeBoxLine(botDoubleBar));

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
