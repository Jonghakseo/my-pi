/**
 * Working text extension — shows rotating sayings + elapsed time
 * in the built-in spinner (⠋ 절차탁마 — 학문과 덕행을 부지런히 닦음 · 12초).
 */

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { ELAPSED_STATUS_KEY } from "./utils/status-keys.ts";
import { formatElapsedSince } from "./utils/time-utils.ts";

const FUNNY_MESSAGES = [
	// 국립국어원 표준국어대사전 뜻풀이를 바탕으로 축약
	"절차탁마 — 학문과 덕행을 부지런히 닦음",
	"격물치지 — 사물의 이치를 연구해 지식을 완전하게 함",
	"발본색원 — 근본 원인을 없애 다시 생기지 않게 함",
	"심사숙고 — 깊이 잘 생각함",
	"실사구시 — 사실에 토대를 두어 진리를 탐구함",
	"온고지신 — 옛것을 익혀 새것을 앎",
	"수기치인 — 자신을 닦은 뒤 남을 다스림",
	"반면교사 — 부정적인 면에서 얻는 깨달음",
	"괄목상대 — 학식이나 재주가 놀랄 만큼 늚",
	"유비무환 — 미리 준비하면 걱정이 없음",
	"형설지공 — 어려운 여건에서도 꾸준히 공부함",
	"화룡점정 — 가장 중요한 부분을 완성함",
	"청출어람 — 제자나 후배가 스승이나 선배보다 나음",
	"타산지석 — 남의 하찮은 말과 행동도 도움이 됨",
	"우공이산 — 끊임없이 노력하면 반드시 이루어짐",
	"권토중래 — 실패 뒤 힘을 회복해 다시 나아감",
	"금과옥조 — 귀중히 여겨 꼭 지켜야 할 법칙",
	"백가쟁명 — 여러 학설과 주장이 자유롭게 논쟁함",
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
