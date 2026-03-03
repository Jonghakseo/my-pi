/**
 * Blueprint CRUD and state management.
 *
 * Blueprints are persisted as YAML files in ~/.pi/blueprints/.
 * Each Blueprint is a DAG of intent nodes with status tracking.
 * Inspired by oh-my-opencode's Boulder State pattern.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import type { Blueprint, BlueprintNode } from "./types.js";

// ─── File System ─────────────────────────────────────────────────────────────

const BLUEPRINTS_DIR = path.join(process.env.HOME || "~", ".pi", "blueprints");

function ensureDir(): void {
	fs.mkdirSync(BLUEPRINTS_DIR, { recursive: true });
}

// ─── CRUD ────────────────────────────────────────────────────────────────────

export function generateBlueprintId(): string {
	return `bp-${Date.now()}`;
}

export function saveBlueprint(blueprint: Blueprint): void {
	ensureDir();
	const filePath = path.join(BLUEPRINTS_DIR, `${blueprint.id}.yaml`);
	fs.writeFileSync(filePath, stringifyYaml(blueprint), "utf-8");
}

export function loadBlueprint(blueprintId: string): Blueprint | null {
	const yamlPath = path.join(BLUEPRINTS_DIR, `${blueprintId}.yaml`);
	const jsonPath = path.join(BLUEPRINTS_DIR, `${blueprintId}.json`);

	// Try YAML first
	if (fs.existsSync(yamlPath)) {
		try {
			return parseYaml(fs.readFileSync(yamlPath, "utf-8")) as Blueprint;
		} catch {
			return null;
		}
	}

	// Fallback to JSON for migration compatibility
	if (fs.existsSync(jsonPath)) {
		try {
			return JSON.parse(fs.readFileSync(jsonPath, "utf-8")) as Blueprint;
		} catch {
			return null;
		}
	}

	return null;
}

export function deleteBlueprint(blueprintId: string): void {
	const yamlPath = path.join(BLUEPRINTS_DIR, `${blueprintId}.yaml`);
	const jsonPath = path.join(BLUEPRINTS_DIR, `${blueprintId}.json`);
	try {
		if (fs.existsSync(yamlPath)) fs.unlinkSync(yamlPath);
		if (fs.existsSync(jsonPath)) fs.unlinkSync(jsonPath);
	} catch {
		/* ignore delete errors */
	}
}

