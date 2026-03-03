/**
 * Idle screensaver — shows session context after inactivity.
 *
 * Displays (priority): purpose || folder/branch || session name.
 * Shows active blueprint (if running or confirmed) with node statuses.
 * Any key dismisses the overlay.
 */

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { DynamicBorder } from "@mariozechner/pi-coding-agent";
import { truncateText, textWidth } from "@mariozechner/pi-tui";
import type { Blueprint, NodeStatus } from "./intent/types";
import { listBlueprints } from "./intent/blueprints";

// ─── Config ────────────────────────────────────────────────────────────────

const IDLE_MS = 30 * 60 * 1000; // 30 minutes
const EDITOR_POLL_INTERVAL_MS = 300;
const PURPOSE_ENTRY_TYPE = "purpose:set";

// ─── State ─────────────────────────────────────────────────────────────────

let idleTimer: ReturnType<typeof setTimeout> | null = null;
let editorPollTimer: ReturnType<typeof setInterval> | null = null;
let lastEditorText = "";
let latestCtx: ExtensionContext | null = null;
let agentRunning = false;
let overlayActive = false;
let askUserQuestionActive = false;
let globalPi: ExtensionAPI;

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

// ─── Blueprint helpers ──────────────────────────────────────────────────────

function nodeStatusIcon(status: NodeStatus): string {
	switch (status) {
		case "pending":
			return "⏳";
		case "running":
			return "🔄";
		case "completed":
			return "✅";
		case "failed":
			return "❌";
		case "skipped":
			return "⏭ ";
		default:
			return "  ";
	}
}

function buildBlueprintLines(blueprint: Blueprint, maxWidth: number): string[] {
	const lines: string[] = [];

	// Line 1: title + badge
	let badge = "";
	switch (blueprint.status) {
		case "confirmed":
			badge = "📋 confirmed";
			break;
		case "running":
			badge = "▶  running";
			break;
		case "completed":
			badge = "✅ done";
			break;
		case "failed":
			badge = "❌ failed";
			break;
		case "aborted":
			badge = "🚫 aborted";
			break;
	}
	lines.push(`${blueprint.title}  ${badge}`);

	// Line 2: separator
	lines.push("─".repeat(Math.min(maxWidth, 60)));

	// Lines 3+: nodes
	for (const node of blueprint.nodes) {
		const icon = nodeStatusIcon(node.status);
		const prefix = `${icon} ${node.id} — `;
		const prefixWidth = textWidth(prefix);
		const availableWidth = Math.max(0, maxWidth - prefixWidth - 1);
		const truncatedTask = truncateText(node.task, availableWidth);
		lines.push(`${prefix}${truncatedTask}`);
	}

	return lines;
}

// ─── Screensaver rendering ──────────────────────────────────────────────────

