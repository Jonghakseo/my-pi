import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { formatKoreanDuration } from "../utils/time-utils.ts";
import { parseDelayArgs, parseDurationMs } from "./parse.ts";

const STATUS_KEY = "delay";

interface DelayTask {
	id: string;
	prompt: string;
	createdAt: number;
	dueAt: number;
	timer: ReturnType<typeof setTimeout>;
	ctx: ExtensionContext;
}

const DelayParamsSchema = Type.Object({
	delay: Type.String({ description: "Delay duration such as 30s, 5m, 1h, 1h30m, 2시간." }),
	prompt: Type.String({ description: "Prompt text to insert into the editor after the delay." }),
	id: Type.Optional(Type.String({ description: "Optional task id. Auto-generated when omitted." })),
});

interface DelayToolParams {
	delay: string;
	prompt: string;
	id?: string;
}

const tasks = new Map<string, DelayTask>();
let nextId = 1;
let latestCtx: ExtensionContext | undefined;
let statusInterval: ReturnType<typeof setInterval> | undefined;

function allocateId(requested?: string): string {
	const base = requested?.trim() || `delay-${nextId++}`;
	if (!/^[a-zA-Z0-9._-]+$/.test(base)) throw new Error(`Invalid delay id: ${base}`);
	if (!tasks.has(base)) return base;
	if (requested) throw new Error(`Delay id already exists: ${base}`);
	return allocateId(`delay-${nextId++}`);
}

function preview(text: string, max = 80): string {
	const oneLine = text.replace(/\s+/g, " ").trim();
	return oneLine.length > max ? `${oneLine.slice(0, max - 1)}…` : oneLine;
}

function formatTask(task: DelayTask, now = Date.now()): string {
	const remaining = Math.max(0, task.dueAt - now);
	const dueTime = new Date(task.dueAt).toLocaleTimeString("ko-KR", {
		hour: "2-digit",
		minute: "2-digit",
		second: "2-digit",
		hour12: false,
	});
	return `${task.id} · ${formatKoreanDuration(remaining)} 후 (${dueTime}) · ${preview(task.prompt)}`;
}

function listTasks(): string {
	if (tasks.size === 0) return "예약된 delay가 없어요.";
	const now = Date.now();
	return [
		"예약된 delay:",
		...[...tasks.values()].sort((a, b) => a.dueAt - b.dueAt).map((task) => `- ${formatTask(task, now)}`),
	].join("\n");
}

function refreshStatus(): void {
	const ctx = latestCtx;
	if (!ctx?.hasUI) return;
	if (tasks.size === 0) {
		ctx.ui.setStatus(STATUS_KEY, undefined);
		return;
	}
	const next = [...tasks.values()].sort((a, b) => a.dueAt - b.dueAt)[0];
	ctx.ui.setStatus(
		STATUS_KEY,
		ctx.ui.theme.fg("accent", `⏰ ${tasks.size} · ${formatKoreanDuration(next.dueAt - Date.now())}`),
	);
}

function ensureStatusTicker(): void {
	if (statusInterval) return;
	statusInterval = setInterval(refreshStatus, 1000);
}

function stopStatusTickerIfIdle(): void {
	if (tasks.size > 0 || !statusInterval) return;
	clearInterval(statusInterval);
	statusInterval = undefined;
}

function injectPrompt(task: DelayTask): void {
	try {
		if (!task.ctx.hasUI) return;
		const current = task.ctx.ui.getEditorText();
		const nextText = current.trim().length > 0 ? `${current.trimEnd()}\n\n${task.prompt}` : task.prompt;
		task.ctx.ui.setEditorText(nextText);
		task.ctx.ui.notify(`⏰ ${task.id} 시간이 되어 프롬프트를 입력했어요.`, "info");
	} finally {
		tasks.delete(task.id);
		refreshStatus();
		stopStatusTickerIfIdle();
	}
}

function scheduleDelay(ctx: ExtensionContext, delayMs: number, prompt: string, requestedId?: string): DelayTask {
	if (!ctx.hasUI) throw new Error("delay requires an interactive UI so it can insert text into the editor.");
	latestCtx = ctx;
	const id = allocateId(requestedId);
	const createdAt = Date.now();
	const task: DelayTask = {
		id,
		prompt,
		createdAt,
		dueAt: createdAt + delayMs,
		timer: setTimeout(() => injectPrompt(task), delayMs),
		ctx,
	};
	tasks.set(id, task);
	ensureStatusTicker();
	refreshStatus();
	return task;
}

function cancelTask(id: string): boolean {
	const task = tasks.get(id);
	if (!task) return false;
	clearTimeout(task.timer);
	tasks.delete(id);
	refreshStatus();
	stopStatusTickerIfIdle();
	return true;
}

function cancelAll(): number {
	const count = tasks.size;
	for (const task of tasks.values()) clearTimeout(task.timer);
	tasks.clear();
	refreshStatus();
	stopStatusTickerIfIdle();
	return count;
}

