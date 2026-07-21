/**
 * Output Compactor Extension
 *
 * 큰 툴 출력이 컨텍스트를 잡아먹는 걸 줄인다. 임계치를 넘는 bash 출력이 나오면:
 *   1. 전체 출력을 임시 파일에 저장하고,
 *   2. 저지연 모델(codex-spark)로 "의도(명령어)를 이해한" 압축을 만든 뒤,
 *   3. 컨텍스트에는 압축본 + 원본 경로만 남긴다.
 * 에이전트가 원문이 필요하면 경로를 read 하면 된다 (무손실 안전밸브).
 *
 * 에러/실패 라인은 압축 시 원문 그대로 보존하도록 지시한다 (compact.ts).
 *
 * 절감 토큰량을 푸터에 누적 표시한다. 에이전트가 원본 tmp 파일을 다시 read하면
 * 해당 건 절감은 취소되어 마이너스로 반영된다 (요약 주입분이 순수 오버헤드가 되므로).
 *
 * 임계치 근거: 세션 기록상 bash 출력의 상위 ~4%만 24KB를 넘고, 그 구간이 bash 볼륨의 절반 가까이를 차지.
 * pi 내장 truncation(50KB)이 손대지 않는 16~50KB 밴드를 겨냥한다.
 *
 * 환경변수:
 *   PI_OUTPUT_COMPACTOR=off            — 비활성화
 *   PI_OUTPUT_COMPACTOR_THRESHOLD_KB   — 임계치(KB) 재정의 (기본 24)
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { ExtensionAPI, ExtensionContext, ToolResultEvent } from "@earendil-works/pi-coding-agent";
import { compressOutput } from "./compact.ts";
import { getStats, recordCompaction, reverseIfTracked } from "./state.ts";
import { appendCompactionLog } from "./telemetry.ts";
import { estimateTokens, formatSignedTokens } from "./tokens.ts";

const DEFAULT_THRESHOLD_BYTES = 24 * 1024;
const SPARK_PROVIDER = "openai-codex";
const SPARK_MODEL_ID = "gpt-5.3-codex-spark";
const COMPRESS_TIMEOUT_MS = 20_000;
const TARGET_TOOLS = new Set(["bash"]);
const TMP_SUBDIR = "pi-output-compactor";
const STATUS_KEY = "output-compactor";

function isEnabled(): boolean {
	return (process.env.PI_OUTPUT_COMPACTOR || "").toLowerCase() !== "off";
}

function thresholdBytes(): number {
	const raw = process.env.PI_OUTPUT_COMPACTOR_THRESHOLD_KB;
	if (raw) {
		const kb = Number(raw);
		if (Number.isFinite(kb) && kb > 0) return Math.floor(kb * 1024);
	}
	return DEFAULT_THRESHOLD_BYTES;
}

function sessionIdOf(ctx: ExtensionContext): string {
	try {
		return ctx.sessionManager.getSessionId() || "";
	} catch {
		return "";
	}
}

function textPartsSize(content: ToolResultEvent["content"]): number {
	let bytes = 0;
	for (const part of content) {
		if (part.type === "text") bytes += Buffer.byteLength(part.text, "utf8");
	}
	return bytes;
}

function hasNonTextPart(content: ToolResultEvent["content"]): boolean {
	return content.some((part) => part.type !== "text");
}

function joinText(content: ToolResultEvent["content"]): string {
	return content
		.filter((part): part is { type: "text"; text: string } => part.type === "text")
		.map((part) => part.text)
		.join("");
}

function formatSize(bytes: number): string {
	return `${(bytes / 1024).toFixed(1)} KB`;
}

function saveOriginal(toolCallId: string, output: string): string | undefined {
	try {
		const dir = join(tmpdir(), TMP_SUBDIR);
		mkdirSync(dir, { recursive: true });
		const safeId = toolCallId.replace(/[^a-zA-Z0-9_-]/g, "_") || "output";
		const path = join(dir, `${Date.now()}-${safeId}.txt`);
		writeFileSync(path, output, "utf8");
		return path;
	} catch {
		return undefined;
	}
}

export default function (pi: ExtensionAPI) {
	const refreshFooter = (ctx: ExtensionContext) => {
		if (!ctx.hasUI) return;
		const { net, count } = getStats(sessionIdOf(ctx));
		if (count === 0) {
			ctx.ui.setStatus(STATUS_KEY, undefined);
			return;
		}
		const label = `󰝰 ${formatSignedTokens(net)} tok · ${count}×`;
		const color = net > 0 ? "success" : "warning";
		ctx.ui.setStatus(STATUS_KEY, ctx.ui.theme.fg(color, label));
	};

	// 에이전트가 우리가 만든 tmp 원본을 다시 읽으면 해당 건 절감을 취소(마이너스 전환).
	const handleReadReversal = (event: ToolResultEvent, ctx: ExtensionContext) => {
		const rawPath = typeof event.input.path === "string" ? event.input.path : "";
		if (rawPath && reverseIfTracked(sessionIdOf(ctx), resolve(rawPath))) refreshFooter(ctx);
	};

	const compactBashResult = async (event: ToolResultEvent, ctx: ExtensionContext) => {
		if (hasNonTextPart(event.content)) return;
		const size = textPartsSize(event.content);
		if (size <= thresholdBytes()) return;

		const output = joinText(event.content);
		if (!output) return;

		const model = ctx.modelRegistry.find(SPARK_PROVIDER, SPARK_MODEL_ID);
		if (!model) return;

		const savedPath = saveOriginal(event.toolCallId, output);
		// 원본을 저장하지 못하면 재조회 안전밸브가 없으므로 압축하지 않고 통과시킨다.
		if (!savedPath) return;

		const command = typeof event.input.command === "string" ? event.input.command : "";
		const summary = await compressOutput(command, output, model, ctx.modelRegistry, COMPRESS_TIMEOUT_MS);
		if (!summary) return;

		const summaryBytes = Buffer.byteLength(summary, "utf8");
		// 압축이 실질 이득이 없으면(요약이 원본만큼 크거나 더 큼) 그대로 통과시킨다.
		if (summaryBytes >= size) return;
		const reductionPct = Math.round((1 - summaryBytes / size) * 100);
		const header =
			`[output-compactor] bash output compressed by ${SPARK_MODEL_ID}: ${formatSize(size)} \u2192 ${formatSize(summaryBytes)} (-${reductionPct}%).\n` +
			`Full output saved to: ${savedPath}\n` +
			`Re-read that file if you need exact verbatim content (full logs, precise lines).\n\n` +
			`--- compressed summary ---\n`;
		const replacement = header + summary;

		const sessionId = sessionIdOf(ctx);
		const savedTokens = estimateTokens(output) - estimateTokens(replacement);
		recordCompaction(sessionId, resolve(savedPath), estimateTokens(output), savedTokens);
		appendCompactionLog({
			ts: Date.now(),
			sessionId,
			command,
			originalBytes: size,
			summaryBytes,
			reductionPct,
			savedTokens,
		});
		refreshFooter(ctx);

		return {
			content: [{ type: "text" as const, text: replacement }],
			isError: event.isError,
		};
	};

	pi.on("session_start", (_event, ctx) => refreshFooter(ctx));
	pi.on("session_info_changed", (_event, ctx) => refreshFooter(ctx));

	pi.on("tool_result", async (event: ToolResultEvent, ctx: ExtensionContext) => {
		if (!isEnabled()) return;
		if (event.toolName === "read") return handleReadReversal(event, ctx);
		if (TARGET_TOOLS.has(event.toolName)) return compactBashResult(event, ctx);
	});
}
