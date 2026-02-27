import { Type } from "@mariozechner/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";
import { isAgentsModeEnabled } from "./system-mode/state.ts";
import { formatElapsedSince } from "./utils/time-utils.ts";

const WIDGET_KEY = "progress-widget-enforcer";
const MAX_PROGRESS_LEN = 140;
const DEFAULT_PROGRESS = "요청 해석 중...";
const ALLOWED_TOOLS_BEFORE_INITIAL_PROGRESS = new Set<string>(["set_session_purpose"]);

const FUNNY_PROGRESS_MESSAGES = {
	byTool: {
		read: ["파일 속마음 청취 중...", "코드 유적 발굴 중...", "텍스트 확대 관찰 중..."],
		write: ["새 파일에 영혼 주입 중...", "빈 페이지와 협상 중...", "코드 탄생 의식 진행 중..."],
		edit: ["정밀 코드 수술 집도 중...", "부작용 최소화 패치 중...", "한 줄 한 줄 성형 중..."],
		bash: ["터미널과 외교 협상 중...", "셸에게 주문 읊는 중...", "CLI 몬스터 소환 중..."],
		grep: ["문자열 잠복근무 중...", "패턴 수배 전단 배포 중...", "정규식 레이더 가동 중..."],
		find: ["파일 숨바꼭질 수색 중...", "디렉터리 미로 탐험 중...", "길 잃은 파일 구조 중..."],
		ls: ["폴더 출석 체크 중...", "디렉터리 인원 점검 중...", "파일 명단 열람 중..."],
	},
	fallback: ["버그와 1:1 면담 중...", "논리 퍼즐 조립 중...", "코드 우주 정찰 중..."],
	pending: ["작전 회의 중..."],
} as const;

const INITIAL_LOADING_MESSAGES = [
	...FUNNY_PROGRESS_MESSAGES.pending,
	...Object.values(FUNNY_PROGRESS_MESSAGES.byTool).flat(),
	...FUNNY_PROGRESS_MESSAGES.fallback,
] as const;

type ProgressPhase = "pending" | "running" | "done";

function pickRandomMessage(messages: readonly string[]): string {
	if (messages.length === 0) return DEFAULT_PROGRESS;
	const idx = Math.floor(Math.random() * messages.length);
	return messages[idx] ?? DEFAULT_PROGRESS;
}

function normalizeProgress(input: string | undefined): string {
	if (!input) return DEFAULT_PROGRESS;
	const oneLine = input.replace(/\s+/g, " ").trim();
	if (!oneLine) return DEFAULT_PROGRESS;
	return oneLine.length > MAX_PROGRESS_LEN ? `${oneLine.slice(0, MAX_PROGRESS_LEN - 1)}…` : oneLine;
}

function getPhaseMeta(phase: ProgressPhase): { icon: string; label: string; color: "warning" | "accent" | "success" } {
	if (phase === "pending") return { icon: "⏳", label: "WAITING", color: "warning" };
	if (phase === "done") return { icon: "✅", label: "DONE", color: "success" };
	return { icon: "🚀", label: "RUNNING", color: "accent" };
}

function buildProgressCard(
	progress: string,
	phase: ProgressPhase,
	elapsedLabel: string,
	hideDoneProgress: boolean,
	agentsModeEnabled: boolean,
) {
	return (_tui: unknown, theme: any) => ({
		render(width: number): string[] {
			const meta = getPhaseMeta(phase);
			const displayProgress =
				phase === "done" ? (hideDoneProgress || !progress.trim() ? "응답 완료" : `(완료) ${progress}`) : progress;

			const statusText = displayProgress;

			if (width < 20) {
				const compactPrefix = agentsModeEnabled ? "🤖 " : "";
				const compactText = statusText
					? `${compactPrefix}${meta.icon} ${statusText} • ${elapsedLabel}`
					: `${compactPrefix}${meta.icon} • ${elapsedLabel}`;
				return [truncateToWidth(compactText, width)];
			}

			const fg = (color: string, text: string) => theme.fg(color as any, text);
			const border = (s: string) => fg(meta.color, s);
			const sideMargin = width >= 120 ? 6 : 4;
			const innerWidth = Math.max(24, Math.min(140, width - sideMargin));

			const row = (content: string) => {
				const clipped = truncateToWidth(content, innerWidth);
				const pad = " ".repeat(Math.max(0, innerWidth - visibleWidth(clipped)));
				return `${border("│")}${clipped}${pad}${border("│")}`;
			};

			const statusMain = statusText ? `${meta.icon} ${statusText}` : `${meta.icon}`;
			const statusLine = `${fg(meta.color, statusMain)} ${fg("dim", `• ${elapsedLabel}`)}`;

			let topBorder: string;
			if (agentsModeEnabled) {
				const badgeText = " 🤖 AGENT MODE ";
				const badgeVisWidth = visibleWidth(badgeText);
				const dashTotal = innerWidth - badgeVisWidth;
				const dashLeft = Math.max(1, Math.floor(dashTotal / 2));
				const dashRight = Math.max(1, dashTotal - dashLeft);
				topBorder = border(`╭${"─".repeat(dashLeft)}`) + fg("warning", badgeText) + border(`${"─".repeat(dashRight)}╮`);
			} else {
				topBorder = border(`╭${"─".repeat(innerWidth)}╮`);
			}

			const lines = [topBorder, row(statusLine)];

			lines.push(border(`╰${"─".repeat(innerWidth)}╯`));
			return lines.map((line) => truncateToWidth(line, width));
		},
		invalidate() {},
	});
}

