/**
 * Until Extension — 조건 충족까지 주기적으로 작업을 반복 실행
 *
 * 사용법:
 *   /until 5m PR 코멘트 새로 달린 거 있으면 알려줘
 *   /until 1h npm audit 돌려서 high 이상 취약점 0개 되면 알려줘
 *   /until 30분마다 스테이징 배포 완료됐는지 확인해
 *   /untils                    — 활성 목록
 *   /until-cancel <id|all>     — 취소
 *
 * LLM은 매 실행마다 until_report 도구를 호출하여 조건 충족 여부를 보고합니다.
 * done: true → 반복 종료, done: false → 다음 실행 대기
 */

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { formatClock, formatKoreanDuration } from "./utils/time-utils.ts";

// ─── Constants ───────────────────────────────────────────────────────────────

const CUSTOM_TYPE = "until";
const STATUS_KEY = "until-footer";

const MAX_TASKS = 3;
const MIN_INTERVAL_MS = 60_000; // 1분
const MAX_EXPIRY_MS = 24 * 60 * 60 * 1000; // 24시간
const JITTER_RATIO = 0.1; // ±10%

// ─── Interval Parsing ────────────────────────────────────────────────────────

/**
 * 다양한 형식의 interval 문자열을 파싱합니다.
 * 지원 형식: 5m, 1h, 5분, 1시간, 5분마다, 1시간마다
 *
 * @returns { ms, label } 또는 파싱 실패 시 null
 */

const INTERVAL_RE = /^(\d+(?:\.\d+)?)\s*(?:(m|h|분|시간)(?:마다)?)\s*$/i;

function parseInterval(raw: string): { ms: number; label: string } | null {
	const trimmed = raw.trim();
	if (!trimmed) return null;

	const match = trimmed.match(INTERVAL_RE);
	if (!match) return null;

	const amount = Number(match[1]);
	const unitRaw = match[2].toLowerCase();

	if (!Number.isFinite(amount) || amount <= 0) return null;

	let ms: number;
	let label: string;

	switch (unitRaw) {
		case "m":
		case "분":
			ms = amount * 60 * 1000;
			label = `${amount}분`;
			break;
		case "h":
		case "시간":
			ms = amount * 60 * 60 * 1000;
			label = `${amount}시간`;
			break;
		default:
			return null;
	}

	return { ms, label };
}

// ─── Types ───────────────────────────────────────────────────────────────────

interface UntilTask {
	id: number;
	prompt: string;
	intervalMs: number;
	intervalLabel: string;
	createdAt: number;
	expiresAt: number;
	nextRunAt: number;
	runCount: number;
	inFlight: boolean;
	lastSummary?: string;
	timer: ReturnType<typeof setTimeout>;
}

