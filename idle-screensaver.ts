/**
 * Idle screensaver — shows session context after 30 min of inactivity.
 *
 * Displays (in priority order):
 *   1. Session purpose
 *   2. Session name (from file path)
 *   3. folder / branch
 *
 * Plus the last 3 progress entries at the bottom.
 * Any keypress dismisses the overlay.
 */

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { DynamicBorder } from "@mariozechner/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";

// ─── Config ────────────────────────────────────────────────────────────────

const IDLE_MS = 30 * 60 * 1000; // 30 minutes
const PURPOSE_ENTRY_TYPE = "purpose:set";
const MAX_PROGRESS_HISTORY = 20;

// ─── State ─────────────────────────────────────────────────────────────────

let idleTimer: ReturnType<typeof setTimeout> | null = null;
let latestCtx: ExtensionContext | null = null;
let agentRunning = false;
let overlayActive = false;

/** Ring buffer for progress texts set during this session. */
const progressHistory: { text: string; at: number }[] = [];

// ─── Data extraction ───────────────────────────────────────────────────────

function readPurpose(ctx: ExtensionContext): string {
	try {
		const branch = ctx.sessionManager.getBranch();
		for (let i = branch.length - 1; i >= 0; i--) {
			const e = branch[i] as any;
			if (e?.type !== "custom" || e?.customType !== PURPOSE_ENTRY_TYPE) continue;
			const raw = e?.data?.purpose;
			if (typeof raw === "string" && raw.trim()) return raw.trim();
		}
	} catch { /* ignore */ }
	return "";
}

function readSessionName(ctx: ExtensionContext): string {
	try {
		const file = ctx.sessionManager.getSessionFile() ?? "";
		if (!file) return "";
		// e.g. /Users/x/.pi/sessions/my-session.jsonl → "my-session"
		const base = file.split(/[\\/]/).pop() ?? "";
		const name = base.replace(/\.[^.]+$/, ""); // strip extension
		if (!name || /^[0-9a-f-]+$/i.test(name)) return ""; // skip UUID-like names
		return name;
	} catch { /* ignore */ }
	return "";
}

function readFolderBranch(pi: ExtensionAPI, ctx: ExtensionContext): { folder: string; branch: string | null } {
	const cwd = ctx.sessionManager.getCwd();
	const parts = cwd.split(/[\\/]/).filter(Boolean);
	const folder = parts.length > 0 ? parts[parts.length - 1] : cwd || "unknown";
	return { folder, branch: null }; // branch resolved async later
}

function recentProgress(count: number): string[] {
	return progressHistory.slice(-count).map((p) => p.text);
}

function formatTime(ts: number): string {
	return new Date(ts).toLocaleTimeString("ko-KR", {
		hour: "2-digit",
		minute: "2-digit",
		hour12: false,
	});
}

function currentTimeString(): string {
	return new Date().toLocaleTimeString("ko-KR", {
		hour: "2-digit",
		minute: "2-digit",
		second: "2-digit",
		hour12: false,
	});
}

// ─── Rendering ─────────────────────────────────────────────────────────────

function centerPad(text: string, width: number): string {
	const vis = visibleWidth(text);
	if (vis >= width) return truncateToWidth(text, width);
	const left = Math.floor((width - vis) / 2);
	return " ".repeat(left) + text;
}

function renderScreensaver(
	width: number,
	height: number,
	theme: any,
	title: string,
	subtitle: string,
	progress: string[],
	time: string,
): string[] {
	const fg = (c: string, t: string) => theme.fg(c, t);
	const bold = (t: string) => theme.bold(t);
	const border = new DynamicBorder((s: string) => fg("accent", s));

	const innerW = Math.max(20, width - 4);
	const lines: string[] = [];

	// Top border
	lines.push(...border.render(width));
	lines.push("");

	// Clock
	const clockLine = fg("dim", time);
	lines.push(centerPad(clockLine, width));
	lines.push("");

	// Main title — big and centered
	const titleLines = title.length > innerW - 8
		? wrapText(title, innerW - 8)
		: [title];

	lines.push("");
	for (const tl of titleLines) {
		lines.push(centerPad(fg("accent", bold(tl)), width));
	}
	lines.push("");

	// Subtitle
	if (subtitle) {
		lines.push(centerPad(fg("muted", subtitle), width));
		lines.push("");
	}

	// Separator
	const sepW = Math.min(40, innerW);
	lines.push(centerPad(fg("dim", "─".repeat(sepW)), width));
	lines.push("");

	// Recent progress
	if (progress.length > 0) {
		lines.push(centerPad(fg("dim", "Recent Progress"), width));
		lines.push("");
		for (const p of progress) {
			lines.push(centerPad(fg("muted", `  ${p}`), width));
		}
	} else {
		lines.push(centerPad(fg("dim", "No recent progress"), width));
	}

	lines.push("");

	// Bottom hint
	lines.push(centerPad(fg("dim", "Press any key to dismiss"), width));

	lines.push("");
	lines.push(...border.render(width));

	// Vertically center within available height
	const totalLines = lines.length;
	if (totalLines < height) {
		const topPad = Math.floor((height - totalLines) / 2);
		const padded = [...Array(topPad).fill(""), ...lines];
		while (padded.length < height) padded.push("");
		return padded;
	}

	return lines;
}

