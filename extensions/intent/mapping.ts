/**
 * Intent → Agent Mapping Table
 *
 * Maps purpose + difficulty combinations to the appropriate subagent.
 * This is the core dispatch logic that replaces manual agent name selection.
 */

import type { Difficulty, Purpose } from "./types.js";

/**
 * Mapping table: purpose → (difficulty) → agent name.
 *
 * Fixed-agent purposes always return the same agent regardless of difficulty.
 * Variable-agent purposes (implement) select based on difficulty.
 *
 * explore = internal (코드베이스/파일시스템 탐색) → finder
 * search  = external (웹/문서/외부 정보 검색)    → searcher
 */
const PURPOSE_TO_AGENT: Record<Purpose, (difficulty: Difficulty) => string> = {
	explore: () => "finder", // internal: 코드베이스/파일 탐색
	search: () => "searcher", // external: 웹/문서/외부 검색
	plan: () => "planner",
	challenge: () => "challenger",
	decide: () => "decider",
	review: () => "reviewer",
	verify: (d) => (d === "high" ? "deep-verify" : "verifier"),
	browse: () => "browser",
	implement: (d) => (d === "high" ? "worker" : "worker-fast"),
};

/**
 * Resolve the best subagent for a given purpose + difficulty.
 * Falls back to "worker" if purpose is unknown.
 */
export function resolveAgent(purpose: string, difficulty: string): string {
	const resolver = PURPOSE_TO_AGENT[purpose as Purpose];
	if (!resolver) return "worker";
	return resolver(difficulty as Difficulty);
}

/**
 * Get a human-readable label for the purpose → agent mapping.
 * Used in Blueprint summaries and status output.
 */
export function getMappingDescription(): string {
	const lines: string[] = [
		"Purpose → Agent mapping:",
		"  explore   → finder        (internal: 코드베이스/파일 탐색)",
		"  search    → searcher      (external: 웹/문서/외부 검색)",
		"  plan      → planner",
		"  challenge → challenger",
		"  decide    → decider",
		"  review    → reviewer",
		"  verify (low/medium) → verifier",
		"  verify (high)       → deep-verify",
		"  browse    → browser",
		"  implement (low/medium) → worker-fast",
		"  implement (high)       → worker",
		"",
		"  commit/PR/execute → implement/low 로 대체 사용",
	];
	return lines.join("\n");
}
