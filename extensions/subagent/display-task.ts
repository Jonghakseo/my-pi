import { extractNameFromResult, MAX_NAME_LENGTH } from "../utils/auto-name-utils.js";
import { generateShortLabel, type ShortLabelContext } from "../utils/short-label.js";
import { normalizeWhitespace } from "../utils/string-utils.js";

export const SUBAGENT_DISPLAY_TASK_SYSTEM_PROMPT =
	"서브에이전트 작업 지시를 분석해서 진행 상태에 표시할 짧은 작업명을 20자 이내 한 줄로 추출해. 임시 파일 경로(/tmp/... 등), read/follow the instructions 같은 내부 실행 문구는 숨기고, 사람이 이해할 수 있는 목적만 출력해. 오직 작업명 텍스트만 출력해.";

const DISPLAY_TASK_INPUT_MAX_CHARS = 600;
const GENERIC_DISPLAY_TASKS = new Set(["follow the instructions", "follow instructions", "read context"]);

export type DisplayTaskRefreshToken = {
	task: string;
	startedAt: number;
};

function stripMarkdownNoise(value: string): string {
	return value
		.replace(/`([^`]+)`/g, "$1")
		.replace(/\*\*([^*]+)\*\*/g, "$1")
		.replace(/\*([^*]+)\*/g, "$1");
}

export function createDisplayTaskRefreshToken(run: { task: string; startedAt: number }): DisplayTaskRefreshToken {
	return { task: run.task, startedAt: run.startedAt };
}

export function isDisplayTaskRefreshTokenCurrent(
	run: { task: string; startedAt: number },
	token: DisplayTaskRefreshToken,
): boolean {
	return run.task === token.task && run.startedAt === token.startedAt;
}

export function normalizeSubagentTaskText(task: string): string {
	return stripMarkdownNoise(normalizeWhitespace(task));
}

export function buildSubagentDisplayTaskFallback(task: string): string {
	const normalized = normalizeSubagentTaskText(task)
		.replace(/^\[continue #\d+\]\s*/i, "")
		.replace(/\bread\s+\/tmp\/\S+(?:\s+and\s+\/tmp\/\S+)*/gi, " ")
		.replace(/\/tmp\/\S+/g, " ")
		.replace(/\b(?:and\s+)?follow the instructions\b/gi, " ")
		.replace(/\b(?:and\s+)?follow instructions\b/gi, " ")
		.replace(/\b(?:use|using) the provided context\b/gi, " ")
		.replace(/\battached context\b/gi, " ")
		.replace(/^\bthen\b\s+/i, "")
		.replace(/^[:;,.\-–—|/\\]+\s*/, "")
		.replace(/\s+[:;,.\-–—|/\\]+$/g, "")
		.replace(/\s{2,}/g, " ")
		.trim();

	if (normalized) return normalized.slice(0, MAX_NAME_LENGTH);

	const heading = normalizeSubagentTaskText(task).match(/#{1,6}\s+([^\n]+)/);
	if (heading?.[1]) return normalizeWhitespace(heading[1]).slice(0, MAX_NAME_LENGTH);

	return normalizeSubagentTaskText(task).slice(0, MAX_NAME_LENGTH);
}

export function shouldSummarizeSubagentTask(task: string, fallback: string): boolean {
	const normalizedTask = normalizeSubagentTaskText(task).toLowerCase();
	const normalizedFallback = normalizeWhitespace(fallback).toLowerCase();
	if (!normalizedFallback) return true;
	if (normalizedTask.includes("/tmp/")) return true;
	if (normalizedTask.startsWith("[continue #")) return true;
	if (normalizedFallback.length >= MAX_NAME_LENGTH) return true;
	return GENERIC_DISPLAY_TASKS.has(normalizedFallback);
}

function buildDisplayTaskContext(task: string, fallback: string): string {
	const clippedTask = task.slice(0, DISPLAY_TASK_INPUT_MAX_CHARS);
	return [`원문: ${clippedTask}`, `정제본: ${fallback}`].join("\n");
}

export async function summarizeSubagentDisplayTask(task: string, ctx: ShortLabelContext): Promise<string> {
	const fallback = buildSubagentDisplayTaskFallback(task);
	const summary = await generateShortLabel(ctx, {
		systemPrompt: SUBAGENT_DISPLAY_TASK_SYSTEM_PROMPT,
		prompt: buildDisplayTaskContext(task, fallback),
		extractText: extractNameFromResult,
	});
	return summary || fallback;
}
