/**
 * Working text extension — shows funny rotating messages + elapsed time
 * in the built-in spinner (⠋ 코드 우주 정찰 중... · 12초).
 */

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { ELAPSED_STATUS_KEY } from "./utils/status-keys.ts";
import { formatElapsedSince } from "./utils/time-utils.ts";

const FUNNY_MESSAGES = [
	// pending
	"작전 회의 중...",
	// byTool
	"파일 속마음 청취 중...",
	"코드 유적 발굴 중...",
	"텍스트 확대 관찰 중...",
	"새 파일에 영혼 주입 중...",
	"빈 페이지와 협상 중...",
	"코드 탄생 의식 진행 중...",
	"정밀 코드 수술 집도 중...",
	"부작용 최소화 패치 중...",
	"한 줄 한 줄 성형 중...",
	"터미널과 외교 협상 중...",
	"셸에게 주문 읊는 중...",
	"CLI 몬스터 소환 중...",
	"문자열 잠복근무 중...",
	"패턴 수배 전단 배포 중...",
	"정규식 레이더 가동 중...",
	"파일 숨바꼭질 수색 중...",
	"디렉터리 미로 탐험 중...",
	"길 잃은 파일 구조 중...",
	"폴더 출석 체크 중...",
	"디렉터리 인원 점검 중...",
	"파일 명단 열람 중...",
	// fallback
	"버그와 1:1 면담 중...",
	"논리 퍼즐 조립 중...",
	"코드 우주 정찰 중...",
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

	const startTimer = (ctx: ExtensionContext) => {
		stopTimer();
		timer = setInterval(() => {
			if (!latestCtx?.hasUI || runStartedAt <= 0) return;
			const now = Date.now();
			if (now - lastRotateAt >= ROTATE_MS) {
				currentMessage = pick(FUNNY_MESSAGES);
				lastRotateAt = now;
			}
			latestCtx.ui.setWorkingMessage(`${currentMessage} · ${formatElapsedSince(runStartedAt)}`);
		}, 1000);
	};

	pi.on("agent_start", async (_event, ctx) => {
		latestCtx = ctx;
		if (ctx.hasUI) ctx.ui.setStatus(ELAPSED_STATUS_KEY, undefined);
		runStartedAt = Date.now();
		currentMessage = pick(FUNNY_MESSAGES);
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