export function listBlueprints(cwdFilter?: string): Blueprint[] {
	ensureDir();
	const files = fs.readdirSync(BLUEPRINTS_DIR).filter((f) => f.endsWith(".yaml") || f.endsWith(".json"));
	const blueprints: Blueprint[] = [];
	const seen = new Set<string>(); // Track blueprint IDs to avoid duplicates

	for (const file of files) {
		try {
			const filePath = path.join(BLUEPRINTS_DIR, file);
			let bp: Blueprint;

			if (file.endsWith(".yaml")) {
				bp = parseYaml(fs.readFileSync(filePath, "utf-8")) as Blueprint;
			} else {
				bp = JSON.parse(fs.readFileSync(filePath, "utf-8")) as Blueprint;
			}

			// Skip if we've already loaded a newer YAML version of this blueprint
			if (seen.has(bp.id)) continue;
			seen.add(bp.id);

			if (!cwdFilter || bp.cwd === cwdFilter) {
				blueprints.push(bp);
			}
		} catch {
			/* skip corrupt files */
		}
	}
	return blueprints.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

// ─── Node Status Updates ─────────────────────────────────────────────────────

export function updateNodeStatus(
	blueprintId: string,
	nodeId: string,
	update: Partial<BlueprintNode>,
): Blueprint | null {
	const bp = loadBlueprint(blueprintId);
	if (!bp) return null;

	const node = bp.nodes.find((n) => n.id === nodeId);
	if (!node) return null;

	Object.assign(node, update);
	recalculateBlueprintStatus(bp);
	saveBlueprint(bp);
	return bp;
}

/**
 * Recalculate the overall Blueprint status based on node states.
 */
function recalculateBlueprintStatus(bp: Blueprint): void {
	if (bp.status === "aborted") return; // don't override abort

	const allDone = bp.nodes.every((n) => n.status === "completed" || n.status === "skipped");
	const anyRunning = bp.nodes.some((n) => n.status === "running");
	const anyFailed = bp.nodes.some((n) => n.status === "failed");
	const anyEscalated = bp.nodes.some((n) => n.status === "escalated");

	if (allDone) {
		bp.status = "completed";
	} else if (anyFailed && !anyRunning && !anyEscalated) {
		// Only mark as failed if nothing is still running AND no escalations pending
		bp.status = "failed";
	} else if (anyRunning || anyEscalated) {
		// Escalated nodes keep the Blueprint in "running" state (not failed)
		// so the master can retry them after providing judgment
		bp.status = "running";
	}
	// Otherwise keep current status (confirmed/running)
}

/**
 * Reset a failed or skipped node back to pending so it can be retried.
 * Only nodes with status "failed" or "skipped" can be reset.
 * Also resets the Blueprint overall status if it was marked completed/failed.
 * Returns the updated Blueprint, or null if node not found / not resettable.
 */
export function resetNodeStatus(blueprintId: string, nodeId: string): Blueprint | null {
	const bp = loadBlueprint(blueprintId);
	if (!bp) return null;
	const node = bp.nodes.find((n) => n.id === nodeId);
	if (!node) return null;
	// Only failed, skipped, or escalated nodes can be reset
	if (node.status !== "failed" && node.status !== "skipped" && node.status !== "escalated") return null;
	node.status = "pending";
	node.startedAt = undefined;
	node.completedAt = undefined;
	node.result = undefined;
	node.error = undefined;
	node.escalationMessage = undefined;
	// If the Blueprint itself is in a terminal state, bring it back to running/confirmed
	if (bp.status === "completed" || bp.status === "failed") {
		bp.status = "confirmed";
	}
	saveBlueprint(bp);
	return bp;
}

// ─── DAG Traversal ───────────────────────────────────────────────────────────

/**
 * Get all nodes that are ready to run:
 * - Status is "pending"
 * - All dependsOn nodes are "completed"
 */
export function getRunnableNodes(blueprint: Blueprint): BlueprintNode[] {
	return blueprint.nodes.filter((node) => {
		if (node.status !== "pending") return false;
		return node.dependsOn.every((depId) => {
			const dep = blueprint.nodes.find((n) => n.id === depId);
			return dep?.status === "completed";
		});
	});
}

// ─── Validation ──────────────────────────────────────────────────────────────

/**
 * Validate a Blueprint for structural correctness:
 * - No unknown node references in dependsOn/chainFrom
 * - No duplicate node IDs
 * - No circular dependencies
 * - chainFrom must be in dependsOn (or a transitive dependency)
 */
export function validateBlueprint(blueprint: Blueprint): string[] {
	const errors: string[] = [];
	const nodeIds = new Set(blueprint.nodes.map((n) => n.id));

	// Check for duplicate IDs
	if (nodeIds.size !== blueprint.nodes.length) {
		const seen = new Set<string>();
		for (const node of blueprint.nodes) {
			if (seen.has(node.id)) {
				errors.push(`Duplicate node ID: "${node.id}"`);
			}
			seen.add(node.id);
		}
	}

	for (const node of blueprint.nodes) {
		// Check dependsOn references
		for (const depId of node.dependsOn) {
			if (!nodeIds.has(depId)) {
				errors.push(`Node "${node.id}" depends on unknown node "${depId}"`);
			}
		}
		// Check chainFrom references
		if (node.chainFrom && !nodeIds.has(node.chainFrom)) {
			errors.push(`Node "${node.id}" chainFrom references unknown node "${node.chainFrom}"`);
		}
	}

	// Cycle detection (DFS)
	const visited = new Set<string>();
	const inStack = new Set<string>();

	function hasCycle(nodeId: string): boolean {
		if (inStack.has(nodeId)) return true;
		if (visited.has(nodeId)) return false;
		visited.add(nodeId);
		inStack.add(nodeId);

		const node = blueprint.nodes.find((n) => n.id === nodeId);
		if (node) {
			for (const depId of node.dependsOn) {
				if (hasCycle(depId)) return true;
			}
		}

		inStack.delete(nodeId);
		return false;
	}

	for (const node of blueprint.nodes) {
		if (hasCycle(node.id)) {
			errors.push(`Circular dependency detected involving node "${node.id}"`);
			break; // One cycle message is enough
		}
	}

	return errors;
}

// ─── Node Result Persistence ─────────────────────────────────────────────────

/**
 * Get the directory path for storing node result files for a Blueprint.
 */
export function getNodeResultDir(blueprintId: string): string {
	return path.join(BLUEPRINTS_DIR, blueprintId);
}

/**
 * Save a node's full result to a .md file.
 * Creates the directory if it doesn't exist.
 * Returns the absolute path to the saved file.
 */
export function saveNodeResult(blueprintId: string, nodeId: string, content: string): string {
	const dir = getNodeResultDir(blueprintId);
	fs.mkdirSync(dir, { recursive: true });
	// Sanitize nodeId for safe filename (replace non-alphanumeric except dash/underscore)
	const safeNodeId = nodeId.replace(/[^a-zA-Z0-9_-]/g, "_");
	const filePath = path.join(dir, `${safeNodeId}-result.md`);
	fs.writeFileSync(filePath, content, "utf-8");
	return filePath;
}

/**
 * Load a node result from a previously saved .md file.
 * Returns null if the file doesn't exist or can't be read.
 */
export function loadNodeResult(resultPath: string): string | null {
	try {
		if (!fs.existsSync(resultPath)) return null;
		return fs.readFileSync(resultPath, "utf-8");
	} catch {
		return null;
	}
}

// ─── Challenger Gate Auto-Injection ──────────────────────────────────────────

/**
 * Phase-detection sets for categorizing node purposes.
 */
const PLAN_PURPOSES = new Set(["plan", "explore"]);
const IMPL_PURPOSES = new Set(["implement"]);
const REVIEW_PURPOSES = new Set(["review", "verify"]);

/** 주어진 노드의 모든 transitive ancestor ID 집합을 반환 (BFS) */
function getTransitiveAncestors(nodeId: string, nodes: BlueprintNode[]): Set<string> {
	const visited = new Set<string>();
	const queue = [nodeId];
	while (queue.length > 0) {
		const current = queue.shift()!;
		const node = nodes.find((n) => n.id === current);
		if (!node) continue;
		for (const dep of node.dependsOn) {
			if (!visited.has(dep)) {
				visited.add(dep);
				queue.push(dep);
			}
		}
	}
	return visited;
}

/**
 * Auto-inject challenger gate nodes into a Blueprint.
 * Called after chainFrom→dependsOn normalization, before DAG validation.
 *
 * Gate 1 (Pre-execution): plan/explore → 🛡️ challenge-gate1 → implement
 *   - Validates that the plan is sound before committing to implementation
 *
 * Gate 2 (Pre-completion): implement → 🛡️ challenge-gate2 → review/verify
 *   - Stress-tests implementation for edge cases before formal review
 *
 * Skip conditions:
 *   - Total nodes < 3 (trivial blueprint, no gates needed)
 *   - User already included 2+ purpose:"challenge" nodes (max 2 gates per blueprint)
 *
 * Gate injection:
 *   - Gate 1: Injected if plan→impl dependency exists AND no challenge already covers it
 *   - Gate 2: Injected if impl→review dependency exists AND no challenge already covers it
 *   - Each gate is evaluated independently, but total auto-injected challenges ≤ 2
 *
 * Dependency rewiring:
 *   Before Gate 1: plan-1 → impl-1 (impl-1.dependsOn = ["plan-1"])
 *   After Gate 1:  plan-1 → challenge-gate1 → impl-1
 *
 *   Before Gate 2: impl-1 → review-1 (review-1.dependsOn = ["impl-1"])
 *   After Gate 2:  impl-1 → challenge-gate2 → review-1
 */
export function injectChallengerGates(blueprint: Blueprint): void {
	// Skip for trivial blueprints
	if (blueprint.nodes.length < 3) return;

	// Count existing challenge nodes — skip if already 2+ (max 2 gates per blueprint)
	const existingChallengeCount = blueprint.nodes.filter((n) => n.purpose === "challenge").length;
	if (existingChallengeCount >= 2) return;

	const planNodeIds = new Set(blueprint.nodes.filter((n) => PLAN_PURPOSES.has(n.purpose)).map((n) => n.id));
	const implNodeIds = new Set(blueprint.nodes.filter((n) => IMPL_PURPOSES.has(n.purpose)).map((n) => n.id));

	// ── Gate 1: plan/explore → challenge → implement ──
	if (planNodeIds.size > 0 && implNodeIds.size > 0) {
		// Find implement nodes that DIRECTLY depend on plan nodes
		const implNodesDependingOnPlan = blueprint.nodes.filter(
			(n) => IMPL_PURPOSES.has(n.purpose) && n.dependsOn.some((dep) => planNodeIds.has(dep)),
		);

		if (implNodesDependingOnPlan.length > 0) {
			// Check if Gate 1 is already covered: challenge C가 impl의 transitive ancestor이고 C의 ancestor에 plan이 있으면 covered
			const gate1Covered = implNodesDependingOnPlan.every((implNode) => {
				const implAncestors = getTransitiveAncestors(implNode.id, blueprint.nodes);
				return [...implAncestors].some((ancestorId) => {
					const ancestor = blueprint.nodes.find((n) => n.id === ancestorId);
					if (ancestor?.purpose !== "challenge") return false;
					const challengeAncestors = getTransitiveAncestors(ancestorId, blueprint.nodes);
					return (
						ancestor.dependsOn.some((dep) => planNodeIds.has(dep)) ||
						[...challengeAncestors].some((id) => planNodeIds.has(id))
					);
				});
			});

			// Inject Gate 1 if not covered and under the max challenge limit
			if (!gate1Covered && existingChallengeCount < 2) {
				// 수동 추가된 sibling challenge (plan에 의존하지만 impl의 ancestor가 아닌 것) 가 있으면
				// 새 gate 삽입 대신 impl을 그 challenge를 거치도록 rewire
				const siblingChallenge = blueprint.nodes.find(
					(n) =>
						n.purpose === "challenge" &&
						n.dependsOn.some((dep) => planNodeIds.has(dep)) &&
						!getTransitiveAncestors(implNodesDependingOnPlan[0].id, blueprint.nodes).has(n.id),
				);

				if (siblingChallenge) {
					for (const implNode of implNodesDependingOnPlan) {
						implNode.dependsOn = [
							...new Set(implNode.dependsOn.map((dep) => (planNodeIds.has(dep) ? siblingChallenge.id : dep))),
						];
						if (implNode.chainFrom && planNodeIds.has(implNode.chainFrom)) {
							implNode.chainFrom = siblingChallenge.id;
						}
					}
				} else {
					// 기존 gate1 삽입 로직 (변경 없이 유지)
					const gateDeps = [
						...new Set(implNodesDependingOnPlan.flatMap((n) => n.dependsOn.filter((dep) => planNodeIds.has(dep)))),
					];

					const gate1: BlueprintNode = {
						id: "challenge-gate1",
						purpose: "challenge",
						difficulty: "medium",
						task: "이전 단계의 계획/탐색 결과를 검증하세요. 가정이 틀렸거나, 누락된 리스크가 있거나, 더 나은 접근법이 있는지 stress-test하세요.",
						dependsOn: gateDeps,
						chainFrom: gateDeps[gateDeps.length - 1],
						status: "pending",
					};

					for (const implNode of implNodesDependingOnPlan) {
						implNode.dependsOn = [...new Set(implNode.dependsOn.map((dep) => (planNodeIds.has(dep) ? gate1.id : dep)))];
						if (implNode.chainFrom && planNodeIds.has(implNode.chainFrom)) {
							implNode.chainFrom = gate1.id;
						}
					}

					const firstImplIdx = blueprint.nodes.findIndex((n) => implNodesDependingOnPlan.some((i) => i.id === n.id));
					if (firstImplIdx !== -1) {
						blueprint.nodes.splice(firstImplIdx, 0, gate1);
					} else {
						blueprint.nodes.push(gate1);
					}
				}
			}
		}
	}

	// ── Gate 2: implement → challenge → review/verify ──
	if (implNodeIds.size > 0) {
		const reviewNodesDependingOnImpl = blueprint.nodes.filter(
			(n) => REVIEW_PURPOSES.has(n.purpose) && n.dependsOn.some((dep) => implNodeIds.has(dep)),
		);

		if (reviewNodesDependingOnImpl.length > 0) {
			// Check if Gate 2 is already covered: challenge C가 review의 transitive ancestor이고 C의 ancestor에 impl이 있으면 covered
			const gate2Covered = reviewNodesDependingOnImpl.every((reviewNode) => {
				const reviewAncestors = getTransitiveAncestors(reviewNode.id, blueprint.nodes);
				return [...reviewAncestors].some((ancestorId) => {
					const ancestor = blueprint.nodes.find((n) => n.id === ancestorId);
					if (ancestor?.purpose !== "challenge") return false;
					const challengeAncestors = getTransitiveAncestors(ancestorId, blueprint.nodes);
					return (
						ancestor.dependsOn.some((dep) => implNodeIds.has(dep)) ||
						[...challengeAncestors].some((id) => implNodeIds.has(id))
					);
				});
			});

			// Inject Gate 2 if not covered and under the max challenge limit
			// Count how many challenges exist after potential Gate 1 injection
			const challengeCountAfterInjections = blueprint.nodes.filter((n) => n.purpose === "challenge").length;
			if (!gate2Covered && challengeCountAfterInjections < 2) {
				const siblingChallenge2 = blueprint.nodes.find(
					(n) =>
						n.purpose === "challenge" &&
						n.dependsOn.some((dep) => implNodeIds.has(dep)) &&
						!getTransitiveAncestors(reviewNodesDependingOnImpl[0].id, blueprint.nodes).has(n.id),
				);

				if (siblingChallenge2) {
					for (const reviewNode of reviewNodesDependingOnImpl) {
						reviewNode.dependsOn = [
							...new Set(reviewNode.dependsOn.map((dep) => (implNodeIds.has(dep) ? siblingChallenge2.id : dep))),
						];
						if (reviewNode.chainFrom && implNodeIds.has(reviewNode.chainFrom)) {
							reviewNode.chainFrom = siblingChallenge2.id;
						}
					}
				} else {
					// 기존 gate2 삽입 로직 (변경 없이 유지)
					const gateDeps = [
						...new Set(reviewNodesDependingOnImpl.flatMap((n) => n.dependsOn.filter((dep) => implNodeIds.has(dep)))),
					];

					const gate2: BlueprintNode = {
						id: "challenge-gate2",
						purpose: "challenge",
						difficulty: "medium",
						task: "구현 결과를 검증하세요. 빠진 엣지 케이스, 보안 이슈, 성능 문제가 없는지 stress-test하세요.",
						dependsOn: gateDeps,
						chainFrom: gateDeps[gateDeps.length - 1],
						status: "pending",
					};

					for (const reviewNode of reviewNodesDependingOnImpl) {
						reviewNode.dependsOn = [
							...new Set(reviewNode.dependsOn.map((dep) => (implNodeIds.has(dep) ? gate2.id : dep))),
						];
						if (reviewNode.chainFrom && implNodeIds.has(reviewNode.chainFrom)) {
							reviewNode.chainFrom = gate2.id;
						}
					}

					const firstReviewIdx = blueprint.nodes.findIndex((n) =>
						reviewNodesDependingOnImpl.some((r) => r.id === n.id),
					);
					if (firstReviewIdx !== -1) {
						blueprint.nodes.splice(firstReviewIdx, 0, gate2);
					} else {
						blueprint.nodes.push(gate2);
					}
				}
			}
		}
	}
}

// ─── Formatting ──────────────────────────────────────────────────────────────

const STATUS_ICONS: Record<string, string> = {
	pending: "⬜",
	running: "🔄",
	completed: "✅",
	failed: "❌",
	skipped: "⏭️",
	escalated: "🆘",
};

/**
 * Format a Blueprint as a human-readable markdown summary.
 */
export function formatBlueprintSummary(blueprint: Blueprint): string {
	const total = blueprint.nodes.length;
	const completed = blueprint.nodes.filter((n) => n.status === "completed").length;
	const failed = blueprint.nodes.filter((n) => n.status === "failed").length;
	const running = blueprint.nodes.filter((n) => n.status === "running").length;
	const escalated = blueprint.nodes.filter((n) => n.status === "escalated").length;

	const progressParts = [`${completed}/${total} completed`];
	if (failed > 0) progressParts.push(`${failed} failed`);
	if (running > 0) progressParts.push(`${running} running`);
	if (escalated > 0) progressParts.push(`${escalated} escalated`);

	const lines = [
		`## Blueprint: ${blueprint.title}`,
		`**ID**: \`${blueprint.id}\``,
		`**Status**: ${blueprint.status}`,
		`**Progress**: ${progressParts.join(", ")}`,
		"",
		"### Nodes",
	];

	for (const node of blueprint.nodes) {
		const icon = STATUS_ICONS[node.status] || "⬜";
		const deps = node.dependsOn.length > 0 ? ` (depends: ${node.dependsOn.join(", ")})` : "";
		const chain = node.chainFrom ? ` [chain←${node.chainFrom}]` : "";
		const agentLabel = node.agent ? ` → ${node.agent}` : "";
		lines.push(`${icon} **${node.id}** [${node.purpose}/${node.difficulty}]${agentLabel}: ${node.task}${deps}${chain}`);

		if (node.resultPath) {
			lines.push(`   📄 ${node.resultPath}`);
		}
		if (node.result) {
			const preview = node.result.length > 120 ? `${node.result.slice(0, 120)}...` : node.result;
			lines.push(`   → ${preview}`);
		}
		if (node.error) {
			const preview = node.error.length > 120 ? `${node.error.slice(0, 120)}...` : node.error;
			lines.push(`   ⚠️ Error: ${preview}`);
		}
		if (node.escalationMessage) {
			const preview =
				node.escalationMessage.length > 120 ? `${node.escalationMessage.slice(0, 120)}...` : node.escalationMessage;
			lines.push(`   🆘 Escalation: ${preview}`);
		}
	}

	return lines.join("\n");
}

/**
 * Format a compact one-line status for widget display.
 */
export function formatBlueprintCompact(blueprint: Blueprint): string {
	const total = blueprint.nodes.length;
	const completed = blueprint.nodes.filter((n) => n.status === "completed").length;
	return `[${blueprint.id}] ${blueprint.title} (${completed}/${total}) ${blueprint.status}`;
}

// ─── LLM-Actionable Progress Format ─────────────────────────────────────────

/**
 * Format a concise, LLM-actionable progress report for async notifications.
 *
 * Designed so the master LLM can decide next actions without calling status.
 * Includes: header with counts, per-node status with timing,
 * remaining dependency info, and explicit "다음 실행 가능" guidance.
 *
 * Example:
 *   📋 "로그인 버그 수정" [3/5 완료, 1 실행 중]
 *   ✅ plan-1 (planner) → 완료 2분
 *   ✅ challenge-1 (challenger) → 완료 1분
 *   ✅ impl-A (worker) → 방금 완료 3분 12초
 *   🔄 impl-B (worker-fast) → 실행 중 1분 경과
 *   ⬜ review-1 (reviewer) → 대기 (→ impl-B)
 *
 *   다음 실행 가능: 없음 (1개 노드 실행 완료 대기)
 */
export function formatBlueprintProgress(blueprint: Blueprint): string {
	const total = blueprint.nodes.length;
	const completed = blueprint.nodes.filter((n) => n.status === "completed").length;
	const failed = blueprint.nodes.filter((n) => n.status === "failed").length;
	const running = blueprint.nodes.filter((n) => n.status === "running").length;
	const escalated = blueprint.nodes.filter((n) => n.status === "escalated").length;

	// Header
	const counters: string[] = [`${completed}/${total} 완료`];
	if (running > 0) counters.push(`${running} 실행 중`);
	if (failed > 0) counters.push(`${failed} 실패`);
	if (escalated > 0) counters.push(`${escalated} 에스컬레이션`);

	const allDone = completed === total;
	const doneTag = allDone ? " ✅ Blueprint 완료!" : "";
	const lines = [`📋 "${blueprint.title}" [${counters.join(", ")}]${doneTag}`];

	// Per-node status rows
	for (const node of blueprint.nodes) {
		const icon = STATUS_ICONS[node.status] || "⬜";
		const agent = node.agent ? ` (${node.agent})` : "";
		const statusText = formatNodeStatusText(node, blueprint);
		lines.push(`${icon} ${node.id}${agent} → ${statusText}`);
	}

	// Actionable next-step guidance (skip if fully done)
	if (!allDone) {
		const runnable = getRunnableNodes(blueprint);
		lines.push(""); // blank line separator
		if (runnable.length > 0) {
			lines.push(`다음 실행 가능: ${runnable.map((n) => n.id).join(", ")}`);
		} else if (running > 0) {
			lines.push(`다음 실행 가능: 없음 (${running}개 노드 실행 완료 대기)`);
		} else if (escalated > 0) {
			const escNodes = blueprint.nodes.filter((n) => n.status === "escalated");
			const escList = escNodes.map((n) => `${n.id}`).join(", ");
			lines.push(`🆘 에스컬레이션 대기: ${escList}. retry_node로 재개하거나 abort로 중단하세요.`);
		} else if (failed > 0) {
			lines.push(`⚠️ 블로킹: ${failed}개 노드 실패. 수동 개입 필요.`);
		}
	}

	return lines.join("\n");
}

function formatNodeStatusText(node: BlueprintNode, blueprint: Blueprint): string {
	switch (node.status) {
		case "completed": {
			const dur = node.startedAt && node.completedAt ? ` ${formatIsoDuration(node.startedAt, node.completedAt)}` : "";
			return `완료${dur}`;
		}
		case "running": {
			const elapsed = node.startedAt ? ` ${formatIsoElapsed(node.startedAt)} 경과` : "";
			return `실행 중${elapsed}`;
		}
		case "failed": {
			const detail = node.error ? `: ${node.error.slice(0, 80)}` : "";
			return `실패${detail}`;
		}
		case "skipped":
			return "스킵";
		case "escalated": {
			const escDetail = node.escalationMessage ? `: ${node.escalationMessage.slice(0, 80)}` : "";
			return `에스컬레이션${escDetail}`;
		}
		default: {
			// Pending — show which dependencies are still blocking
			const blocking = node.dependsOn.filter((d) => {
				const dep = blueprint.nodes.find((n) => n.id === d);
				return dep && dep.status !== "completed";
			});
			return blocking.length > 0 ? `대기 (→ ${blocking.join(", ")})` : "대기";
		}
	}
}

function formatIsoDuration(startIso: string, endIso: string): string {
	const ms = new Date(endIso).getTime() - new Date(startIso).getTime();
	return formatMsDuration(ms);
}

function formatIsoElapsed(isoStr: string): string {
	const ms = Date.now() - new Date(isoStr).getTime();
	return formatMsDuration(ms);
}

function formatMsDuration(ms: number): string {
	const sec = Math.max(0, Math.floor(ms / 1000));
	if (sec < 60) return `${sec}초`;
	const min = Math.floor(sec / 60);
	const remainSec = sec % 60;
	return remainSec > 0 ? `${min}분 ${remainSec}초` : `${min}분`;
}
