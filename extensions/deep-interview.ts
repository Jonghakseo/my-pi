/**
 * Inspiration / Source:
 * - Ouroboros protocol by Q00 (https://github.com/Q00/ouroboros)
 * - Core ideas adapted for this extension:
 *   1) Socratic interview rounds for requirement clarification
 *   2) Ambiguity gate (<= 0.20) before execution handoff
 *   3) Immutable spec freeze + authoritative handoff block
 *
 * This implementation is a lightweight, pi-extension-friendly adaptation,
 * intentionally separated from /purpose.
 */
import { spawn } from "node:child_process";
import { copyToClipboard, type ExtensionAPI, type ExtensionContext } from "@mariozechner/pi-coding-agent";
import {
	buildHandoffPrompt,
	buildSpecSnapshot,
	buildSpecSummary,
	computeAmbiguityScore,
	DEEP_INTERVIEW_AMBIGUITY_THRESHOLD,
	DEEP_INTERVIEW_MIN_ROUNDS,
	DEEP_INTERVIEW_SOFT_MAX_ROUNDS,
	mergeDraftList,
	sanitizeListInput,
	type DeepInterviewDraft,
	type DeepInterviewScoreResult,
	type DeepInterviewSpecV1,
} from "./utils/deep-interview-utils.ts";

const COMMAND_NAME = "deep-interview";
const CUSTOM_TYPE = "deep-interview";

const ENTRY_STARTED = "deep-interview:started";
const ENTRY_ROUND = "deep-interview:round";
const ENTRY_SCORED = "deep-interview:scored";
const ENTRY_FROZEN = "deep-interview:spec-frozen";
const ENTRY_CANCELLED = "deep-interview:cancelled";

type InterviewSlot = "goal" | "constraints" | "acceptanceCriteria" | "outOfScope" | "risks";
type DeepInterviewMode = "help" | "latest" | "interview";

type StartedEntry = {
	specVersion: number;
	goal: string;
	startedAt: string;
	threshold: number;
	minRounds: number;
};

type RoundEntry = {
	round: number;
	slot: InterviewSlot;
	question: string;
	answer: string;
	extracted: string[];
	timestamp: string;
};

type ScoredEntry = {
	round: number;
	ambiguityScore: number;
	readyForExecution: boolean;
	missingFields: string[];
	notes: string[];
	breakdown: DeepInterviewScoreResult["breakdown"];
	scoreSource: AmbiguityScoreSource;
	scoreError?: string;
	timestamp: string;
};

type FrozenEntry = {
	spec: DeepInterviewSpecV1;
	handoffPrompt: string;
	recommendedNextStep: string;
	timestamp: string;
};

type CancelledEntry = {
	specVersion: number;
	reason: string;
	round: number;
	timestamp: string;
};

type CustomEntry = {
	type: "custom";
	customType: string;
	data: Record<string, unknown>;
	[key: string]: unknown;
};

type RoundPrompt = {
	slot: InterviewSlot;
	question: string;
	placeholder: string;
};

type ParsedArgs = {
	mode: DeepInterviewMode;
	goalArg: string;
};

type AmbiguityScoreSource = "llm" | "heuristic";

type AmbiguityEvaluation = {
	score: DeepInterviewScoreResult;
	source: AmbiguityScoreSource;
	error?: string;
};

type LlmAmbiguityPayload = {
	goal_clarity: number;
	constraints_clarity: number;
	acceptance_criteria_clarity: number;
	out_of_scope_clarity: number;
	risks_clarity: number;
	uncertainty_penalty: number;
	missing_fields: string[];
	notes: string[];
};

const LLM_SCORE_TIMEOUT_MS = 20_000;

const LLM_SCORING_SYSTEM_PROMPT = [
	"You are a strict requirements clarity evaluator.",
	"Evaluate the provided draft spec and return ONLY valid JSON.",
	"No markdown fences, no explanations, no extra text.",
	"",
	"Return format:",
	'{"goal_clarity":0.0,"constraints_clarity":0.0,"acceptance_criteria_clarity":0.0,"out_of_scope_clarity":0.0,"risks_clarity":0.0,"uncertainty_penalty":0.0,"missing_fields":[],"notes":[]}',
	"",
	"Scoring rules:",
	"- All clarity scores must be numbers in [0.0, 1.0] (higher = clearer).",
	"- uncertainty_penalty must be in [0.0, 0.25] (higher = more ambiguous language).",
	"- missing_fields can only contain: goal, constraints, acceptanceCriteria, outOfScope, risks.",
	"- notes should be concise action-oriented recommendations.",
	"- Be conservative: do not give high scores unless statements are specific and measurable.",
].join("\n");

