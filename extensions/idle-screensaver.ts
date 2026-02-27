/**
 * Idle screensaver — shows session context after 10 min of inactivity.
 *
 * Displays (priority): purpose || session name || folder/branch.
 * Shows recent 3 progress entries at the bottom.
 * Any key dismisses the overlay.
 */

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { DynamicBorder } from "@mariozechner/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";

// ─── Config ────────────────────────────────────────────────────────────────

const IDLE_MS = 5 * 60 * 1000; // 5 minutes
const EDITOR_POLL_INTERVAL_MS = 300;
const PURPOSE_ENTRY_TYPE = "purpose:set";
const MAX_PROGRESS_HISTORY = 30;

type ProgressSnapshot = { text: string; at: number };

// ─── State ─────────────────────────────────────────────────────────────────

let idleTimer: ReturnType<typeof setTimeout> | null = null;
let editorPollTimer: ReturnType<typeof setInterval> | null = null;
let lastEditorText = "";
let latestCtx: ExtensionContext | null = null;
let agentRunning = false;
let overlayActive = false;
let globalPi: ExtensionAPI;

const progressHistory: ProgressSnapshot[] = [];

// ─── Helpers ───────────────────────────────────────────────────────────────

function normalizeLine(raw: unknown): string {
	if (typeof raw !== "string") return "";
	return raw.replace(/\s+/g, " ").trim();
}

function isLikelySessionId(text: string): boolean {
	const s = normalizeLine(text);
	if (!s) return true;

	const compact = s.replace(/[-_]/g, "");
	if (/^[0-9a-f]{16,}$/i.test(compact)) return true;
	if (/^session[-_]?\d+$/i.test(s)) return true;
	if (/^session[-_]?[0-9a-f-]{8,}$/i.test(s)) return true;
	return false;
}

function readPurpose(ctx: ExtensionContext): string {
	try {
		const branch = ctx.sessionManager.getBranch();
		for (let i = branch.length - 1; i >= 0; i--) {
			const e = branch[i] as any;
			if (e?.type !== "custom" || e?.customType !== PURPOSE_ENTRY_TYPE) continue;
			const purpose = normalizeLine(e?.data?.purpose);
			if (purpose) return purpose;
		}
	} catch {
		// ignore
	}
	return "";
}

function readSessionName(ctx: ExtensionContext): string {
	try {
		const header = (ctx.sessionManager as any)?.getHeader?.();
		const headerName = normalizeLine(header?.name);
		if (headerName && !isLikelySessionId(headerName)) return headerName;
	} catch {
		// ignore
	}

	try {
		const file = ctx.sessionManager.getSessionFile() ?? "";
		if (!file) return "";
		const base = file.split(/[\\/]/).pop() ?? "";
		const name = normalizeLine(base.replace(/\.[^.]+$/, ""));
		if (!name || isLikelySessionId(name)) return "";
		return name;
	} catch {
		// ignore
	}
	return "";
}

function readFolder(ctx: ExtensionContext): string {
	const cwd = ctx.sessionManager.getCwd();
	const parts = cwd.split(/[\\/]/).filter(Boolean);
	return parts.length > 0 ? parts[parts.length - 1] : cwd || "unknown";
}

function formatShortTime(ts: number): string {
	return new Date(ts).toLocaleTimeString("ko-KR", {
		hour: "2-digit",
		minute: "2-digit",
		hour12: false,
	});
}

function recentProgress(count: number): ProgressSnapshot[] {
	return progressHistory.slice(-count);
}

function centerPad(text: string, width: number): string {
	const vis = visibleWidth(text);
	if (vis >= width) return truncateToWidth(text, width);
	return `${" ".repeat(Math.floor((width - vis) / 2))}${text}`;
}

function wrapText(text: string, maxWidth: number): string[] {
	const input = normalizeLine(text);
	if (!input) return [""];
	const words = input.split(" ");
	const lines: string[] = [];
	let current = "";

	for (const w of words) {
		const next = current ? `${current} ${w}` : w;
		if (visibleWidth(next) > maxWidth && current) {
			lines.push(current);
			current = w;
		} else {
			current = next;
		}
	}
	if (current) lines.push(current);
	return lines;
}

function stylizeTitleLine(text: string, maxWidth: number): string {
	const compact = normalizeLine(text);
	if (!compact) return "";
	const spread = compact.split("").join(" ");
	if (compact.length <= 24 && visibleWidth(spread) <= maxWidth) return spread;
	return compact;
}

