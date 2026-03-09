import { spawn } from "node:child_process";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { PURPOSE_STATUS_KEY } from "./utils/status-keys.ts";

const PURPOSE_ENTRY_TYPE = "purpose:set";
const PURPOSE_COMMAND_NAME = "purpose";
const LEGACY_WIDGET_KEY = "purpose";
// Backward-compat alias for old builds that referenced WIDGET_KEY directly.
const WIDGET_KEY = LEGACY_WIDGET_KEY;

// Subagent session directory — must match subagent/session.ts:SUBAGENT_SESSION_DIR
const SUBAGENT_SESSION_DIR = path.join(os.homedir(), ".pi", "agent", "sessions", "subagents");

type PurposeEntryData = {
	purpose: string;
	source: "command" | "auto";
	updatedAt: string;
};

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

function isSubagentSession(ctx: ExtensionContext): boolean {
	try {
		const sessionManager = ctx.sessionManager;
		if (sessionManager && typeof sessionManager === "object" && "getSessionFile" in sessionManager) {
			const getSessionFile = (sessionManager as Record<string, unknown>).getSessionFile;
			if (typeof getSessionFile === "function") {
				const raw = String(getSessionFile() ?? "");
				const sessionFile = raw.replace(/[\r\n\t]+/g, "").trim() || undefined;
				if (sessionFile) {
					return (
						sessionFile.startsWith(SUBAGENT_SESSION_DIR + path.sep) ||
						sessionFile.startsWith(`${SUBAGENT_SESSION_DIR}/`)
					);
				}
			}
		}
	} catch {
		// Ignore errors — treat as not a subagent session
	}
	return false;
}

function normalizePurpose(raw: unknown): string {
	if (typeof raw !== "string") return "";
	return raw.replace(/\s+/g, " ").trim();
}

function formatPurposeStatus(purpose: string): string {
	const singleLine = normalizePurpose(purpose);
	const maxChars = 90;
	const clipped = singleLine.length > maxChars ? `${singleLine.slice(0, maxChars - 1)}…` : singleLine;
	return clipped;
}

function readPurposeFromSession(ctx: ExtensionContext): string {
	const branch = ctx.sessionManager.getBranch();

	for (let i = branch.length - 1; i >= 0; i--) {
		const entry = branch[i];
		if (!isCustomEntry(entry)) continue;
		if (entry.customType !== PURPOSE_ENTRY_TYPE) continue;
		const data = entry.data;
		if (typeof data !== "object" || data === null) continue;
		const dataObj = data as Record<string, unknown>;
		const purpose = dataObj.purpose;
		if (typeof purpose === "string") {
			return normalizePurpose(purpose);
		}
	}

	return "";
}

async function detectPurposeFromHistory(historyText: string): Promise<string> {
	return new Promise((resolve) => {
		const systemPrompt =
			"대화 히스토리를 분석해서 이 세션의 핵심 목적을 20자 이내 한 줄로 추출해. 오직 목적 텍스트만 출력하고, 설명이나 다른 텍스트는 절대 출력하지 마.";

		const args = [
			"--no-extensions",
			"--no-skills",
			"--no-prompt-templates",
			"--no-session",
			"--system-prompt",
			systemPrompt,
			"-p",
			historyText.slice(0, 2000),
		];

		let output = "";
		const proc = spawn("pi", args, {
			env: process.env,
			// child pi가 stdin을 기다리며 hang 되는 현상 방지
			stdio: ["ignore", "pipe", "pipe"],
		});

		const timer = setTimeout(() => {
			proc.kill();
			resolve("");
		}, 15000);

		proc.stdout.on("data", (chunk: Buffer) => {
			output += chunk.toString();
		});

		proc.on("close", () => {
			clearTimeout(timer);
			resolve(output.trim().slice(0, 30));
		});

		proc.on("error", () => {
			clearTimeout(timer);
			resolve("");
		});
	});
}