function isCustomEntry(entry: unknown): entry is CustomEntry {
	if (!entry || typeof entry !== "object") return false;
	const obj = entry as Record<string, unknown>;
	return obj.type === "custom" && typeof obj.customType === "string";
}

function cleanText(value: string): string {
	return value.replace(/\s+/g, " ").trim();
}

function stripEnclosingQuotes(value: string): string {
	if (!value) return value;
	const first = value[0];
	const last = value[value.length - 1];
	if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
		return value.slice(1, -1).trim();
	}
	return value;
}

function parseArgs(rawArgs: string): ParsedArgs {
	const normalized = stripEnclosingQuotes(cleanText(rawArgs));
	if (!normalized) return { mode: "interview", goalArg: "" };

	const tokens = normalized.toLowerCase().split(/\s+/).filter(Boolean);
	const head = tokens[0] ?? "";

	if (["help", "--help", "-h", "usage", "?"].includes(head)) {
		return { mode: "help", goalArg: "" };
	}
	if (["latest", "last", "--latest"].includes(head)) {
		return { mode: "latest", goalArg: "" };
	}

	return { mode: "interview", goalArg: normalized };
}

function clamp(value: number, min = 0, max = 1): number {
	if (Number.isNaN(value)) return min;
	if (value < min) return min;
	if (value > max) return max;
	return value;
}

function round(value: number, digits = 4): number {
	const factor = 10 ** digits;
	return Math.round(value * factor) / factor;
}

function normalizeStringArray(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	const seen = new Set<string>();
	const result: string[] = [];
	for (const item of value) {
		if (typeof item !== "string") continue;
		const normalized = cleanText(item);
		if (!normalized) continue;
		const key = normalized.toLowerCase();
		if (seen.has(key)) continue;
		seen.add(key);
		result.push(normalized);
	}
	return result;
}

function extractJsonObject(raw: string): string | null {
	const text = raw.trim();
	if (!text) return null;

	const codeBlockMatch = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
	if (codeBlockMatch?.[1]) {
		const inside = codeBlockMatch[1].trim();
		if (inside.startsWith("{") && inside.endsWith("}")) return inside;
	}

	const start = text.indexOf("{");
	const end = text.lastIndexOf("}");
	if (start >= 0 && end > start) {
		return text.slice(start, end + 1);
	}

	return null;
}

function parseLlmAmbiguityPayload(raw: string): LlmAmbiguityPayload | null {
	const jsonText = extractJsonObject(raw);
	if (!jsonText) return null;

	let data: Record<string, unknown>;
	try {
		const parsed = JSON.parse(jsonText) as unknown;
		if (!parsed || typeof parsed !== "object") return null;
		data = parsed as Record<string, unknown>;
	} catch {
		return null;
	}

	const goalClarity = clamp(Number(data.goal_clarity));
	const constraintsClarity = clamp(Number(data.constraints_clarity));
	const acceptanceCriteriaClarity = clamp(Number(data.acceptance_criteria_clarity));
	const outOfScopeClarity = clamp(Number(data.out_of_scope_clarity));
	const risksClarity = clamp(Number(data.risks_clarity));
	const uncertaintyPenalty = clamp(Number(data.uncertainty_penalty), 0, 0.25);

	if (
		Number.isNaN(goalClarity) ||
		Number.isNaN(constraintsClarity) ||
		Number.isNaN(acceptanceCriteriaClarity) ||
		Number.isNaN(outOfScopeClarity) ||
		Number.isNaN(risksClarity) ||
		Number.isNaN(uncertaintyPenalty)
	) {
		return null;
	}

	const allowedMissingField = new Set(["goal", "constraints", "acceptanceCriteria", "outOfScope", "risks"]);
	const missingFields = normalizeStringArray(data.missing_fields).filter((field) => allowedMissingField.has(field));

	return {
		goal_clarity: goalClarity,
		constraints_clarity: constraintsClarity,
		acceptance_criteria_clarity: acceptanceCriteriaClarity,
		out_of_scope_clarity: outOfScopeClarity,
		risks_clarity: risksClarity,
		uncertainty_penalty: uncertaintyPenalty,
		missing_fields: missingFields,
		notes: normalizeStringArray(data.notes),
	};
}