function helpText(): string {
	return [
		"Usage:",
		"  /delay <duration> <prompt>     지연 후 프롬프트를 현재 입력창에 넣기",
		"  /delay list                    예약 목록 보기",
		"  /delay cancel [id|all]         예약 취소 (id 생략 시 전체 취소)",
		"",
		"Examples:",
		"  /delay 5m 상태 확인해줘",
		"  /delay 1h30m 회의록 정리 시작",
		"  /delay 2시간 배포 결과 확인",
		"",
		"Duration units: ms, s, m, h, d, 초, 분, 시간, 일",
	].join("\n");
}

function scheduleFromCommand(args: string, ctx: ExtensionContext): string {
	const parsed = parseDelayArgs(args);
	if ("error" in parsed) return parsed.error;
	const task = scheduleDelay(ctx, parsed.delayMs, parsed.prompt);
	return `✓ ${task.id} 예약됨: ${formatKoreanDuration(parsed.delayMs)} 후 입력 · ${preview(task.prompt)}`;
}

async function handleDelayCommand(args: string, ctx: ExtensionContext): Promise<string> {
	const trimmed = args.trim();
	if (!trimmed || trimmed === "help" || trimmed === "--help" || trimmed === "-h") return helpText();
	if (trimmed === "list" || trimmed === "ls" || trimmed === "status") return listTasks();

	const [command, target] = trimmed.split(/\s+/, 2);
	if (command === "cancel" || command === "rm" || command === "remove") {
		if (!target || target === "all") return `✓ ${cancelAll()}개의 delay를 취소했어요.`;
		return cancelTask(target) ? `✓ ${target} 예약을 취소했어요.` : `예약을 찾을 수 없어요: ${target}`;
	}

	return scheduleFromCommand(trimmed, ctx);
}

function clearAllTimers(): void {
	for (const task of tasks.values()) clearTimeout(task.timer);
	tasks.clear();
	if (statusInterval) clearInterval(statusInterval);
	statusInterval = undefined;
}

export default function (pi: ExtensionAPI) {
	pi.registerCommand("delay", {
		description: "지정한 시간 후 프롬프트를 현재 입력창에 넣기: /delay 5m <프롬프트>",
		getArgumentCompletions: (prefix) => {
			const trimmed = prefix.trimStart();
			if (!trimmed.includes(" ")) {
				return ["list", "cancel", "5m", "30s", "1h"]
					.filter((value) => value.startsWith(trimmed))
					.map((value) => ({ value, label: value }));
			}
			if (trimmed.startsWith("cancel ")) {
				const idPrefix = trimmed.slice("cancel ".length);
				return [{ value: "all", label: "all" }, ...[...tasks.keys()].map((id) => ({ value: id, label: id }))].filter(
					(item) => item.value.startsWith(idPrefix),
				);
			}
			return null;
		},
		handler: async (args, ctx) => {
			latestCtx = ctx;
			const message = await handleDelayCommand(args ?? "", ctx);
			ctx.ui.notify(
				message,
				message.startsWith("✓") || message.startsWith("예약된") || message.startsWith("Usage") ? "info" : "warning",
			);
		},
	});

	pi.registerTool({
		name: "delay",
		label: "Delay",
		description:
			"Schedule prompt text to be inserted into the current interactive editor after a short delay. Use for one-shot reminders like 5m, 1h, or 2시간. The user can cancel with /delay cancel <id>.",
		promptSnippet: "Insert a prompt into the current editor after a delay, e.g. delay=5m prompt='check status'.",
		promptGuidelines: [
			"Use delay only when the user explicitly asks to put a prompt into the editor later in the same interactive session.",
			"For recurring or persistent headless scheduled jobs, use cron instead of delay.",
			"Tell the user the returned id so they can cancel it with `/delay cancel <id>`.",
		],
		parameters: DelayParamsSchema,
		executionMode: "parallel",
		async execute(_toolCallId, rawParams, _signal, _onUpdate, ctx) {
			const params = rawParams as DelayToolParams;
			const delayMs = parseDurationMs(params.delay);
			if (delayMs === undefined) {
				return {
					content: [{ type: "text" as const, text: "Invalid delay. Use forms like 30s, 5m, 1h, 1h30m, 2시간." }],
					details: {},
					isError: true,
				};
			}
			if (!params.prompt.trim()) {
				return {
					content: [{ type: "text" as const, text: "prompt is required." }],
					details: {},
					isError: true,
				};
			}

			const task = scheduleDelay(ctx, delayMs, params.prompt.trim(), params.id);
			return {
				content: [
					{
						type: "text" as const,
						text: `✓ ${task.id} scheduled: ${formatKoreanDuration(delayMs)} later. Cancel with /delay cancel ${task.id}`,
					},
				],
				details: { id: task.id, dueAt: new Date(task.dueAt).toISOString(), prompt: task.prompt },
			};
		},
		renderCall(args, theme) {
			const params = args as Partial<DelayToolParams>;
			return new Text(
				`${theme.fg("toolTitle", theme.bold("delay "))}${theme.fg("accent", params.delay ?? "?")} ${theme.fg("dim", preview(params.prompt ?? ""))}`,
				0,
				0,
			);
		},
		renderResult(result, _options, theme, context) {
			const raw = result.content[0];
			const text = raw?.type === "text" ? raw.text : "(no output)";
			return new Text(context.isError ? theme.fg("error", text) : text, 0, 0);
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		latestCtx = ctx;
		refreshStatus();
	});

	pi.on("session_shutdown", async () => {
		clearAllTimers();
	});
}