function renderScreensaver(
	width: number,
	height: number,
	theme: any,
	title: string,
	progress: ProgressSnapshot[],
): string[] {
	const fg = (c: string, t: string) => theme.fg(c, t);
	const bold = (t: string) => theme.bold(t);
	const border = new DynamicBorder((s: string) => fg("accent", s));

	const innerW = Math.max(20, width - 4);
	const out: string[] = [];

	// Stronger frame
	out.push(...border.render(width));
	out.push(centerPad(fg("accent", bold(" IDLE MODE ")), width));
	out.push(centerPad(fg("dim", "─".repeat(Math.min(innerW, 52))), width));
	out.push("");

	// Main title box (larger emphasis)
	const titleLinesRaw = wrapText(title || "(untitled session)", Math.max(16, innerW - 14));
	const titleLines = titleLinesRaw.slice(0, 3).map((l) => stylizeTitleLine(l, Math.max(16, innerW - 20)));

	const boxInner = Math.max(24, Math.min(innerW - 10, Math.floor(innerW * 0.78)));
	const boxTop = `╔${"═".repeat(boxInner + 2)}╗`;
	const boxBottom = `╚${"═".repeat(boxInner + 2)}╝`;
	const blankRow = `║ ${" ".repeat(boxInner)} ║`;
	const boxColor = "warning";

	out.push(centerPad(fg(boxColor, boxTop), width));
	out.push(centerPad(fg(boxColor, blankRow), width));
	for (const raw of titleLines) {
		const clipped = truncateToWidth(raw, boxInner);
		const textWidth = visibleWidth(clipped);
		const leftPadLen = Math.max(0, Math.floor((boxInner - textWidth) / 2));
		const rightPadLen = Math.max(0, boxInner - textWidth - leftPadLen);
		const leftPad = " ".repeat(leftPadLen);
		const rightPad = " ".repeat(rightPadLen);
		const row = `${fg(boxColor, "║ ")}${leftPad}${fg("accent", bold(clipped))}${rightPad}${fg(boxColor, " ║")}`;
		out.push(centerPad(row, width));
	}
	out.push(centerPad(fg(boxColor, blankRow), width));
	out.push(centerPad(fg(boxColor, boxBottom), width));
	out.push("");

	// Progress section
	out.push(centerPad(fg("muted", "Recent progress"), width));
	out.push(centerPad(fg("dim", "─".repeat(Math.min(innerW, 42))), width));
	out.push("");

	const recent = progress.slice(-3).reverse();
	if (recent.length === 0) {
		out.push(centerPad(fg("dim", "No recent progress"), width));
	} else {
		const rowMaxText = Math.max(20, Math.min(innerW - 22, 90));
		for (const p of recent) {
			const time = formatShortTime(p.at);
			const text = truncateToWidth(normalizeLine(p.text), rowMaxText);
			out.push(centerPad(`${fg("dim", `[${time}]`)} ${fg("muted", text)}`, width));
		}
	}

	out.push("");
	out.push(centerPad(fg("dim", "Press any key to dismiss"), width));
	out.push("");
	out.push(...border.render(width));

	// top-align content (avoid large blank area above header)
	if (out.length < height) {
		const padded = [...out];
		while (padded.length < height) padded.push("");
		return padded;
	}

	return out;
}

// ─── Timer control ─────────────────────────────────────────────────────────

function readEditorText(ctx: ExtensionContext): string {
	if (!ctx.hasUI) return "";
	try {
		const text = ctx.ui.getEditorText();
		return typeof text === "string" ? text : "";
	} catch {
		return "";
	}
}

function clearEditorPoller() {
	if (!editorPollTimer) return;
	clearInterval(editorPollTimer);
	editorPollTimer = null;
}

function ensureEditorPoller(ctx: ExtensionContext, forceRestart = false) {
	if (!ctx.hasUI) {
		clearEditorPoller();
		lastEditorText = "";
		return;
	}
	if (forceRestart) clearEditorPoller();
	if (editorPollTimer) return;

	lastEditorText = readEditorText(ctx);
	editorPollTimer = setInterval(() => {
		const activeCtx = latestCtx;
		if (!activeCtx?.hasUI || overlayActive || agentRunning) return;

		const currentEditorText = readEditorText(activeCtx);
		if (currentEditorText === lastEditorText) return;

		lastEditorText = currentEditorText;
		scheduleIdleTimer();
	}, EDITOR_POLL_INTERVAL_MS);
}

function clearIdleTimer() {
	if (!idleTimer) return;
	clearTimeout(idleTimer);
	idleTimer = null;
}