function wrapText(text: string, maxWidth: number): string[] {
	const words = text.split(/\s+/);
	const lines: string[] = [];
	let current = "";

	for (const word of words) {
		const test = current ? `${current} ${word}` : word;
		if (visibleWidth(test) > maxWidth && current) {
			lines.push(current);
			current = word;
		} else {
			current = test;
		}
	}
	if (current) lines.push(current);
	return lines;
}

// ─── Timer management ──────────────────────────────────────────────────────

function clearIdle() {
	if (idleTimer) {
		clearTimeout(idleTimer);
		idleTimer = null;
	}
}

function resetIdle() {
	clearIdle();
	if (agentRunning || overlayActive || !latestCtx?.hasUI) return;
	idleTimer = setTimeout(() => void showScreensaver(), IDLE_MS);
}

async function showScreensaver(): Promise<void> {
	const ctx = latestCtx;
	if (!ctx?.hasUI || overlayActive || agentRunning) return;
	overlayActive = true;

	const purpose = readPurpose(ctx);
	const sessionName = readSessionName(ctx);
	const { folder } = readFolderBranch(undefined as unknown as ExtensionAPI, ctx);

	// Resolve branch
	let branchName = "";
	try {
		const cwd = ctx.sessionManager.getCwd();
		const r = await (globalPi as ExtensionAPI).exec("git", ["branch", "--show-current"], { cwd });
		if (r.code === 0) branchName = (r.stdout ?? "").trim();
	} catch { /* ignore */ }

	// Priority: purpose > session name > folder/branch
	const title = purpose || sessionName || folder;
	const subtitle = purpose
		? (sessionName || `${folder}${branchName ? ` / ${branchName}` : ""}`)
		: (sessionName ? `${folder}${branchName ? ` / ${branchName}` : ""}` : (branchName || ""));

	const progress = recentProgress(3);

	try {
		await ctx.ui.custom<void>(
			(tui, theme, _kb, done) => {
				let clockTimer: ReturnType<typeof setInterval> | null = null;
				let currentTime = currentTimeString();

				clockTimer = setInterval(() => {
					currentTime = currentTimeString();
					(tui as any).requestRender?.();
				}, 1000);

				return {
					render: (w: number) => {
						const h = (tui as any).height ?? 30;
						return renderScreensaver(w, h, theme, title, subtitle, progress, currentTime);
					},
					handleInput: (_data: string) => {
						if (clockTimer) clearInterval(clockTimer);
						done(undefined);
					},
					invalidate: () => {},
				};
			},
			{ overlay: true, overlayOptions: { width: "80%", maxHeight: "70%", anchor: "center" } },
		);
	} catch { /* overlay rejected — ignore */ }

	overlayActive = false;
	resetIdle();
}

// ─── Module-level pi reference (needed in async callbacks) ─────────────────

let globalPi: ExtensionAPI;

// ─── Extension ─────────────────────────────────────────────────────────────

export default function idleScreensaver(pi: ExtensionAPI) {
	globalPi = pi;

	// Track progress via tool_call interception
	pi.on("tool_call", async (event) => {
		if (event.toolName !== "set_progress") return undefined;
		// Extract progress text from params
		const params = (event as any).params ?? (event as any).arguments;
		if (params) {
			const text = typeof params === "string"
				? params
				: (params.progress ?? "");
			if (text) {
				progressHistory.push({ text, at: Date.now() });
				if (progressHistory.length > MAX_PROGRESS_HISTORY) progressHistory.shift();
			}
		}
		return undefined;
	});

	// Also scan entries on session start to recover history
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
					if (c?.type === "toolCall" && c?.name === "set_progress") {
						const args = c?.arguments;
						const text = typeof args === "string"
							? args
							: (args?.progress ?? "");
						if (text && !progressHistory.some((p) => p.text === text)) {
							progressHistory.push({ text, at: msg.timestamp ? new Date(msg.timestamp).getTime() : Date.now() });
						}
					}
				}
			}
			// Trim to max
			while (progressHistory.length > MAX_PROGRESS_HISTORY) progressHistory.shift();
		} catch { /* ignore */ }
	};

	// ── Event handlers ──

	pi.on("input", async (_event, ctx) => {
		latestCtx = ctx;
		resetIdle();
		return { action: "continue" as const };
	});

	pi.on("agent_start", async (_event, ctx) => {
		agentRunning = true;
		latestCtx = ctx;
		clearIdle();
	});

	pi.on("agent_end", async (_event, ctx) => {
		agentRunning = false;
		latestCtx = ctx;
		resetIdle();
	});

	pi.on("session_start", async (_event, ctx) => {
		agentRunning = false;
		latestCtx = ctx;
		overlayActive = false;
		progressHistory.length = 0;
		recoverProgressFromEntries(ctx);
		resetIdle();
	});

	pi.on("session_switch", async (_event, ctx) => {
		agentRunning = false;
		latestCtx = ctx;
		overlayActive = false;
		progressHistory.length = 0;
		recoverProgressFromEntries(ctx);
		resetIdle();
	});

	pi.on("session_shutdown", async () => {
		clearIdle();
		agentRunning = false;
		latestCtx = null;
		overlayActive = false;
		progressHistory.length = 0;
	});
}
