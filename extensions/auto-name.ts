/**
 * Auto session name — detects purpose from first user message
 * and sets it as the session name via pi.setSessionName().
 *
 * - Auto-detect: uses pi-ai completeSimple() to summarize first message → pi.setSessionName()
 * - Footer display: shows session name in status bar via setStatus()
 * - Manual control: use built-in /name command (no custom command needed)
 * - Skips auto-detection for subagent sessions
 */

import * as path from "node:path";
import { completeSimple } from "@mariozechner/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import {
	buildNameContext,
	extractNameFromResult,
	extractSessionFilePath,
	formatNameStatus,
	isSubagentSessionPath,
	isSuccessfulResult,
	NAME_SYSTEM_PROMPT,
} from "./utils/auto-name-utils.ts";
import { NAME_STATUS_KEY } from "./utils/status-keys.ts";

// ── Helpers ──────────────────────────────────────────────────────────────────

function isSubagentSession(ctx: ExtensionContext): boolean {
	const sessionFilePath = extractSessionFilePath(ctx.sessionManager);
	return isSubagentSessionPath(sessionFilePath);
}

async function detectNameFromMessage(userMessage: string, ctx: ExtensionContext): Promise<string> {
	const model = ctx.model;
	if (!model) return "";

	const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
	if (!auth.ok) return "";

	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), 10000);

	try {
		const result = await completeSimple(
			model,
			{
				systemPrompt: NAME_SYSTEM_PROMPT,
				messages: [
					{
						role: "user",
						content: [{ type: "text", text: buildNameContext(userMessage) }],
						timestamp: Date.now(),
					},
				],
			},
			{ apiKey: auth.apiKey, headers: auth.headers, signal: controller.signal, reasoning: "minimal", maxTokens: 60 },
		);

		if (!isSuccessfulResult(result.stopReason)) return "";
		return extractNameFromResult(result.content);
	} catch {
		return "";
	} finally {
		clearTimeout(timer);
	}
}

// ── Extension ────────────────────────────────────────────────────────────────

export default function autoSessionName(pi: ExtensionAPI) {
	const updateTerminalTitle = (ctx: ExtensionContext) => {
		if (!ctx.hasUI) return;
		const cwdBasename = path.basename(process.cwd());
		const name = pi.getSessionName();
		if (name) {
			ctx.ui.setTitle(`π - ${name} - ${cwdBasename}`);
		} else {
			ctx.ui.setTitle(`π - ${cwdBasename}`);
		}
	};

	const updateStatus = (ctx: ExtensionContext) => {
		if (!ctx.hasUI) return;

		const name = pi.getSessionName();
		if (!name) {
			ctx.ui.setStatus(NAME_STATUS_KEY, undefined);
			return;
		}

		ctx.ui.setStatus(NAME_STATUS_KEY, formatNameStatus(name));
		updateTerminalTitle(ctx);
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
				const detected = await detectNameFromMessage(text, ctx);
				if (detected && !pi.getSessionName()) {
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

	pi.on("session_tree", async (_event, ctx) => {
		updateStatus(ctx);
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		if (!ctx.hasUI) return;
		ctx.ui.setStatus(NAME_STATUS_KEY, undefined);
	});
}