function collectMissingFieldsFromDraft(draft: DeepInterviewDraft): string[] {
	const missing: string[] = [];
	if (!cleanText(draft.goal)) missing.push("goal");
	if (draft.constraints.length === 0) missing.push("constraints");
	if (draft.acceptanceCriteria.length === 0) missing.push("acceptanceCriteria");
	if (draft.outOfScope.length === 0) missing.push("outOfScope");
	if (draft.risks.length === 0) missing.push("risks");
	return missing;
}

function buildLlmUserPrompt(draft: DeepInterviewDraft): string {
	const payload = {
		goal: draft.goal,
		constraints: draft.constraints,
		acceptanceCriteria: draft.acceptanceCriteria,
		outOfScope: draft.outOfScope,
		risks: draft.risks,
	};

	return [
		"Evaluate this requirements draft:",
		JSON.stringify(payload, null, 2),
		"",
		"Output strictly JSON using the required keys.",
	].join("\n");
}

async function runPiLlmScoring(userPrompt: string): Promise<{ output: string; error?: string }> {
	return new Promise((resolve) => {
		const args = [
			"--no-extensions",
			"--no-skills",
			"--no-prompt-templates",
			"--no-session",
			"--system-prompt",
			LLM_SCORING_SYSTEM_PROMPT,
			"-p",
			userPrompt,
		];

		let output = "";
		let stderrOutput = "";
		let settled = false;

		const proc = spawn("pi", args, {
			env: process.env,
			stdio: ["ignore", "pipe", "pipe"],
		});

		const finish = (result: { output: string; error?: string }) => {
			if (settled) return;
			settled = true;
			resolve(result);
		};

		const timer = setTimeout(() => {
			proc.kill();
			finish({
				output: output.trim(),
				error: "LLM scoring timeout",
			});
		}, LLM_SCORE_TIMEOUT_MS);

		proc.stdout.on("data", (chunk: Buffer) => {
			output += chunk.toString();
		});
		proc.stderr.on("data", (chunk: Buffer) => {
			stderrOutput += chunk.toString();
		});

		proc.on("close", (code) => {
			clearTimeout(timer);
			const trimmedOutput = output.trim();
			if (code === 0 && trimmedOutput) {
				finish({ output: trimmedOutput });
				return;
			}
			finish({
				output: trimmedOutput,
				error: stderrOutput.trim() || `LLM scoring process exited with code ${code ?? "unknown"}`,
			});
		});

		proc.on("error", (error) => {
			clearTimeout(timer);
			finish({ output: output.trim(), error: error.message });
		});
	});
}

function buildScoreFromLlmPayload(
	payload: LlmAmbiguityPayload,
	draft: DeepInterviewDraft,
): DeepInterviewScoreResult {
	const completeness =
		payload.goal_clarity * 0.4 +
		payload.constraints_clarity * 0.3 +
		payload.acceptance_criteria_clarity * 0.3;

	const structureCoverage = clamp((payload.out_of_scope_clarity + payload.risks_clarity) / 2);
	const structureBonus = structureCoverage * 0.08;
	const confidence = clamp(completeness + structureBonus - payload.uncertainty_penalty);
	const ambiguityScore = clamp(1 - confidence);

	const missingFields = normalizeStringArray([...payload.missing_fields, ...collectMissingFieldsFromDraft(draft)]);
	const notes =
		payload.notes.length > 0
			? payload.notes
			: ambiguityScore > DEEP_INTERVIEW_AMBIGUITY_THRESHOLD
				? ["모호성 점수가 임계치를 초과했습니다. 추가 인터뷰를 권장합니다."]
				: [];

	return {
		ambiguityScore: round(ambiguityScore),
		readyForExecution: ambiguityScore <= DEEP_INTERVIEW_AMBIGUITY_THRESHOLD,
		breakdown: {
			goal: round(payload.goal_clarity),
			constraints: round(payload.constraints_clarity),
			acceptanceCriteria: round(payload.acceptance_criteria_clarity),
			completeness: round(completeness),
			structureCoverage: round(structureCoverage),
			structureBonus: round(structureBonus),
			uncertaintyPenalty: round(payload.uncertainty_penalty),
			confidence: round(confidence),
		},
		missingFields,
		notes,
	};
}

