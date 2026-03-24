/**
 * Auto session name — detects purpose from first user message
 * and sets it as the session name via pi.setSessionName().
 *
 * - Auto-detect: spawns a headless pi to summarize first message → pi.setSessionName()
 * - Footer display: shows session name in status bar via setStatus()
 * - Manual control: use built-in /name command (no custom command needed)
 * - Skips auto-detection for subagent sessions
 */

import { spawn } from "node:child_process";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { NAME_STATUS_KEY } from "./utils/status-keys.ts";

// Subagent session directory — must match subagent/session.ts:SUBAGENT_SESSION_DIR
const SUBAGENT_SESSION_DIR = path.join(os.homedir(), ".pi", "agent", "sessions", "subagents");

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

function formatNameStatus(name: string): string {
	const singleLine = name.replace(/\s+/g, " ").trim();
	const maxChars = 90;
	return singleLine.length > maxChars ? `${singleLine.slice(0, maxChars - 1)}…` : singleLine;
}

async function detectNameFromMessage(userMessage: string): Promise<string> {
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

export default function autoSessionName(pi: ExtensionAPI) {
	const updateStatus = (ctx: ExtensionContext) => {
		if (!ctx.hasUI) return;

		const name = pi.getSessionName();
		if (!name) {
			ctx.ui.setStatus(NAME_STATUS_KEY, undefined);
			return;
		}

		ctx.ui.setStatus(NAME_STATUS_KEY, formatNameStatus(name));
	};

	// ── Auto Name (async) ──────────────────────────────────────

	pi.on("before_agent_start", async (event, ctx) => {
		if (isSubagentSession(ctx)) return;

		// name이 이미 있으면 스킵
		if (pi.getSessionName()) return;

		const text = event.prompt.trim();
		if (!text) return;

		// Fire-and-forget: 비동기로 name 감지 후 설정
		(async () => {
			try {
				const detected = await detectNameFromMessage(text);
				if (detected) {
					pi.setSessionName(detected);
					updateStatus(ctx);
				}
			} catch {
				// 실패 시 무시
			}
		})();
	});

	// ── Lifecycle ─────────────────────────────────────────────────

	pi.on("session_start", async (_event, ctx) => {
		updateStatus(ctx);
	});

	pi.on("session_switch", async (_event, ctx) => {
		updateStatus(ctx);
	});

	pi.on("session_fork", async (_event, ctx) => {
		updateStatus(ctx);
	});

	pi.on("session_tree", async (_event, ctx) => {
		updateStatus(ctx);
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		if (!ctx.hasUI) return;
		ctx.ui.setStatus(NAME_STATUS_KEY, undefined);
	});
}
