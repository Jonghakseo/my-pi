/**
 * Notify Extension — agent 작업 종료 시 터미널 네이티브 알림 + macOS TTS
 *
 * 사용법:
 *   /notify       — 현재 세션에서 알림 켬
 *   /notify-off   — 현재 세션에서 알림 끔
 *
 * - 기본 상태는 OFF. 세션마다 명시적으로 켜야 동작.
 * - 토글 상태는 세션 ID별로 ~/.pi/agent/state/notify-sessions.json 에 저장됨.
 * - resume 시 이전 토글 상태 복원.
 * - macOS에서는 say -v Sandy 로 본문 요약을 음성으로 읽어줌.
 *   (PI_NOTIFY_VOICE 환경변수로 보이스 변경 가능)
 */

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { buildCompletionNotification, extractAssistantText, type NotificationMessage } from "./format.ts";
import { notify } from "./notify.ts";
import { isNotifyEnabled, setNotifyEnabled } from "./state.ts";
import { resolveKoreanNotificationSummary } from "./summarize.ts";
import { hasKoreanText, sanitizeNotificationText, stripLeadingTitle } from "./text.ts";
import { speak, stopSpeaking } from "./tts.ts";

const STATUS_KEY = "notify-toggle";

function readSessionId(ctx: ExtensionContext): string {
	try {
		return ctx.sessionManager.getSessionId() || "";
	} catch {
		return "";
	}
}

function readSessionTitle(ctx: ExtensionContext): string {
	try {
		return sanitizeNotificationText(ctx.sessionManager.getSessionName() || "");
	} catch {
		return "";
	}
}

export default function (pi: ExtensionAPI) {
	let latestCtx: ExtensionContext | undefined;

	const refreshFooter = () => {
		if (!latestCtx?.hasUI) return;
		const sessionId = readSessionId(latestCtx);
		if (sessionId && isNotifyEnabled(sessionId)) {
			latestCtx.ui.setStatus(STATUS_KEY, latestCtx.ui.theme.fg("accent", "🔔 notify"));
		} else {
			latestCtx.ui.setStatus(STATUS_KEY, undefined);
		}
	};

	pi.registerCommand("notify", {
		description: "현재 세션에서 작업 완료 알림 + TTS 켜기",
		handler: async (_args, ctx) => {
			latestCtx = ctx;
			const sessionId = readSessionId(ctx);
			if (!sessionId) {
				ctx.ui.notify("세션 ID를 확인할 수 없어 알림을 켤 수 없어.", "error");
				return;
			}

			if (isNotifyEnabled(sessionId)) {
				ctx.ui.notify("이미 알림이 켜져 있어.", "info");
				return;
			}

			setNotifyEnabled(sessionId, true);
			refreshFooter();
			ctx.ui.notify("🔔 이 세션에서 작업 완료 알림 + TTS를 켰어.", "info");
		},
	});

	pi.registerCommand("notify-off", {
		description: "현재 세션에서 작업 완료 알림 + TTS 끄기",
		handler: async (_args, ctx) => {
			latestCtx = ctx;
			const sessionId = readSessionId(ctx);
			if (!sessionId) {
				ctx.ui.notify("세션 ID를 확인할 수 없어.", "error");
				return;
			}

			if (!isNotifyEnabled(sessionId)) {
				ctx.ui.notify("이미 알림이 꺼져 있어.", "info");
				return;
			}

			setNotifyEnabled(sessionId, false);
			stopSpeaking();
			refreshFooter();
			ctx.ui.notify("🔕 이 세션에서 작업 완료 알림 + TTS를 껐어.", "info");
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		latestCtx = ctx;
		refreshFooter();
	});

	pi.on("agent_end", async (event, ctx) => {
		latestCtx = ctx;
		const sessionId = readSessionId(ctx);
		if (!sessionId || !isNotifyEnabled(sessionId)) return;

		const messages = event.messages as NotificationMessage[];
		const sessionTitle = readSessionTitle(ctx);
		const fallback = buildCompletionNotification(sessionTitle, messages);

		const koreanBody = await resolveKoreanNotificationSummary(
			extractAssistantText(messages),
			sessionTitle,
			ctx.model,
			ctx.modelRegistry,
		);
		const stripped = stripLeadingTitle(koreanBody || "", fallback.title);
		const body = stripped && hasKoreanText(stripped) ? stripped : fallback.body;

		notify(fallback.title, body);
		if (body) speak(body);
	});

	pi.on("session_shutdown", async () => {
		stopSpeaking();
	});
}