async function evaluateAmbiguityScore(draft: DeepInterviewDraft): Promise<AmbiguityEvaluation> {
	const userPrompt = buildLlmUserPrompt(draft);
	const llmResult = await runPiLlmScoring(userPrompt);

	if (llmResult.error) {
		return {
			score: computeAmbiguityScore(draft),
			source: "heuristic",
			error: llmResult.error,
		};
	}

	const parsed = parseLlmAmbiguityPayload(llmResult.output);
	if (!parsed) {
		return {
			score: computeAmbiguityScore(draft),
			source: "heuristic",
			error: "Failed to parse LLM scoring response",
		};
	}

	return {
		score: buildScoreFromLlmPayload(parsed, draft),
		source: "llm",
	};
}

function usageText(): string {
	return [
		"Usage:",
		"- /deep-interview <goal>",
		"- /deep-interview            (UI에서 goal 입력)",
		"- /deep-interview latest     (가장 최근 frozen spec 조회)",
		"- /deep-interview help",
		"",
		"Protocol:",
		`1) 최소 ${DEEP_INTERVIEW_MIN_ROUNDS}라운드 인터뷰`,
		`2) LLM 기반 모호성 점수 계산 (threshold <= ${DEEP_INTERVIEW_AMBIGUITY_THRESHOLD.toFixed(2)})`,
		"3) continue / freeze / force / cancel",
		"4) frozen spec + [REQUEST — AUTHORITATIVE] handoff 생성",
	].join("\n");
}

function buildPlannerDispatchMessage(handoffPrompt: string): string {
	return [
		"/sub:main planner 아래 명세를 기준으로 구현 계획, 리스크 대응, 검증 순서를 작성해줘.",
		"",
		handoffPrompt,
	].join("\n");
}

function getNextSpecVersion(ctx: ExtensionContext): number {
	const branch = ctx.sessionManager.getBranch();
	let maxVersion = 0;

	for (const entry of branch) {
		if (!isCustomEntry(entry)) continue;
		if (entry.customType !== ENTRY_FROZEN) continue;
		const data = entry.data;
		if (!data || typeof data !== "object") continue;

		const specVersion = (data as { specVersion?: unknown }).specVersion;
		if (typeof specVersion === "number" && Number.isFinite(specVersion)) {
			maxVersion = Math.max(maxVersion, Math.trunc(specVersion));
			continue;
		}

		const spec = (data as { spec?: { specVersion?: unknown } }).spec;
		if (spec && typeof spec.specVersion === "number" && Number.isFinite(spec.specVersion)) {
			maxVersion = Math.max(maxVersion, Math.trunc(spec.specVersion));
		}
	}

	return Math.max(1, maxVersion + 1);
}

function getLatestFrozenEntry(ctx: ExtensionContext): FrozenEntry | null {
	const branch = ctx.sessionManager.getBranch();
	for (let i = branch.length - 1; i >= 0; i--) {
		const entry = branch[i];
		if (!isCustomEntry(entry)) continue;
		if (entry.customType !== ENTRY_FROZEN) continue;

		const data = entry.data as Partial<FrozenEntry> | undefined;
		if (!data || typeof data !== "object") continue;
		if (!data.spec || typeof data.spec !== "object") continue;
		if (typeof data.handoffPrompt !== "string") continue;
		if (typeof data.recommendedNextStep !== "string") continue;

		const spec = data.spec as DeepInterviewSpecV1;
		if (typeof spec.goal !== "string" || !spec.goal.trim()) continue;
		if (typeof spec.specVersion !== "number") continue;

		return {
			spec,
			handoffPrompt: data.handoffPrompt,
			recommendedNextStep: data.recommendedNextStep,
			timestamp: typeof data.timestamp === "string" ? data.timestamp : new Date().toISOString(),
		};
	}
	return null;
}

