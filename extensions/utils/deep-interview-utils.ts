export const DEEP_INTERVIEW_AMBIGUITY_THRESHOLD = 0.2;
export const DEEP_INTERVIEW_MIN_ROUNDS = 3;
export const DEEP_INTERVIEW_SOFT_MAX_ROUNDS = 8;

const SCORE_WEIGHTS = {
	goal: 0.4,
	constraints: 0.3,
	acceptanceCriteria: 0.3,
} as const;

const AMBIGUOUS_TERMS = [
	"적당",
	"대충",
	"아무거나",
	"가능하면",
	"나중",
	"어느 정도",
	"웬만하면",
	"알아서",
	"maybe",
	"somehow",
	"whatever",
	"etc",
	"later",
	"around",
	"quickly",
	"roughly",
	"something",
];

const ACTION_VERB_RE =
	/(구현|만들|개선|자동화|추가|제거|정리|설계|최적화|도입|확장|지원|migrate|build|implement|improve|add|remove|refactor|optimi[sz]e|design|ship|fix)/i;

const MEASURABLE_RE =
	/(if|when|then|must|should|error|success|status|response|latency|ms|sec|초|분|%|테스트|검증|통과|실패|로그|경고|알림|retry|rollback|timeout|\d+)/i;

const BULLET_PREFIX_RE = /^\s*(?:[-*•]+|\d+[.)])\s*/;

export interface DeepInterviewDraft {
	goal: string;
	constraints: string[];
	acceptanceCriteria: string[];
	outOfScope: string[];
	risks: string[];
}

export interface DeepInterviewScoreBreakdown {
	goal: number;
	constraints: number;
	acceptanceCriteria: number;
	completeness: number;
	structureCoverage: number;
	structureBonus: number;
	uncertaintyPenalty: number;
	confidence: number;
}

export interface DeepInterviewScoreResult {
	ambiguityScore: number;
	readyForExecution: boolean;
	breakdown: DeepInterviewScoreBreakdown;
	missingFields: string[];
	notes: string[];
}

export interface DeepInterviewSpecV1 {
	specId: string;
	specVersion: number;
	goal: string;
	constraints: string[];
	acceptanceCriteria: string[];
	outOfScope: string[];
	risks: string[];
	ambiguityScore: number;
	scoreBreakdown: DeepInterviewScoreBreakdown;
	readyForExecution: boolean;
	forced: boolean;
	createdAt: string;
	frozenAt: string;
}

