/**
 * Working text extension — shows rotating productivity tips + elapsed time
 * in the built-in spinner (⠋ tips: /until 로 조건부 루프 로직을 실행할 수 있습니다 · 12초).
 */

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { ELAPSED_STATUS_KEY } from "./utils/status-keys.ts";
import { formatElapsedSince } from "./utils/time-utils.ts";

const TIP_MESSAGES = [
	"tips: /files 로 현재 작업 파일을 빠르게 탐색할 수 있습니다",
	"tips: /diff 로 변경 사항을 확인할 수 있습니다",
	"tips: /until 로 반복 점검 작업을 예약할 수 있습니다",
	"tips: /memory 로 저장된 메모리를 찾아볼 수 있습니다",
	"tips: /remember 로 자주 반복하는 요청을 저장할 수 있습니다",
	"tips: /github 로 현재 브랜치 PR 상태를 확인할 수 있습니다",
	"tips: /theme 로 테마를 바꿀 수 있습니다",
	"tips: /fork-panel 로 현재 세션을 새 패널로 분기할 수 있습니다",
] as const;

const ROTATE_MS = 8000;

function pick(messages: readonly string[]): string {
	return messages[Math.floor(Math.random() * messages.length)] ?? messages[0];
}

export default function (pi: ExtensionAPI) {
	let runStartedAt = 0;
	let currentMessage = "";
	let lastRotateAt = 0;
	let timer: ReturnType<typeof setInterval> | null = null;
	let latestCtx: ExtensionContext | undefined;

	const stopTimer = () => {
		if (!timer) return;
		clearInterval(timer);
		timer = null;
	};

	const startTimer = (_ctx: ExtensionContext) => {
		stopTimer();
		timer = setInterval(() => {
			if (!latestCtx?.hasUI || runStartedAt <= 0) return;
			const now = Date.now();
			if (now - lastRotateAt >= ROTATE_MS) {
				currentMessage = pick(TIP_MESSAGES);
				lastRotateAt = now;
			}
			latestCtx.ui.setWorkingMessage(`${currentMessage} · ${formatElapsedSince(runStartedAt)}`);
		}, 1000);
	};

	pi.on("agent_start", async (_event, ctx) => {
		latestCtx = ctx;
		if (ctx.hasUI) ctx.ui.setStatus(ELAPSED_STATUS_KEY, undefined);
		runStartedAt = Date.now();
		currentMessage = pick(TIP_MESSAGES);
		lastRotateAt = Date.now();
		startTimer(ctx);
	});

	pi.on("agent_end", async (_event, ctx) => {
		stopTimer();
		if (ctx.hasUI) {
			ctx.ui.setWorkingMessage();
			if (runStartedAt > 0) {
				const elapsed = formatElapsedSince(runStartedAt);
				ctx.ui.setStatus(ELAPSED_STATUS_KEY, `✓ ${elapsed}`);
			}
		}
		runStartedAt = 0;
	});

	pi.on("session_start", async (_event) => {
		stopTimer();
		runStartedAt = 0;
	});

	pi.on("session_shutdown", async (_event) => {
		stopTimer();
	});
}