function createInitialDraft(goal: string): DeepInterviewDraft {
	return {
		goal: cleanText(goal),
		constraints: [],
		acceptanceCriteria: [],
		outOfScope: [],
		risks: [],
	};
}

function selectNextPrompt(round: number, draft: DeepInterviewDraft): RoundPrompt {
	if (round === 1) {
		return {
			slot: "constraints",
			question: "이 작업에서 반드시 지켜야 할 제약 조건을 2~4개 적어주세요.",
			placeholder: "예: 기존 API 스키마 유지, 다운타임 0, 보안 정책 준수",
		};
	}

	if (round === 2) {
		return {
			slot: "acceptanceCriteria",
			question: "완료를 판단할 Acceptance Criteria를 최소 3개 적어주세요.",
			placeholder: "예: 테스트 통과, 응답 지연 p95 200ms 이하, 실패 시 알림 발생",
		};
	}

	if (round === 3) {
		return {
			slot: "outOfScope",
			question: "이번 작업에서 하지 않을 것(Out of Scope)을 적어주세요.",
			placeholder: "예: 신규 UI 개발, 데이터 마이그레이션",
		};
	}

	if (draft.acceptanceCriteria.length < 3) {
		return {
			slot: "acceptanceCriteria",
			question: "AC가 아직 부족합니다. 측정 가능한 문장으로 추가해 주세요.",
			placeholder: "예: 오류율 1% 이하, 실패 시 rollback 가능",
		};
	}

	if (draft.constraints.length < 3) {
		return {
			slot: "constraints",
			question: "제약 조건을 조금 더 보강해 주세요.",
			placeholder: "예: 기존 배포 파이프라인 유지, 라이브러리 추가 금지",
		};
	}

	if (draft.risks.length === 0) {
		return {
			slot: "risks",
			question: "예상 리스크를 적어주세요.",
			placeholder: "예: 외부 API rate limit, 타임아웃, 호환성 문제",
		};
	}

	if (draft.outOfScope.length === 0) {
		return {
			slot: "outOfScope",
			question: "범위 팽창을 막기 위해 Out of Scope를 더 명확히 적어주세요.",
			placeholder: "예: 성능 최적화는 별도 티켓으로 분리",
		};
	}

	if (round % 2 === 0) {
		return {
			slot: "risks",
			question: "실행 실패 가능성이 있는 지점을 더 적어주세요.",
			placeholder: "예: 캐시 정합성 문제, 롤백 실패 시나리오",
		};
	}

	return {
		slot: "goal",
		question: "현재 목표를 더 명확한 한 문장으로 다듬어 주세요.",
		placeholder: "예: 결제 승인 실패 시 자동 재시도와 경고 알림을 구현한다",
	};
}

function applyRoundAnswer(draft: DeepInterviewDraft, slot: InterviewSlot, answer: string): string[] {
	if (slot === "goal") {
		draft.goal = cleanText(answer);
		return draft.goal ? [draft.goal] : [];
	}

	const parsed = sanitizeListInput(answer);
	if (slot === "constraints") draft.constraints = mergeDraftList(draft.constraints, parsed);
	if (slot === "acceptanceCriteria") draft.acceptanceCriteria = mergeDraftList(draft.acceptanceCriteria, parsed);
	if (slot === "outOfScope") draft.outOfScope = mergeDraftList(draft.outOfScope, parsed);
	if (slot === "risks") draft.risks = mergeDraftList(draft.risks, parsed);
	return parsed;
}

function buildDecisionOptions(score: DeepInterviewScoreResult): { options: string[]; defaultAction: "continue" | "freeze" } {
	if (score.readyForExecution) {
		return {
			options: ["✅ Freeze and finish", "🧠 Continue interview", "🛑 Cancel"],
			defaultAction: "freeze",
		};
	}

	return {
		options: ["🧠 Continue interview", "⚠️ Force freeze anyway", "🛑 Cancel"],
		defaultAction: "continue",
	};
}