export default function (pi: ExtensionAPI) {
	let runStartedAt = 0;
	let currentProgress = DEFAULT_PROGRESS;
	let isDefaultProgress = true;
	let requireInitialProgress = false;
	let phase: ProgressPhase = "pending";
	let doneElapsedLabel: string | null = null;
	let timer: ReturnType<typeof setInterval> | null = null;
	let latestCtx: ExtensionContext | undefined;

	const renderWidget = (ctx: ExtensionContext) => {
		if (!ctx.hasUI) return;
		if (phase !== "done" && runStartedAt <= 0) return;

		const elapsedLabel = phase === "done" ? (doneElapsedLabel ?? "0초") : formatElapsedSince(runStartedAt);
		const hideDoneProgress = phase === "done" && isDefaultProgress;
		ctx.ui.setWidget(
			WIDGET_KEY,
			buildProgressCard(currentProgress, phase, elapsedLabel, hideDoneProgress, isAgentsModeEnabled()),
			{
				placement: "aboveEditor",
			},
		);
	};

	const stopTimer = () => {
		if (!timer) return;
		clearInterval(timer);
		timer = null;
	};

	const startTimer = (ctx: ExtensionContext) => {
		stopTimer();
		timer = setInterval(() => {
			if (!latestCtx) return;
			renderWidget(latestCtx);
		}, 1000);
		renderWidget(ctx);
	};

	pi.registerTool({
		name: "set_progress",
		label: "Set Progress",
		description:
			"Update one-line progress text shown in a persistent widget. Call this as the FIRST tool call of each agent run. Keep it under 50 characters.",
		parameters: Type.Object({
			progress: Type.String({ description: "One-line progress summary of what you are doing now (max 50 chars)" }),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const nextProgress = normalizeProgress((params as { progress?: string }).progress);
			currentProgress = nextProgress;
			isDefaultProgress = nextProgress === DEFAULT_PROGRESS;
			requireInitialProgress = false;
			phase = "running";
			latestCtx = ctx;
			renderWidget(ctx);

			return {
				content: [{ type: "text", text: `Progress updated: ${nextProgress}` }],
				details: { progress: nextProgress },
			};
		},
	});

	pi.on("before_agent_start", async (event) => {
		return {
			systemPrompt:
				event.systemPrompt +
				`\n\n[Progress Protocol]\n- At the start of EVERY agent run, call tool \`set_progress\` BEFORE any other tool call.\n- The progress text must be one concise line describing your immediate next action.\n- If your plan changes meaningfully, call \`set_progress\` again to refresh it.\n- Keep progress practical and specific.`,
		};
	});

	pi.on("agent_start", async (_event, ctx) => {
		latestCtx = ctx;
		runStartedAt = Date.now();
		doneElapsedLabel = null;
		currentProgress = pickRandomMessage(INITIAL_LOADING_MESSAGES);
		isDefaultProgress = true;
		phase = "pending";
		requireInitialProgress = true;
		startTimer(ctx);
	});

	pi.on("tool_call", async (event) => {
		if (!requireInitialProgress) return undefined;
		if (event.toolName === "set_progress") {
			requireInitialProgress = false;
			return undefined;
		}
		if (ALLOWED_TOOLS_BEFORE_INITIAL_PROGRESS.has(event.toolName)) {
			return undefined;
		}

		return {
			block: true,
			reason: "Progress protocol: 먼저 set_progress 도구를 호출해 현재 진행 상황 한 줄을 설정하세요.",
		};
	});

	pi.on("agent_end", async (_event, ctx) => {
		requireInitialProgress = false;
		phase = "done";
		doneElapsedLabel = runStartedAt > 0 ? formatElapsedSince(runStartedAt) : "0초";
		renderWidget(ctx);
		stopTimer();
		runStartedAt = 0;
	});

	pi.on("session_start", async (_event, ctx) => {
		stopTimer();
		runStartedAt = 0;
		doneElapsedLabel = null;
		requireInitialProgress = false;
		phase = "pending";
		currentProgress = DEFAULT_PROGRESS;
		isDefaultProgress = true;
		if (ctx.hasUI) {
			ctx.ui.setWidget(WIDGET_KEY, undefined);
		}
	});

	pi.on("session_switch", async (_event, ctx) => {
		stopTimer();
		runStartedAt = 0;
		doneElapsedLabel = null;
		requireInitialProgress = false;
		phase = "pending";
		currentProgress = DEFAULT_PROGRESS;
		isDefaultProgress = true;
		if (ctx.hasUI) {
			ctx.ui.setWidget(WIDGET_KEY, undefined);
		}
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		stopTimer();
		if (ctx.hasUI) {
			ctx.ui.setWidget(WIDGET_KEY, undefined);
		}
	});
}