function scheduleIdleTimer() {
	clearIdleTimer();
	if (agentRunning || overlayActive || !latestCtx?.hasUI) return;
	idleTimer = setTimeout(() => void showScreensaver(), IDLE_MS);
}

async function showScreensaver(): Promise<void> {
	const ctx = latestCtx;
	if (!ctx?.hasUI || overlayActive || agentRunning) return;
	overlayActive = true;

	const purpose = readPurpose(ctx);
	const sessionName = readSessionName(ctx);
	const folder = readFolder(ctx);

	let branchName = "";
	try {
		const cwd = ctx.sessionManager.getCwd();
		const r = await globalPi.exec("git", ["branch", "--show-current"], { cwd });
		if (r.code === 0) branchName = normalizeLine(r.stdout);
	} catch {
		// ignore git errors
	}

	const folderBranch = branchName ? `${folder} / ${branchName}` : folder;
	const title = purpose || sessionName || folderBranch;
	const progress = recentProgress(3);

	try {
		await ctx.ui.custom<void>(
			(tui, theme, _kb, done) => ({
				render: (w: number) => {
					const h = (tui as any).height ?? 32;
					return renderScreensaver(w, h, theme, title, progress);
				},
				handleInput: () => done(undefined),
				invalidate: () => {},
			}),
			{
				overlay: true,
				overlayOptions: { width: "92%", maxHeight: "75%", anchor: "center" },
			},
		);
	} catch {
		// ignore overlay errors
	} finally {
		overlayActive = false;
		scheduleIdleTimer();
	}
}

// ─── Extension ─────────────────────────────────────────────────────────────

export default function idleScreensaver(pi: ExtensionAPI) {
	globalPi = pi;

	pi.on("tool_call", async (event) => {
		if (event.toolName !== "set_progress") return undefined;
		const raw = (event as any).params ?? (event as any).arguments;
		const text = typeof raw === "string" ? normalizeLine(raw) : normalizeLine(raw?.progress);
		if (text) {
			progressHistory.push({ text, at: Date.now() });
			while (progressHistory.length > MAX_PROGRESS_HISTORY) progressHistory.shift();
		}
		return undefined;
	});

	const recoverProgressFromEntries = (ctx: ExtensionContext) => {
		try {
			const entries = ctx.sessionManager.getEntries();
			for (const entry of entries) {
				const e = entry as any;
				if (e?.type !== "message") continue;
				const msg = e?.message;
				if (!msg || msg.role !== "assistant") continue;
				const content = msg.content;
				if (!Array.isArray(content)) continue;

				for (const c of content) {
					if (c?.type !== "toolCall" || c?.name !== "set_progress") continue;
					const args = c.arguments;
					const text = typeof args === "string" ? normalizeLine(args) : normalizeLine(args?.progress);
					if (!text) continue;
					progressHistory.push({ text, at: msg.timestamp ? new Date(msg.timestamp).getTime() : Date.now() });
				}
			}
			while (progressHistory.length > MAX_PROGRESS_HISTORY) progressHistory.shift();
		} catch {
			// ignore
		}
	};

	pi.on("input", async (event, ctx) => {
		latestCtx = ctx;
		ensureEditorPoller(ctx);
		if (event.source !== "extension") {
			scheduleIdleTimer();
		}
		return { action: "continue" as const };
	});

	pi.on("agent_start", async (_event, ctx) => {
		agentRunning = true;
		latestCtx = ctx;
		clearIdleTimer();
	});

	pi.on("agent_end", async (_event, ctx) => {
		agentRunning = false;
		latestCtx = ctx;
		ensureEditorPoller(ctx);
		scheduleIdleTimer();
	});

	pi.on("session_start", async (_event, ctx) => {
		agentRunning = false;
		overlayActive = false;
		latestCtx = ctx;
		progressHistory.length = 0;
		recoverProgressFromEntries(ctx);
		ensureEditorPoller(ctx, true);
		scheduleIdleTimer();
	});

	pi.on("session_switch", async (_event, ctx) => {
		agentRunning = false;
		overlayActive = false;
		latestCtx = ctx;
		progressHistory.length = 0;
		recoverProgressFromEntries(ctx);
		ensureEditorPoller(ctx, true);
		scheduleIdleTimer();
	});

	pi.on("session_shutdown", async () => {
		clearIdleTimer();
		clearEditorPoller();
		lastEditorText = "";
		agentRunning = false;
		overlayActive = false;
		latestCtx = null;
		progressHistory.length = 0;
	});
}