function buildProgressSummary(
	round: number,
	score: DeepInterviewScoreResult,
	source: AmbiguityScoreSource,
): string {
	const missing = score.missingFields.length > 0 ? score.missingFields.join(", ") : "none";
	const sourceLabel = source === "llm" ? "LLM" : "heuristic-fallback";
	return [
		`Round ${round} 완료`,
		`Ambiguity: ${score.ambiguityScore.toFixed(2)} (ready: ${score.readyForExecution ? "yes" : "no"})`,
		`Score source: ${sourceLabel}`,
		`Missing fields: ${missing}`,
	].join("\n");
}

function buildRecommendedNextStep(spec: DeepInterviewSpecV1): string {
	if (!spec.readyForExecution) {
		return "명세가 아직 준비 상태가 아닙니다. /deep-interview 를 다시 실행해 추가 질문을 진행하세요.";
	}
	return [
		"다음 실행 권장:",
		"1) 아래 handoff 블록을 복사",
		"2) /sub:main planner 명령으로 실행 계획 수립 요청",
		"   예: /sub:main planner 아래 명세를 기준으로 구현 계획과 리스크 대응안을 작성해줘",
	].join("\n");
}

async function promptForGoal(ctx: ExtensionContext, initialArgs: string): Promise<string | null> {
	const fromArgs = cleanText(initialArgs);
	if (fromArgs) return fromArgs;
	if (!ctx.hasUI) return null;

	const goal = await ctx.ui.input(
		"어떤 작업을 명확히 하고 싶은가요?",
		"예: 결제 실패 재시도 로직과 알림 정책을 명확히 정리하고 싶다",
	);
	if (goal === undefined) return null;
	const normalized = cleanText(goal);
	return normalized || null;
}

async function promptDecisionAfterCancelInput(ctx: ExtensionContext): Promise<"continue" | "cancel"> {
	if (!ctx.hasUI) return "cancel";

	const selected = await ctx.ui.select("입력이 취소되었습니다. 인터뷰를 종료할까요?", [
		"계속 진행",
		"인터뷰 취소",
	]);
	if (!selected || selected === "인터뷰 취소") return "cancel";
	return "continue";
}

async function promptRoundAction(
	ctx: ExtensionContext,
	round: number,
	score: DeepInterviewScoreResult,
	source: AmbiguityScoreSource,
): Promise<"continue" | "freeze" | "force" | "cancel"> {
	if (!ctx.hasUI) return "cancel";

	const decisionMeta = buildDecisionOptions(score);
	const selected = await ctx.ui.select(buildProgressSummary(round, score, source), decisionMeta.options);
	if (!selected) return "cancel";
	if (selected.includes("Cancel") || selected.includes("취소")) return "cancel";
	if (selected.includes("Force")) return "force";
	if (selected.includes("Freeze")) return "freeze";
	return "continue";
}

async function promptPostFreezeActions(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	handoffPrompt: string,
): Promise<void> {
	if (!ctx.hasUI) return;

	while (true) {
		const selected = await ctx.ui.select("다음 액션을 선택하세요", [
			"완료",
			"📋 handoff를 클립보드에 복사",
			"🚀 /sub:main planner로 바로 전달",
		]);

		if (!selected || selected === "완료") return;

		if (selected.includes("클립보드")) {
			try {
				copyToClipboard(handoffPrompt);
				ctx.ui.notify("handoff를 클립보드에 복사했습니다.", "info");
			} catch (error) {
				ctx.ui.notify(`클립보드 복사 실패: ${error instanceof Error ? error.message : "unknown"}`, "error");
			}
			continue;
		}

		const dispatchMessage = buildPlannerDispatchMessage(handoffPrompt);
		pi.sendUserMessage(dispatchMessage);
		ctx.ui.notify("/sub:main planner 실행을 요청했습니다.", "info");
		return;
	}
}

function emitFrozenMessage(pi: ExtensionAPI, spec: DeepInterviewSpecV1, handoffPrompt: string, nextStep: string): void {
	const summary = buildSpecSummary(spec);
	const statusLine = spec.readyForExecution
		? "✅ Spec frozen (ready for execution)"
		: "⚠️ Spec frozen (not ready for execution; forced/advisory)";

	pi.sendMessage({
		customType: CUSTOM_TYPE,
		content: [statusLine, "", summary, "", handoffPrompt, "", nextStep].join("\n"),
		display: true,
		details: {
			spec,
			handoffPrompt,
			nextStep,
		},
	});
}