// ─── Extension ───────────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
	const tasks = new Map<number, UntilTask>();
	let nextTaskId = 1;
	let agentRunning = false;
	let latestCtx: ExtensionContext | undefined;

	// ── Helpers ────────────────────────────────────────────────────────────

	const clearAllTasks = () => {
		for (const task of tasks.values()) clearTimeout(task.timer);
		tasks.clear();
		updateFooter();
	};

	const removeTask = (id: number) => {
		const task = tasks.get(id);
		if (!task) return;
		clearTimeout(task.timer);
		tasks.delete(id);
		updateFooter();
	};

	const updateFooter = () => {
		if (!latestCtx?.hasUI) return;
		const theme = latestCtx.ui.theme;

		if (tasks.size === 0) {
			latestCtx.ui.setStatus(STATUS_KEY, undefined);
			return;
		}

		// 가장 가까운 다음 실행
		let nearestRun = Number.POSITIVE_INFINITY;
		for (const t of tasks.values()) {
			if (t.nextRunAt < nearestRun) nearestRun = t.nextRunAt;
		}

		const nextLabel = nearestRun < Number.POSITIVE_INFINITY ? formatClock(nearestRun) : "—";

		const text = theme.fg("accent", `⏳ until ×${tasks.size}`) + theme.fg("dim", ` | next ${nextLabel}`);

		latestCtx.ui.setStatus(STATUS_KEY, text);
	};

	const jitter = (ms: number): number => {
		const offset = ms * JITTER_RATIO * (Math.random() * 2 - 1);
		return Math.max(MIN_INTERVAL_MS, Math.round(ms + offset));
	};

	// ── Execute a single until run ────────────────────────────────────────

	const executeRun = (id: number) => {
		const task = tasks.get(id);
		if (!task) return;

		const now = Date.now();

		// 만료 체크 — inFlight 여부와 무관하게 항상 평가
		if (now >= task.expiresAt) {
			if (latestCtx?.hasUI) {
				latestCtx.ui.notify(`⏳ until #${task.id} 만료됨 (24시간 초과)`, "warning");
			}
			pi.sendMessage({
				customType: CUSTOM_TYPE,
				content: `[until #${task.id}] 24시간 만료로 자동 종료됨\n마지막 상태: ${task.lastSummary ?? "없음"}`,
				display: true,
			});
			removeTask(id);
			return;
		}

		// 이전 실행이 아직 진행 중이면 다음 타이머만 재설정
		if (task.inFlight) {
			scheduleNext(id);
			return;
		}

		task.runCount++;

		const elapsed = formatKoreanDuration(now - task.createdAt);
		const wrappedPrompt = [
			`[until #${task.id} — 실행 ${task.runCount}회차, 경과 ${elapsed}, 간격 ${task.intervalLabel}]`,
			"",
			task.prompt,
			"",
			"작업을 수행한 뒤, 반드시 until_report 도구를 호출하여 결과를 보고하세요.",
			`- taskId: ${task.id} (이 값을 그대로 전달)`,
			"- done: true (조건 충족, 반복 종료) 또는 done: false (미충족, 계속 반복)",
			"- summary: 현재 상태를 한 줄로 요약",
		].join("\n");

		if (latestCtx?.hasUI) {
			latestCtx.ui.notify(`⏳ until #${task.id} 실행 ${task.runCount}회차`, "info");
		}

		task.inFlight = true;

		try {
			if (agentRunning) {
				pi.sendUserMessage(wrappedPrompt, { deliverAs: "followUp" });
			} else {
				pi.sendUserMessage(wrappedPrompt);
			}
		} catch {
			// sendUserMessage 실패 시 inFlight 고착 방지
			task.inFlight = false;
		}

		scheduleNext(id);
	};

	const scheduleNext = (id: number) => {
		const task = tasks.get(id);
		if (!task) return;

		clearTimeout(task.timer);

		const delay = jitter(task.intervalMs);
		task.nextRunAt = Date.now() + delay;
		task.timer = setTimeout(() => executeRun(id), delay);
		updateFooter();
	};

	// ── Register until task ───────────────────────────────────────────────

	const registerTask = (intervalMs: number, intervalLabel: string, prompt: string, ctx: ExtensionContext): boolean => {
		if (tasks.size >= MAX_TASKS) {
			ctx.ui.notify(`최대 ${MAX_TASKS}개까지만 등록할 수 있어. /until-cancel로 정리해줘.`, "error");
			return false;
		}

		if (intervalMs < MIN_INTERVAL_MS) {
			ctx.ui.notify(`최소 간격은 1분이야. ${formatKoreanDuration(intervalMs)}은 너무 짧아.`, "error");
			return false;
		}

		const id = nextTaskId++;
		const now = Date.now();

		const task: UntilTask = {
			id,
			prompt,
			intervalMs,
			intervalLabel,
			createdAt: now,
			expiresAt: now + MAX_EXPIRY_MS,
			nextRunAt: now, // 즉시 실행
			runCount: 0,
			inFlight: false,
			timer: setTimeout(() => executeRun(id), 0), // 즉시 1회 실행
		};

		tasks.set(id, task);

		pi.sendMessage({
			customType: CUSTOM_TYPE,
			content: `[until #${id}] 등록됨: ${intervalLabel}마다 반복\n만료: ${formatClock(task.expiresAt)}\nTask: ${prompt}`,
			display: true,
			details: { id, prompt, intervalMs, intervalLabel },
		});

		if (ctx.hasUI) {
			ctx.ui.notify(`⏳ until #${id} 등록됨 (${intervalLabel}마다)`, "info");
		}

		updateFooter();
		return true;
	};

	// ── until_report tool ─────────────────────────────────────────────────

	pi.registerTool({
		name: "until_report",
		label: "Until Report",
		description: "until 반복 작업의 결과를 보고합니다. 조건 충족 시 done: true로 반복을 종료합니다.",
		promptSnippet: "Report until-loop result: done (condition met?) + summary",
		promptGuidelines: ["until 반복 작업 프롬프트를 받으면, 작업 수행 후 반드시 until_report를 호출하세요."],
		parameters: Type.Object({
			taskId: Type.Number({
				description: "until task ID (프롬프트의 #N)",
			}),
			done: Type.Boolean({
				description: "조건이 충족되었으면 true, 아니면 false",
			}),
			summary: Type.String({
				description: "현재 상태를 한 줄로 요약",
			}),
		}),

		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			const task = tasks.get(params.taskId);

			if (!task) {
				throw new Error(`until #${params.taskId} 작업을 찾을 수 없습니다. 이미 완료/취소/만료되었을 수 있습니다.`);
			}

			task.inFlight = false;
			task.lastSummary = params.summary;

			if (params.done) {
				// 조건 충족 → 종료
				const elapsed = formatKoreanDuration(Date.now() - task.createdAt);

				pi.sendMessage({
					customType: CUSTOM_TYPE,
					content: `[until #${task.id}] ✅ 조건 충족! (${task.runCount}회 실행, ${elapsed} 경과)\n결과: ${params.summary}`,
					display: true,
				});

				if (latestCtx?.hasUI) {
					latestCtx.ui.notify(`✅ until #${task.id} 완료: ${params.summary}`, "info");
				}

				removeTask(task.id);

				return {
					content: [
						{
							type: "text" as const,
							text: `until #${task.id} 조건 충족으로 종료됨. ${params.summary}`,
						},
					],
					details: {
						done: true,
						summary: params.summary,
						taskId: task.id,
						runCount: task.runCount,
					},
				};
			}

			return {
				content: [
					{
						type: "text" as const,
						text: `until #${task.id} 계속 반복. 다음 실행: ${formatClock(task.nextRunAt)}. ${params.summary}`,
					},
				],
				details: {
					done: false,
					summary: params.summary,
					taskId: task.id,
					nextRunAt: task.nextRunAt,
					runCount: task.runCount,
				},
			};
		},
	});

	// ── Commands ──────────────────────────────────────────────────────────

	pi.registerCommand("until", {
		description: "조건 충족까지 주기적 실행. 사용법: /until <간격> <프롬프트>  예: /until 5m PR 코멘트 확인해",
		handler: async (args, ctx) => {
			latestCtx = ctx;
			const raw = (args ?? "").trim();

			if (!raw) {
				ctx.ui.notify("사용법: /until <간격> <프롬프트>\n예: /until 5m PR 코멘트 확인해줘", "warning");
				return;
			}

			// 첫 토큰을 interval로 시도
			const spaceIdx = raw.indexOf(" ");
			if (spaceIdx === -1) {
				ctx.ui.notify("프롬프트가 필요해. 예: /until 5m PR 코멘트 확인해줘", "error");
				return;
			}

			const intervalToken = raw.slice(0, spaceIdx);
			const prompt = raw.slice(spaceIdx + 1).trim();

			const parsed = parseInterval(intervalToken);
			if (!parsed) {
				ctx.ui.notify(
					`인터벌 "${intervalToken}"을 파싱할 수 없어.\n지원 형식: 5m, 1h, 5분, 1시간, 5분마다, 1시간마다`,
					"error",
				);
				return;
			}

			if (!prompt) {
				ctx.ui.notify("프롬프트가 필요해. 예: /until 5m PR 코멘트 확인해줘", "error");
				return;
			}

			registerTask(parsed.ms, parsed.label, prompt, ctx);
		},
	});

	pi.registerCommand("untils", {
		description: "활성 until 목록 보기",
		handler: async (_args, ctx) => {
			latestCtx = ctx;

			if (tasks.size === 0) {
				ctx.ui.notify("활성 until 작업이 없어.", "info");
				return;
			}

			const now = Date.now();
			const lines = [...tasks.values()]
				.sort((a, b) => a.nextRunAt - b.nextRunAt)
				.map((t) => {
					const remain = formatKoreanDuration(Math.max(0, t.nextRunAt - now));
					const elapsed = formatKoreanDuration(now - t.createdAt);
					const summary = t.lastSummary ? `\n     최근: ${t.lastSummary}` : "";
					return `  #${t.id} · ${t.intervalLabel}마다 · 실행 ${t.runCount}회 · 경과 ${elapsed} · 다음 ${remain} 후${summary}\n     ${t.prompt}`;
				});

			pi.sendMessage({
				customType: CUSTOM_TYPE,
				content: `활성 until 목록 (${tasks.size}개)\n\n${lines.join("\n\n")}`,
				display: true,
			});
		},
	});

	pi.registerCommand("until-cancel", {
		description: "until 취소. 사용법: /until-cancel <id|all>",
		handler: async (args, ctx) => {
			latestCtx = ctx;
			const raw = (args ?? "").trim().toLowerCase();

			if (!raw) {
				ctx.ui.notify("사용법: /until-cancel <id|all>", "info");
				return;
			}

			if (raw === "all") {
				const count = tasks.size;
				clearAllTasks();
				ctx.ui.notify(`until ${count}개 취소됨`, "info");
				return;
			}

			const id = Number(raw);
			if (!Number.isInteger(id)) {
				ctx.ui.notify("id는 숫자여야 해. 예: /until-cancel 3", "warning");
				return;
			}

			const task = tasks.get(id);
			if (!task) {
				ctx.ui.notify(`until #${id} 없음`, "warning");
				return;
			}

			removeTask(id);
			ctx.ui.notify(`until #${id} 취소됨`, "info");
		},
	});

	// ── Events ────────────────────────────────────────────────────────────

	pi.on("agent_start", async (_event, ctx) => {
		agentRunning = true;
		latestCtx = ctx;
	});

	pi.on("agent_end", async (_event, ctx) => {
		agentRunning = false;
		latestCtx = ctx;
	});

	// context 이벤트: until 로그 메시지를 LLM 컨텍스트에서 제거
	pi.on("context", async (event, _ctx) => {
		const filtered = event.messages.filter(
			(m) => !(m.role === "custom" && (m as { customType?: string }).customType === CUSTOM_TYPE),
		);
		if (filtered.length === event.messages.length) return;
		return { messages: filtered };
	});

	pi.on("session_start", async (_event, ctx) => {
		agentRunning = false;
		latestCtx = ctx;
		clearAllTasks();
	});

	pi.on("session_switch", async (_event, ctx) => {
		agentRunning = false;
		latestCtx = ctx;
		clearAllTasks();
	});

	pi.on("session_shutdown", async () => {
		agentRunning = false;
		clearAllTasks();
	});
}