function renderScreensaver(
	width: number,
	height: number,
	title: string,
	blueprint?: Blueprint | null,
): string {
	const lines: string[] = [];

	const border = new DynamicBorder(width, height, {
		title: " Pi ",
		titlePosition: "right",
		style: "single",
	});

	const borderLines = border.getLines();
	const innerWidth = border.innerWidth;
	const innerHeight = border.innerHeight;

	// ── header ──────────────────────────────────────────────────────
	lines.push(borderLines[0]);

	// ── calculate dynamic top padding ────────────────────────────────
	// Base content: 4 lines (title box) + 1 line (footer)
	let baseContentH = 5;
	if (blueprint) {
		// With blueprint: add spacing + blueprint lines + footer
		const bpLines = buildBlueprintLines(blueprint, innerWidth - 4);
		const maxBpLines = Math.max(0, height - 6 - baseContentH); // leave room for spacing + footer
		baseContentH += 1 + Math.min(bpLines.length, maxBpLines);
	}
	const topPad = Math.max(0, Math.floor((innerHeight - baseContentH) / 2) - 1);
	for (let i = 0; i < topPad; i++) lines.push(borderLines[lines.length]);

	// ── title box ───────────────────────────────────────────────────
	const compact = title.trim();
	const spread = compact.length <= 24 ? compact.split("").join(" ") : compact;

	const centerLine = (text: string) => {
		const vw = textWidth(text);
		const pad = Math.max(0, Math.floor((innerWidth - vw) / 2));
		return (
			borderLines[lines.length]
				.slice(0, 1)
				.padEnd(1 + pad)
				.concat(text)
				.padEnd(width - 1)
				.concat(borderLines[lines.length].slice(-1))
		);
	};

	const doubleBoxW = Math.min(innerWidth - 4, Math.max(spread.length + 8, 40));
	const dblLeft = Math.floor((innerWidth - doubleBoxW) / 2);

	const topDoubleBar = "╔" + "═".repeat(doubleBoxW - 2) + "╗";
	const midDoubleBar = "║" + " ".repeat(doubleBoxW - 2) + "║";
	const botDoubleBar = "╚" + "═".repeat(doubleBoxW - 2) + "╝";

	const titleInBox =
		spread.length <= doubleBoxW - 4
			? spread
					.padStart(Math.floor((doubleBoxW - 2 + spread.length) / 2)))
					.padEnd(doubleBoxW - 2)
			: spread.slice(0, doubleBoxW - 4);

	const emptyBorderLine = () => borderLines[lines.length];

	const placeLine = (chars: string) => {
		const idx = lines.length;
		const left = borderLines[idx].slice(0, 1);
		const right = borderLines[idx].slice(-1);
		const vw = textWidth(chars);
		return left + chars + " ".repeat(Math.max(0, innerWidth - vw)) + right;
	};

	lines.push(placeLine(topDoubleBar));
	lines.push(
		placeLine(
			midDoubleBar.slice(0, 1) +
				" " +
				titleInBox +
				" " +
				midDoubleBar.slice(-1),
		),
	);
	lines.push(placeLine(midDoubleBar));
	lines.push(placeLine(botDoubleBar));

	// ── blueprint widget ────────────────────────────────────────────
	if (blueprint) {
		const bpLines = buildBlueprintLines(blueprint, innerWidth - 4);
		const maxBpLines = Math.max(0, height - lines.length - 3);
		const visible = bpLines.slice(0, maxBpLines);
		if (visible.length > 0) {
			lines.push(emptyBorderLine()); // spacing line
			for (const bl of visible) {
				if (lines.length >= height - 2) break;
				lines.push(placeLine("  " + bl));
			}
		}
	}

	// ── "Press any key" footer ──────────────────────────────────────
	const footerText = "Press any key to dismiss";
	lines.push(centerLine(footerText));

	// ── fill remaining inner rows ───────────────────────────────────
	while (lines.length < height - 1) lines.push(borderLines[lines.length]);
	lines.push(borderLines[height - 1]);

	return lines.join("\n");
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
	if (agentRunning || overlayActive || askUserQuestionActive || !latestCtx?.hasUI)
		return;
	idleTimer = setTimeout(() => void showScreensaver(), IDLE_MS);
}

async function showScreensaver(): Promise<void> {
	const ctx = latestCtx;
	if (!ctx?.hasUI || overlayActive || agentRunning || askUserQuestionActive) return;
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
	const title = purpose || folderBranch || sessionName;

	// Find active blueprint (running or confirmed)
	let activeBlueprint: Blueprint | null = null;
	try {
		const blueprints = listBlueprints();
		activeBlueprint =
			blueprints.find((b) => b.status === "running" || b.status === "confirmed") ??
			null;
	} catch {
		// ignore blueprint errors
	}

	try {
		await ctx.ui.custom<void>(
			(tui, _theme, _kb, done) => ({
				render: (w: number) => {
					const h = (tui as any).height ?? 32;
					return renderScreensaver(w, h, title, activeBlueprint);
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
		askUserQuestionActive = false;
		latestCtx = ctx;
		ensureEditorPoller(ctx);
		scheduleIdleTimer();
	});

	pi.on("tool_execution_start", async (event) => {
		if (event.toolName === "AskUserQuestion") {
			askUserQuestionActive = true;
			clearIdleTimer();
		}
	});

	pi.on("tool_execution_end", async (event) => {
		if (event.toolName === "AskUserQuestion") {
			askUserQuestionActive = false;
		}
	});

	pi.on("session_start", async (_event, ctx) => {
		agentRunning = false;
		overlayActive = false;
		latestCtx = ctx;
		ensureEditorPoller(ctx, true);
		scheduleIdleTimer();
	});

	pi.on("session_switch", async (_event, ctx) => {
		agentRunning = false;
		overlayActive = false;
		latestCtx = ctx;
		ensureEditorPoller(ctx, true);
		scheduleIdleTimer();
	});

	pi.on("session_shutdown", async () => {
		clearIdleTimer();
		clearEditorPoller();
		lastEditorText = "";
		agentRunning = false;
		overlayActive = false;
		askUserQuestionActive = false;
		latestCtx = null;
	});
}
