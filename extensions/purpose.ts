import { spawn } from "node:child_process";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { PURPOSE_STATUS_KEY } from "./utils/status-keys.ts";

const PURPOSE_ENTRY_TYPE = "purpose:set";
const PURPOSE_COMMAND_NAME = "purpose";
const PURPOSE_RESET_COMMAND_NAME = "purpose:reset";
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

async function detectPurposeFromMessage(userMessage: string): Promise<string> {
	return new Promise((resolve) => {
		const systemPrompt =
			"사용자 메시지를 분석해서 세션의 목적을 20자 이내 한 줄로 추출해. 오직 목적 텍스트만 출력하고, 설명이나 다른 텍스트는 절대 출력하지 마.";

		const args = [
			"--no-extensions",
			"--no-skills",
			"--no-prompt-templates",
			"--no-session",
			"--system-prompt",
			systemPrompt,
			"-p",
			`사용자 메시지: ${userMessage.slice(0, 500)}`,
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

	const clearPurpose = (ctx: ExtensionContext) => {
		persistPurpose(ctx, "", "command");
		notify(ctx, "세션 목적을 비웠습니다.", "warning");
	};

	pi.registerCommand(PURPOSE_COMMAND_NAME, {
		description: "Set or view session purpose. Usage: /purpose <text> | /purpose clear | /purpose:reset",
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
				clearPurpose(ctx);
				return;
			}

			const normalized = persistPurpose(ctx, raw, "command");
			notify(ctx, `세션 목적 설정 완료: ${normalized}`, "info");
		},
	});

	pi.registerCommand(PURPOSE_RESET_COMMAND_NAME, {
		description: "Clear the current session purpose.",
		handler: async (_args, ctx) => {
			clearPurpose(ctx);
		},
	});

	// ── Auto Purpose (async) ──────────────────────────────────────

	pi.on("before_agent_start", async (event, ctx) => {
		// Do not auto-generate purpose in subagent sessions
		if (isSubagentSession(ctx)) return;

		// purpose가 이미 있으면 스킵
		if (hasPurpose()) return;

		const text = event.prompt.trim();
		if (!text) return;

		// Fire-and-forget: 비동기로 purpose 감지 후 설정
		(async () => {
			try {
				const detected = await detectPurposeFromMessage(text);
				if (detected) {
					persistPurpose(ctx, detected, "auto");
				}
			} catch {
				// 실패 시 무시
			}
		})();
	});

	// ── Lifecycle ─────────────────────────────────────────────────

	pi.on("session_start", async (_event, ctx) => {
		syncPurpose(ctx);
	});

	pi.on("session_switch", async (_event, ctx) => {
		syncPurpose(ctx);
	});

	pi.on("session_fork", async (_event, ctx) => {
		syncPurpose(ctx);
	});

	pi.on("session_tree", async (_event, ctx) => {
		syncPurpose(ctx);
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		if (!ctx.hasUI) return;
		ctx.ui.setStatus(PURPOSE_STATUS_KEY, undefined);
		ctx.ui.setWidget(WIDGET_KEY, undefined);
	});
}