async function showLatestFrozenSpec(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	options?: { withPostActions?: boolean },
): Promise<void> {
	const latest = getLatestFrozenEntry(ctx);
	if (!latest) {
		if (ctx.hasUI) {
			ctx.ui.notify("현재 세션에 frozen spec이 없습니다. 먼저 /deep-interview를 실행하세요.", "warning");
		} else {
			pi.sendMessage({
				customType: CUSTOM_TYPE,
				content: "No frozen deep-interview spec found in this session.",
				display: true,
			});
		}
		return;
	}

	emitFrozenMessage(pi, latest.spec, latest.handoffPrompt, latest.recommendedNextStep);
	if (options?.withPostActions) {
		await promptPostFreezeActions(pi, ctx, latest.handoffPrompt);
	}
}

async function runDeepInterview(pi: ExtensionAPI, ctx: ExtensionContext, args: string): Promise<void> {
	const initialGoal = await promptForGoal(ctx, args);
	if (!initialGoal) {
		if (ctx.hasUI) {
			ctx.ui.notify("/deep-interview는 초기 목표가 필요합니다.", "warning");
		} else {
			pi.sendMessage({
				customType: CUSTOM_TYPE,
				content: "deep-interview requires interactive UI and an initial goal.",
				display: true,
			});
		}
		return;
	}

	if (!ctx.hasUI) {
		pi.sendMessage({
			customType: CUSTOM_TYPE,
			content: "/deep-interview는 인터랙티브 UI 모드에서만 실행할 수 있습니다. (질문 루프가 필요합니다)",
			display: true,
			details: {
				reason: "ui-required",
				goal: initialGoal,
			},
		});
		return;
	}

	const specVersion = getNextSpecVersion(ctx);
	const startedAt = new Date().toISOString();
	const draft = createInitialDraft(initialGoal);

	pi.appendEntry<StartedEntry>(ENTRY_STARTED, {
		specVersion,
		goal: draft.goal,
		startedAt,
		threshold: DEEP_INTERVIEW_AMBIGUITY_THRESHOLD,
		minRounds: DEEP_INTERVIEW_MIN_ROUNDS,
	});

	ctx.ui.notify(`Deep interview 시작 (spec v${specVersion}) · 최소 ${DEEP_INTERVIEW_MIN_ROUNDS}라운드 후 종료 가능`, "info");

	let round = 0;
	let finalScore: DeepInterviewScoreResult | null = null;
	let finalAction: "freeze" | "force" | "cancel" = "cancel";

	while (true) {
		round += 1;
		const prompt = selectNextPrompt(round, draft);
		const roundAnswer = await ctx.ui.input(`Round ${round} · ${prompt.question}`, prompt.placeholder);

		if (roundAnswer === undefined) {
			const decision = await promptDecisionAfterCancelInput(ctx);
			if (decision === "cancel") {
				finalAction = "cancel";
				break;
			}
			round -= 1;
			continue;
		}

		const answer = cleanText(roundAnswer);
		if (!answer) {
			ctx.ui.notify("빈 응답은 저장되지 않았습니다. 같은 라운드를 다시 진행합니다.", "warning");
			round -= 1;
			continue;
		}

		const extracted = applyRoundAnswer(draft, prompt.slot, answer);
		pi.appendEntry<RoundEntry>(ENTRY_ROUND, {
			round,
			slot: prompt.slot,
			question: prompt.question,
			answer,
			extracted,
			timestamp: new Date().toISOString(),
		});

		const evaluated = await evaluateAmbiguityScore(draft);
		const score = evaluated.score;
		finalScore = score;

		if (evaluated.source === "heuristic") {
			ctx.ui.notify(
				`LLM 점수 평가 실패로 휴리스틱으로 대체했습니다: ${evaluated.error ?? "unknown error"}`,
				"warning",
			);
		}

		pi.appendEntry<ScoredEntry>(ENTRY_SCORED, {
			round,
			ambiguityScore: score.ambiguityScore,
			readyForExecution: score.readyForExecution,
			missingFields: score.missingFields,
			notes: score.notes,
			breakdown: score.breakdown,
			scoreSource: evaluated.source,
			scoreError: evaluated.error,
			timestamp: new Date().toISOString(),
		});

		if (round < DEEP_INTERVIEW_MIN_ROUNDS) {
			ctx.ui.notify(`Round ${round} 저장됨 · 최소 ${DEEP_INTERVIEW_MIN_ROUNDS}라운드까지 계속 진행합니다.`, "info");
			continue;
		}

		if (round >= DEEP_INTERVIEW_SOFT_MAX_ROUNDS) {
			ctx.ui.notify(`라운드가 ${DEEP_INTERVIEW_SOFT_MAX_ROUNDS}를 넘었습니다. 요약 후 종료를 권장합니다.`, "warning");
		}

		const action = await promptRoundAction(ctx, round, score, evaluated.source);
		if (action === "continue") continue;
		if (action === "cancel") {
			finalAction = "cancel";
			break;
		}
		if (action === "force") {
			finalAction = "force";
			break;
		}
		finalAction = "freeze";
		break;
	}

	if (finalAction === "cancel") {
		pi.appendEntry<CancelledEntry>(ENTRY_CANCELLED, {
			specVersion,
			reason: "user_cancelled",
			round,
			timestamp: new Date().toISOString(),
		});
		ctx.ui.notify("deep-interview를 취소했습니다.", "warning");
		return;
	}

	let scoreForFreeze = finalScore;
	if (!scoreForFreeze) {
		const evaluated = await evaluateAmbiguityScore(draft);
		scoreForFreeze = evaluated.score;
		if (evaluated.source === "heuristic") {
			ctx.ui.notify(
				`최종 점수 계산에서 LLM 평가를 사용하지 못했습니다: ${evaluated.error ?? "unknown error"}`,
				"warning",
			);
		}
	}

	const frozenSpec = buildSpecSnapshot({
		draft,
		score: scoreForFreeze,
		specVersion,
		forced: finalAction === "force",
	});
	const handoffPrompt = buildHandoffPrompt(frozenSpec);
	const recommendedNextStep = buildRecommendedNextStep(frozenSpec);

	pi.appendEntry<FrozenEntry>(ENTRY_FROZEN, {
		spec: frozenSpec,
		handoffPrompt,
		recommendedNextStep,
		timestamp: new Date().toISOString(),
	});

	emitFrozenMessage(pi, frozenSpec, handoffPrompt, recommendedNextStep);
	if (finalAction === "force") {
		ctx.ui.notify(
			`강제 freeze 완료 · ambiguity ${frozenSpec.ambiguityScore.toFixed(2)} (> ${DEEP_INTERVIEW_AMBIGUITY_THRESHOLD.toFixed(2)})`,
			"warning",
		);
	} else {
		ctx.ui.notify(`spec freeze 완료 · ambiguity ${frozenSpec.ambiguityScore.toFixed(2)}`, "info");
	}

	await promptPostFreezeActions(pi, ctx, handoffPrompt);
}