export default function purposeExtension(pi: ExtensionAPI) {
	let currentPurpose = "";

	const hasPurpose = () => currentPurpose.length > 0;

	const updateStatus = (ctx: ExtensionContext) => {
		if (!ctx.hasUI) return;

		// Clean up old widget rendering from previous purpose versions.
		ctx.ui.setWidget(WIDGET_KEY, undefined);

		if (!hasPurpose()) {
			ctx.ui.setStatus(PURPOSE_STATUS_KEY, undefined);
			return;
		}

		ctx.ui.setStatus(PURPOSE_STATUS_KEY, formatPurposeStatus(currentPurpose));
	};

	const syncPurpose = (ctx: ExtensionContext) => {
		currentPurpose = readPurposeFromSession(ctx);
		updateStatus(ctx);
	};

	const persistPurpose = (ctx: ExtensionContext, purpose: string, source: PurposeEntryData["source"]) => {
		const normalized = normalizePurpose(purpose);
		currentPurpose = normalized;
		pi.appendEntry<PurposeEntryData>(PURPOSE_ENTRY_TYPE, {
			purpose: normalized,
			source,
			updatedAt: new Date().toISOString(),
		});
		updateStatus(ctx);
		return normalized;
	};

	const notify = (ctx: ExtensionContext, message: string, type: "info" | "warning" | "error" = "info") => {
		if (ctx.hasUI) {
			ctx.ui.notify(message, type);
			return;
		}

		pi.sendMessage(
			{
				customType: "purpose",
				content: message,
				display: true,
			},
			{ triggerTurn: false },
		);
	};

	// ── Command ──────────────────────────────────────────────────

	pi.registerCommand(PURPOSE_COMMAND_NAME, {
		description: "Set or view session purpose. Usage: /purpose <text> | /purpose clear",
		handler: async (args, ctx) => {
			const raw = args.trim();

			if (!raw) {
				if (hasPurpose()) {
					notify(ctx, `현재 세션 목적: ${currentPurpose}`, "info");
				} else {
					notify(ctx, "세션 목적이 비어 있습니다. /purpose <세션 목적> 으로 설정하세요.", "warning");
				}
				return;
			}

			if (/^(clear|reset|none|empty)$/i.test(raw)) {
				persistPurpose(ctx, "", "command");
				notify(ctx, "세션 목적을 비웠습니다.", "warning");
				return;
			}

			const normalized = persistPurpose(ctx, raw, "command");
			notify(ctx, `세션 목적 설정 완료: ${normalized}`, "info");
		},
	});

	// ── Auto Purpose (every 5 user messages) ─────────────────────

	const AUTO_PURPOSE_INTERVAL = 5;
	let userMessageCount = 0;
	let purposeDetectionInFlight = false;

	pi.on("before_agent_start", async (_event, ctx) => {
		// Do not auto-generate purpose in subagent sessions
		if (isSubagentSession(ctx)) return;

		userMessageCount++;

		// 5 메시지마다 purpose 존재 확인 → 없으면 감지 시도
		if (userMessageCount % AUTO_PURPOSE_INTERVAL !== 0) return;
		if (hasPurpose()) return;
		if (purposeDetectionInFlight) return;

		// 대화 히스토리에서 user/assistant 메시지 추출
		const branch = ctx.sessionManager.getBranch();
		const lines: string[] = [];
		for (const entry of branch) {
			if (!("type" in entry) || entry.type !== "message") continue;
			const msg = (entry as { message?: { role?: string; content?: unknown } }).message;
			if (!msg?.role) continue;
			if (msg.role !== "user" && msg.role !== "assistant") continue;
			const text = typeof msg.content === "string"
				? msg.content
				: Array.isArray(msg.content)
					? msg.content.filter((c: any) => c.type === "text").map((c: any) => c.text).join(" ")
					: "";
			if (!text) continue;
			const label = msg.role === "user" ? "User" : "Assistant";
			lines.push(`${label}: ${text.slice(0, 200)}`);
		}

		if (lines.length === 0) return;

		purposeDetectionInFlight = true;

		// Fire-and-forget: 비동기로 purpose 감지 후 설정
		(async () => {
			try {
				const detected = await detectPurposeFromHistory(lines.join("\n"));
				if (detected && !hasPurpose()) {
					persistPurpose(ctx, detected, "auto");
				}
			} catch {
				// 실패 시 무시
			} finally {
				purposeDetectionInFlight = false;
			}
		})();
	});

	// ── Lifecycle ─────────────────────────────────────────────────

	const resetAndSync = (ctx: ExtensionContext) => {
		userMessageCount = 0;
		syncPurpose(ctx);
	};

	pi.on("session_start", async (_event, ctx) => {
		resetAndSync(ctx);
	});

	pi.on("session_switch", async (_event, ctx) => {
		resetAndSync(ctx);
	});

	pi.on("session_fork", async (_event, ctx) => {
		resetAndSync(ctx);
	});

	pi.on("session_tree", async (_event, ctx) => {
		resetAndSync(ctx);
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		if (!ctx.hasUI) return;
		ctx.ui.setStatus(PURPOSE_STATUS_KEY, undefined);
		ctx.ui.setWidget(WIDGET_KEY, undefined);
	});
}
