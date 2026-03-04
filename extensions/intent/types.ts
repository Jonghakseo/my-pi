/**
 * Intent Tool — Type definitions and TypeBox schemas
 *
 * Defines the Intent parameter schema, Blueprint structure,
 * and all supporting types for the category-based dispatch system.
 */

import { StringEnum } from "@mariozechner/pi-ai";
import { type Static, Type } from "@sinclair/typebox";

// ─── Purpose & Difficulty ────────────────────────────────────────────────────

export const PURPOSE_VALUES = [
	"explore", // internal 탐색 (코드베이스/파일시스템) → finder
	"search", // external 검색 (웹/문서/외부 정보) → searcher
	"plan", // 계획 → planner
	"challenge", // 도전질문 → challenger
	"decide", // 기술결정 → decider
	"implement", // 구현 → worker or worker-fast
	"review", // 코드리뷰 → reviewer
	"verify", // 검증 → verifier
	"browse", // 브라우저 → browser
] as const;

export type Purpose = (typeof PURPOSE_VALUES)[number];

export const DIFFICULTY_VALUES = ["low", "medium", "high"] as const;

export type Difficulty = (typeof DIFFICULTY_VALUES)[number];

// ─── Blueprint Node ──────────────────────────────────────────────────────────

export interface BlueprintNode {
	id: string;
	purpose: Purpose;
	difficulty: Difficulty;
	task: string;
	context?: string;
	dependsOn: string[];
	chainFrom?: string;
	status: "pending" | "running" | "completed" | "failed" | "skipped" | "escalated";
	result?: string;
	/** Path to full result .md file */
	resultPath?: string;
	runId?: number;
	agent?: string;
	startedAt?: string;
	completedAt?: string;
	error?: string;
	/** Escalation message from the subagent (set when status === "escalated") */
	escalationMessage?: string;
}

// ─── Blueprint ───────────────────────────────────────────────────────────────

export interface Blueprint {
	id: string;
	title: string;
	description?: string;
	createdAt: string;
	status: "pending_confirm" | "confirmed" | "running" | "completed" | "failed" | "aborted";
	nodes: BlueprintNode[];
	cwd?: string; // working directory at creation time (for project-scoped filtering)
}

// ─── Single Intent Run (for status tracking) ────────────────────────────────

export interface SingleIntentRun {
	id: string;
	purpose: string;
	difficulty: string;
	task: string;
	agent: string;
	status: "running" | "completed" | "failed" | "escalated";
	startedAt: string;
	completedAt?: string;
	result?: string;
	error?: string;
	/** Call to cancel an in-progress run */
	abort?: () => void;
	/** Session file path of the subagent process, for sub:trans support */
	sessionFile?: string;
}

// ─── Escalation Record ───────────────────────────────────────────────────────

/**
 * Written to ~/.pi/agent/escalations/<session-basename>.yaml by the escalate tool.
 * Consumed (read + deleted) by executor.ts after detecting exit code 42.
 */
export interface EscalationRecord {
	/** Session file of the subagent that triggered the escalation */
	sessionFile?: string;
	/** Human-readable escalation message from the subagent */
	message: string;
	/** Additional context provided by the subagent */
	context?: string;
	/** ISO timestamp */
	timestamp: string;
}

// ─── TypeBox Schemas ─────────────────────────────────────────────────────────

const PurposeSchema = StringEnum(
	["explore", "search", "plan", "challenge", "decide", "implement", "review", "verify", "browse"] as const,
	{
		description:
			"Task purpose: explore(코드베이스/파일 내부탐색), search(웹/문서 외부검색), plan(계획), challenge(도전질문), decide(기술결정), implement(구현), review(코드리뷰), verify(검증), browse(브라우저)",
	},
);

const DifficultySchema = StringEnum(["low", "medium", "high"] as const, {
	description: "Task difficulty: low(단순), medium(보통), high(복잡)",
});

// ─── Intent Single Run Params ─────────────────────────────────────────────

// Intent 단일 실행 전용 (mode 없음)
export const IntentRunParams = Type.Object({
	purpose: PurposeSchema, // 필수
	difficulty: DifficultySchema, // 필수
	task: Type.String({ description: "Task description" }), // 필수
	context: Type.Optional(Type.String({ description: "Additional context or previous result" })),
});
export type IntentRunParamsType = Static<typeof IntentRunParams>;

// ─── Blueprint DAG Params ─────────────────────────────────────────────────

// Blueprint DAG 관리 전용
export const BlueprintParams = Type.Object({
	mode: StringEnum(
		["create_blueprint", "run_next", "status", "abort", "abort_run", "retry_node", "edit_blueprint"] as const,
		{
			description: [
				"Operation mode:",
				"  create_blueprint — Create a DAG Blueprint of tasks. Returns summary for user confirmation.",
				"  run_next — Execute next runnable node(s) in a confirmed Blueprint. Call repeatedly until done.",
				"  status — Show current Blueprint progress.",
				"  abort — Abort a running Blueprint and its active nodes.",
				"  abort_run — Cancel a single intent run by runId. Omit runId to list running intents.",
				"  retry_node — Reset a failed/skipped node to pending and re-run it immediately.",
				"  edit_blueprint — Edit pending nodes in a confirmed/running Blueprint.",
			].join("\n"),
		},
	),
	// create_blueprint
	title: Type.Optional(Type.String({ description: "Blueprint title (create_blueprint mode)" })),
	description: Type.Optional(Type.String({ description: "Blueprint description (create_blueprint mode)" })),
	nodes: Type.Optional(
		Type.String({
			description: [
				"Blueprint nodes as YAML string (create_blueprint mode). Each node: id, purpose, difficulty, task, dependsOn[]. Optional: context, chainFrom.",
				"",
				"Example:",
				"- id: plan-1",
				"  purpose: plan",
				"  difficulty: medium",
				"  task: |",
				"    작업 내용을 여기에",
				"    여러 줄도 가능",
				"  dependsOn: []",
				"- id: impl-1",
				"  purpose: implement",
				"  difficulty: high",
				"  task: 구현 작업",
				"  dependsOn: [plan-1]",
				"  chainFrom: plan-1",
			].join("\n"),
		}),
	),
	need_confirm: Type.Optional(
		Type.Boolean({
			description:
				"false시 사용자 확인 없이 Blueprint를 즉시 confirmed 상태로 저장합니다 (소규모/저위험 Blueprint용). 기본값 true (확인 UI 표시)",
		}),
	),
	// run_next / status / abort
	blueprintId: Type.Optional(Type.String({ description: "Blueprint ID to operate on" })),
	// abort_run
	runId: Type.Optional(
		Type.String({ description: "Run ID of a single intent to cancel (abort_run mode). Omit to list running intents." }),
	),
	// retry_node
	nodeId: Type.Optional(
		Type.String({
			description: "Node ID to reset and retry (retry_node mode). Node must be in failed, skipped, or escalated state.",
		}),
	),
	// edit_blueprint
	nodeUpdates: Type.Optional(
		Type.String({
			description: [
				"수정할 노드 목록을 YAML string으로 전달 (pending 노드만 가능).",
				"필드: id(필수), task, context, purpose, difficulty, dependsOn[], chainFrom",
				"",
				"Example:",
				"- id: impl-1",
				"  task: 수정된 작업 내용",
				"  difficulty: low",
				"- id: review-1",
				"  purpose: verify",
				"  dependsOn: [impl-1]",
			].join("\n"),
		}),
	),
});
export type BlueprintParamsType = Static<typeof BlueprintParams>;