export default function deepInterviewExtension(pi: ExtensionAPI) {
	pi.registerCommand(COMMAND_NAME, {
		description:
			"Run a deep requirement interview protocol (goal/constraints/AC/out-of-scope/risks), with spec freeze and handoff",
		getArgumentCompletions: (argumentPrefix: string) => {
			const trimmedStart = argumentPrefix.trimStart();
			if (trimmedStart.includes(" ")) return null;

			const query = trimmedStart.toLowerCase();
			const options = [
				{ value: "help", description: "사용법 보기" },
				{ value: "latest", description: "가장 최근 frozen spec 조회" },
			];

			const matches = options
				.filter((option) => !query || option.value.startsWith(query))
				.map((option) => ({
					value: `${option.value} `,
					label: option.value,
					description: option.description,
				}));

			return matches.length > 0 ? matches : null;
		},
		handler: async (args, ctx) => {
			const parsed = parseArgs(args);
			if (parsed.mode === "help") {
				pi.sendMessage({
					customType: CUSTOM_TYPE,
					content: usageText(),
					display: true,
				});
				return;
			}
			if (parsed.mode === "latest") {
				await showLatestFrozenSpec(pi, ctx);
				return;
			}

			await runDeepInterview(pi, ctx, parsed.goalArg);
		},
	});
}
