/**
 * Working text extension — shows rotating productivity tips + elapsed time
 * in the built-in spinner (⠋ tips: /until 로 조건부 루프 로직을 실행할 수 있습니다 · 12초).
 */

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { ELAPSED_STATUS_KEY } from "./utils/status-keys.ts";
import { formatElapsedSince } from "./utils/time-utils.ts";

const TIP_MESSAGES = [
	"tips: /until 로 조건부 루프 로직을 실행할 수 있습니다",
	"tips: todo_write 로 진행 상황을 즉시 기록할 수 있습니다",
	"tips: /files 로 현재 작업 트리 파일을 빠르게 탐색할 수 있습니다",
	"tips: /diff 로 변경 사항을 분할 화면에서 확인할 수 있습니다",
	"tips: /replay 로 이전 세션 흐름을 다시 볼 수 있습니다",
	"tips: recall 로 저장된 규칙과 메모리를 다시 불러올 수 있습니다",
	"tips: remember 로 반복 요청을 장기 기억에 저장할 수 있습니다",
	"tips: AskUserQuestion 으로 선택지형 질문을 보낼 수 있습니다",
	"tips: show_widget 으로 차트·표·위젯을 바로 띄울 수 있습니다",
	"tips: subagent batch 로 여러 에이전트를 병렬 실행할 수 있습니다",
	"tips: subagent chain 으로 구현→리뷰 흐름을 순차 실행할 수 있습니다",
	"tips: /context 로 현재 세션의 컨텍스트 사용량을 확인할 수 있습니다",
	"tips: /fork-panel 로 현재 세션을 새 패널로 분기할 수 있습니다",
	"tips: clipboard 도구로 답변을 바로 클립보드에 복사할 수 있습니다",
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

	pi.on("session_switch", async (_event) => {
		stopTimer();
		runStartedAt = 0;
	});

	pi.on("session_shutdown", async (_event) => {
		stopTimer();
	});
}