export interface BuildSpecSnapshotInput {
	draft: DeepInterviewDraft;
	score: DeepInterviewScoreResult;
	specVersion: number;
	forced?: boolean;
	now?: Date;
	specId?: string;
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

function normalizeSentence(text: string): string {
	return text.replace(/\s+/g, " ").trim();
}

function dedupeStrings(values: string[]): string[] {
	const seen = new Set<string>();
	const result: string[] = [];

	for (const value of values) {
		const normalized = normalizeSentence(value);
		if (!normalized) continue;
		const key = normalized.toLowerCase();
		if (seen.has(key)) continue;
		seen.add(key);
		result.push(normalized);
	}

	return result;
}

function countWords(text: string): number {
	return text
		.split(/\s+/)
		.map((part) => part.trim())
		.filter(Boolean).length;
}

function normalizeDraft(draft: DeepInterviewDraft): DeepInterviewDraft {
	return {
		goal: normalizeSentence(draft.goal),
		constraints: dedupeStrings(draft.constraints),
		acceptanceCriteria: dedupeStrings(draft.acceptanceCriteria),
		outOfScope: dedupeStrings(draft.outOfScope),
		risks: dedupeStrings(draft.risks),
	};
}

function goalQuality(goal: string): number {
	if (!goal) return 0;

	let score = 0.35;
	if (goal.length >= 48) score += 0.5;
	else if (goal.length >= 24) score += 0.4;
	else if (goal.length >= 12) score += 0.25;
	else score += 0.1;

	if (ACTION_VERB_RE.test(goal)) score += 0.15;

	return clamp(score);
}

function listCountQuality(items: string[], thresholds: [number, number, number, number]): number {
	const count = items.length;
	if (count >= 4) return thresholds[3];
	if (count === 3) return thresholds[2];
	if (count === 2) return thresholds[1];
	if (count === 1) return thresholds[0];
	return 0;
}

function constraintsQuality(constraints: string[]): number {
	const base = listCountQuality(constraints, [0.45, 0.72, 0.9, 1]);
	if (base === 0) return 0;

	const avgLen = constraints.reduce((sum, item) => sum + item.length, 0) / constraints.length;
	let adjusted = base;
	if (avgLen < 10) adjusted -= 0.08;
	if (avgLen > 40) adjusted += 0.05;
	return clamp(adjusted);
}

function acceptanceCriteriaQuality(acceptanceCriteria: string[]): number {
	const base = listCountQuality(acceptanceCriteria, [0.35, 0.58, 0.82, 0.95]);
	if (base === 0) return 0;

	const measurableCount = acceptanceCriteria.filter((item) => MEASURABLE_RE.test(item)).length;
	const measurableRatio = measurableCount / acceptanceCriteria.length;
	const adjusted = base * 0.75 + measurableRatio * 0.25;
	return clamp(adjusted);
}

function structureCoverage(outOfScope: string[], risks: string[]): number {
	let score = 0;
	if (outOfScope.length > 0) score += 0.5;
	if (risks.length > 0) score += 0.5;
	return clamp(score);
}

function uncertaintyPenaltyFromText(text: string): number {
	if (!text.trim()) return 0;

	const lower = text.toLowerCase();
	const termHits = AMBIGUOUS_TERMS.filter((term) => lower.includes(term)).length;
	const questionHits = (text.match(/\?/g) ?? []).length;
	const wordCount = Math.max(1, countWords(text));

	const density = termHits / wordCount;
	const penalty = termHits * 0.02 + density * 0.4 + questionHits * 0.01;
	return clamp(penalty, 0, 0.25);
}

function collectMissingFields(normalized: DeepInterviewDraft): string[] {
	const missing: string[] = [];
	if (!normalized.goal) missing.push("goal");
	if (normalized.constraints.length === 0) missing.push("constraints");
	if (normalized.acceptanceCriteria.length === 0) missing.push("acceptanceCriteria");
	if (normalized.outOfScope.length === 0) missing.push("outOfScope");
	if (normalized.risks.length === 0) missing.push("risks");
	return missing;
}

function collectNotes(normalized: DeepInterviewDraft, ambiguityScore: number): string[] {
	const notes: string[] = [];

	if (normalized.constraints.length < 2) {
		notes.push("제약 조건을 최소 2개 이상 명시하면 실행 안정성이 올라갑니다.");
	}
	if (normalized.acceptanceCriteria.length < 3) {
		notes.push("Acceptance Criteria를 최소 3개 이상으로 구체화하세요.");
	}
	if (normalized.outOfScope.length === 0) {
		notes.push("Out-of-scope를 명시하면 범위 확장을 줄일 수 있습니다.");
	}
	if (normalized.risks.length === 0) {
		notes.push("리스크를 최소 1개 이상 기록하면 실행 중 대응이 쉬워집니다.");
	}
	if (ambiguityScore > DEEP_INTERVIEW_AMBIGUITY_THRESHOLD) {
		notes.push("모호성 점수가 임계치를 초과했습니다. 추가 인터뷰를 권장합니다.");
	}

	return notes;
}

/**
 * Split user input into clean list items.
 * Supports newline-separated, bullet, and comma-separated formats.
 */
export function sanitizeListInput(raw: string | string[] | null | undefined): string[] {
	if (Array.isArray(raw)) return dedupeStrings(raw);
	if (typeof raw !== "string") return [];

	const lines = raw
		.replace(/\r\n?/g, "\n")
		.split("\n")
		.map((line) => line.trim())
		.filter(Boolean);

	const items: string[] = [];
	for (const line of lines) {
		const withoutBullet = line.replace(BULLET_PREFIX_RE, "").trim();
		if (!withoutBullet) continue;

		const commaSeparated = withoutBullet.includes(",") ? withoutBullet.split(",") : [withoutBullet];
		for (const part of commaSeparated) {
			const normalized = normalizeSentence(part);
			if (!normalized) continue;
			items.push(normalized);
		}
	}

	return dedupeStrings(items);
}

export function mergeDraftList(current: string[], incoming: string[]): string[] {
	return dedupeStrings([...current, ...incoming]);
}

/**
 * Compute a lightweight ambiguity score inspired by Ouroboros' 0.2 gate.
 * Lower is better. <= 0.2 means ready for execution.
 */
export function computeAmbiguityScore(draft: DeepInterviewDraft): DeepInterviewScoreResult {
	const normalized = normalizeDraft(draft);

	const goal = goalQuality(normalized.goal);
	const constraints = constraintsQuality(normalized.constraints);
	const acceptanceCriteria = acceptanceCriteriaQuality(normalized.acceptanceCriteria);

	const completeness =
		goal * SCORE_WEIGHTS.goal +
		constraints * SCORE_WEIGHTS.constraints +
		acceptanceCriteria * SCORE_WEIGHTS.acceptanceCriteria;

	const structure = structureCoverage(normalized.outOfScope, normalized.risks);
	const structureBonus = structure * 0.08;

	const uncertaintyText = [
		normalized.goal,
		...normalized.constraints,
		...normalized.acceptanceCriteria,
		...normalized.outOfScope,
		...normalized.risks,
	].join("\n");
	const uncertaintyPenalty = uncertaintyPenaltyFromText(uncertaintyText);

	const confidence = clamp(completeness + structureBonus - uncertaintyPenalty);
	const ambiguityScore = clamp(1 - confidence);
	const readyForExecution = ambiguityScore <= DEEP_INTERVIEW_AMBIGUITY_THRESHOLD;

	return {
		ambiguityScore: round(ambiguityScore),
		readyForExecution,
		breakdown: {
			goal: round(goal),
			constraints: round(constraints),
			acceptanceCriteria: round(acceptanceCriteria),
			completeness: round(completeness),
			structureCoverage: round(structure),
			structureBonus: round(structureBonus),
			uncertaintyPenalty: round(uncertaintyPenalty),
			confidence: round(confidence),
		},
		missingFields: collectMissingFields(normalized),
		notes: collectNotes(normalized, ambiguityScore),
	};
}

function buildSpecId(now: Date): string {
	const ts = now.getTime().toString(36);
	const rand = Math.random().toString(36).slice(2, 8);
	return `di-${ts}-${rand}`;
}

/**
 * Freeze the current draft into an immutable spec snapshot.
 */
export function buildSpecSnapshot(input: BuildSpecSnapshotInput): DeepInterviewSpecV1 {
	const normalized = normalizeDraft(input.draft);
	const now = input.now ?? new Date();
	const timestamp = now.toISOString();
	const forced = Boolean(input.forced);
	const readyForExecution = forced ? false : input.score.readyForExecution;

	return {
		specId: input.specId ?? buildSpecId(now),
		specVersion: Math.max(1, Math.trunc(input.specVersion)),
		goal: normalized.goal,
		constraints: normalized.constraints,
		acceptanceCriteria: normalized.acceptanceCriteria,
		outOfScope: normalized.outOfScope,
		risks: normalized.risks,
		ambiguityScore: round(input.score.ambiguityScore),
		scoreBreakdown: input.score.breakdown,
		readyForExecution,
		forced,
		createdAt: timestamp,
		frozenAt: timestamp,
	};
}

function formatSection(title: string, items: string[], fallback: string): string {
	if (items.length === 0) {
		return `## ${title}\n- ${fallback}`;
	}
	if (title === "Acceptance Criteria") {
		return `## ${title}\n${items.map((item, index) => `${index + 1}. ${item}`).join("\n")}`;
	}
	return `## ${title}\n${items.map((item) => `- ${item}`).join("\n")}`;
}

/**
 * Build an execution handoff prompt compatible with subagent request format.
 */
export function buildHandoffPrompt(spec: DeepInterviewSpecV1): string {
	const metadataLines = [
		`- spec_id: ${spec.specId}`,
		`- spec_version: ${spec.specVersion}`,
		`- ambiguity_score: ${spec.ambiguityScore.toFixed(2)} (threshold <= ${DEEP_INTERVIEW_AMBIGUITY_THRESHOLD.toFixed(2)})`,
		`- ready_for_execution: ${spec.readyForExecution ? "true" : "false"}`,
		`- forced_freeze: ${spec.forced ? "true" : "false"}`,
		`- frozen_at: ${spec.frozenAt}`,
	].join("\n");

	return [
		"[REQUEST — AUTHORITATIVE]",
		spec.goal,
		"",
		formatSection("Constraints", spec.constraints, "No explicit constraints recorded."),
		"",
		formatSection("Acceptance Criteria", spec.acceptanceCriteria, "No acceptance criteria recorded."),
		"",
		formatSection("Out of Scope", spec.outOfScope, "Not specified."),
		"",
		formatSection("Risks", spec.risks, "Not specified."),
		"",
		"## Spec Metadata",
		metadataLines,
		"",
		"## Execution Guardrails",
		"- If the spec is insufficient, ask follow-up questions before coding.",
		"- Do not expand beyond 'Out of Scope' without explicit approval.",
	].join("\n");
}

export function buildSpecSummary(spec: DeepInterviewSpecV1): string {
	const readiness = spec.readyForExecution ? "READY" : "NOT_READY";
	return [
		`Deep Interview Spec v${spec.specVersion} (${readiness})`,
		`Goal: ${spec.goal}`,
		`Ambiguity: ${spec.ambiguityScore.toFixed(2)} (threshold <= ${DEEP_INTERVIEW_AMBIGUITY_THRESHOLD.toFixed(2)})`,
		`Constraints: ${spec.constraints.length} · AC: ${spec.acceptanceCriteria.length} · Out-of-scope: ${spec.outOfScope.length} · Risks: ${spec.risks.length}`,
	].join("\n");
}
