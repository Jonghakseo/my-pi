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
	status: "pending" | "running" | "completed" | "failed" | "skipped";
	result?: string;
	/** Path to full result .md file */
	resultPath?: string;
	runId?: number;
	agent?: string;
	startedAt?: string;
	completedAt?: string;
	error?: string;
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
	status: "running" | "completed" | "failed";
	startedAt: string;
	completedAt?: string;
	result?: string;
	error?: string;
	/** Call to cancel an in-progress run */
	abort?: () => void;
	/** Session file path of the subagent process, for sub:trans support */
	sessionFile?: string;
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

const BlueprintNodeSchema = Type.Object({
	id: Type.String({ description: "Unique node ID (e.g. 'plan-1', 'impl-a', 'review-1')" }),
	purpose: PurposeSchema,
	difficulty: DifficultySchema,
	task: Type.String({ description: "Task description for the subagent" }),
	context: Type.Optional(Type.String({ description: "Additional context for the task" })),
	dependsOn: Type.Array(Type.String(), {
		description: "Node IDs that must complete before this node can run. Empty array = no dependencies.",
	}),
	chainFrom: Type.Optional(
		Type.String({
			description: "Node ID whose result should be automatically injected as context for this node",
		}),
	),
});

export const IntentParams = Type.Object({
	mode: StringEnum(
		["create_blueprint", "run_next", "run", "status", "abort", "abort_run", "retry_node", "edit_blueprint"] as const,
		{
			description: [
				"Operation mode:",
				"  create_blueprint — Create a DAG Blueprint of tasks. Returns summary for user confirmation.",
				"  run_next — Execute next runnable node(s) in a Blueprint. Call repeatedly until done.",
				"  run — Execute a single intent directly without Blueprint.",
				"  status — Get current Blueprint progress.",
				"  abort — Abort a running Blueprint and its active nodes.",
				"  abort_run — Cancel a single intent run by runId. Omit runId to list running intents.",
				"  retry_node — Reset a failed/skipped node to pending and re-run it via run_next.",
				"  edit_blueprint — Edit pending nodes in a confirmed/running Blueprint.",
			].join("\n"),
		},
	),

	// ── create_blueprint mode ──
	title: Type.Optional(Type.String({ description: "Blueprint title (create_blueprint mode)" })),
	description: Type.Optional(Type.String({ description: "Blueprint description (create_blueprint mode)" })),
	nodes: Type.Optional(
		Type.Array(BlueprintNodeSchema, {
			description: "Blueprint nodes forming a DAG (create_blueprint mode)",
		}),
	),

	// ── run_next / status / abort mode ──
	blueprintId: Type.Optional(Type.String({ description: "Blueprint ID to operate on" })),

	// ── run mode (single intent, no blueprint) ──
	purpose: Type.Optional(PurposeSchema),
	difficulty: Type.Optional(DifficultySchema),
	task: Type.Optional(Type.String({ description: "Task description (run mode)" })),
	context: Type.Optional(Type.String({ description: "Additional context or previous result (run mode)" })),

	// ── abort_run mode ──
	runId: Type.Optional(
		Type.String({ description: "Run ID of a single intent to cancel (abort_run mode). Omit to list running intents." }),
	),

	// ── retry_node mode ──
	nodeId: Type.Optional(
		Type.String({
			description: "Node ID to reset and retry (retry_node mode). Node must be in failed or skipped state.",
		}),
	),

	// ── edit_blueprint mode ──
	nodeUpdates: Type.Optional(
		Type.Array(
			Type.Object({
				id: Type.String({ description: "수정할 노드 ID" }),
				task: Type.Optional(Type.String({ description: "변경할 task 내용" })),
				context: Type.Optional(Type.String({ description: "변경할 context" })),
				purpose: Type.Optional(
					StringEnum(
						["explore", "search", "plan", "challenge", "decide", "implement", "review", "verify", "browse"] as const,
						{ description: "변경할 purpose" },
					),
				),
				difficulty: Type.Optional(StringEnum(["low", "medium", "high"] as const, { description: "변경할 difficulty" })),
				dependsOn: Type.Optional(Type.Array(Type.String(), { description: "변경할 dependsOn 목록" })),
				chainFrom: Type.Optional(Type.String({ description: "변경할 chainFrom 노드 ID" })),
			}),
			{ description: "수정할 노드 목록 (pending 노드만 가능)" },
		),
	),
});

export type IntentParamsType = Static<typeof IntentParams>;
