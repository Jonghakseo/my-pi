/**
 * injectChallengerGates — 5개 케이스 검증
 * decide-1 기준 케이스 + 보완 케이스 포함
 */
import { describe, expect, it } from "vitest";
import { injectChallengerGates } from "./blueprint.js";
import type { Blueprint, BlueprintNode } from "./types.js";

function makeNode(override: Partial<BlueprintNode> & { id: string; purpose: BlueprintNode["purpose"] }): BlueprintNode {
	return {
		difficulty: "medium",
		task: "task",
		dependsOn: [],
		status: "pending",
		...override,
	};
}

function makeBp(nodes: BlueprintNode[]): Blueprint {
	return {
		id: "bp-test",
		title: "Test",
		createdAt: new Date().toISOString(),
		status: "confirmed",
		nodes,
	};
}

// ── Case 1: Sibling challenge ─────────────────────────────────────────────────
// 입력: plan-1, challenge-1(→plan-1), impl-1(→plan-1)  [review 없음]
// 기대: gate1 미삽입, impl-1이 challenge-1을 통해 흐름, challenge 총 1개
describe("Case 1 — Sibling challenge (gate1 미삽입, impl rewire)", () => {
	it("gate1 미삽입, impl-1 → challenge-1 rewire, challenge=1", () => {
		const plan1 = makeNode({ id: "plan-1", purpose: "plan" });
		const challenge1 = makeNode({ id: "challenge-1", purpose: "challenge", dependsOn: ["plan-1"] });
		// impl-1은 plan-1에 직접 의존 (sibling challenge가 있음)
		const impl1 = makeNode({ id: "impl-1", purpose: "implement", dependsOn: ["plan-1"] });

		const bp = makeBp([plan1, challenge1, impl1]);
		injectChallengerGates(bp);

		// gate1 미삽입: challenge-gate1 없음
		expect(bp.nodes.find((n) => n.id === "challenge-gate1")).toBeUndefined();

		// impl-1.dependsOn이 challenge-1로 rewire됨
		const impl = bp.nodes.find((n) => n.id === "impl-1")!;
		expect(impl.dependsOn).toContain("challenge-1");
		expect(impl.dependsOn).not.toContain("plan-1");

		// 총 challenge 수 = 1 (gate2 없음: review 노드가 없어 gate2 트리거 안 됨)
		expect(bp.nodes.filter((n) => n.purpose === "challenge").length).toBe(1);
	});

	it("[보완] sibling + review-1 있으면 gate2는 정상 삽입됨, challenge=2", () => {
		// sibling challenge가 gate1을 커버해도, impl→review는 별도이므로 gate2 삽입이 맞음
		const plan1 = makeNode({ id: "plan-1", purpose: "plan" });
		const challenge1 = makeNode({ id: "challenge-1", purpose: "challenge", dependsOn: ["plan-1"] });
		const impl1 = makeNode({ id: "impl-1", purpose: "implement", dependsOn: ["plan-1"] });
		const review1 = makeNode({ id: "review-1", purpose: "review", dependsOn: ["impl-1"] });

		const bp = makeBp([plan1, challenge1, impl1, review1]);
		injectChallengerGates(bp);

		// gate1은 여전히 미삽입
		expect(bp.nodes.find((n) => n.id === "challenge-gate1")).toBeUndefined();
		// impl-1은 challenge-1로 rewire
		const impl = bp.nodes.find((n) => n.id === "impl-1")!;
		expect(impl.dependsOn).toContain("challenge-1");
		// gate2는 삽입됨 (impl→review 미커버)
		expect(bp.nodes.find((n) => n.id === "challenge-gate2")).toBeDefined();
		// review-1은 gate2로 rewire
		const review = bp.nodes.find((n) => n.id === "review-1")!;
		expect(review.dependsOn).toContain("challenge-gate2");
		expect(review.dependsOn).not.toContain("impl-1");
		// 총 challenge = 2
		expect(bp.nodes.filter((n) => n.purpose === "challenge").length).toBe(2);
	});
});

// ── Case 2: chainFrom 정규화 트리거 ───────────────────────────────────────────
// 입력: plan-1, impl-1(→plan-1, chainFrom:plan-1), review-1(→impl-1)
// 기대: gate1 삽입, impl-1.dependsOn & chainFrom 모두 gate1으로 갱신
describe("Case 2 — chainFrom 정규화 (gate1 삽입 시 chainFrom도 갱신)", () => {
	it("impl-1.chainFrom이 plan-1이면 gate1 삽입 후 dependsOn·chainFrom 모두 challenge-gate1로 갱신", () => {
		const plan1 = makeNode({ id: "plan-1", purpose: "plan" });
		const impl1 = makeNode({
			id: "impl-1",
			purpose: "implement",
			dependsOn: ["plan-1"],
			chainFrom: "plan-1",
		});
		const review1 = makeNode({ id: "review-1", purpose: "review", dependsOn: ["impl-1"] });

		const bp = makeBp([plan1, impl1, review1]);
		injectChallengerGates(bp);

		// gate1이 삽입됨
		expect(bp.nodes.find((n) => n.id === "challenge-gate1")).toBeDefined();

		// impl-1.dependsOn과 chainFrom이 gate1으로 갱신됨
		const impl = bp.nodes.find((n) => n.id === "impl-1")!;
		expect(impl.dependsOn).toContain("challenge-gate1");
		expect(impl.dependsOn).not.toContain("plan-1");
		expect(impl.chainFrom).toBe("challenge-gate1");
	});
});

// ── Case 3: Gate 1 기본 삽입 ─────────────────────────────────────────────────
// 입력: plan-1, impl-1(→plan-1), review-1(→impl-1)
// 기대: challenge-gate1 삽입, plan-1 → gate1 → impl-1 순서
describe("Case 3 — Gate 1 기본 삽입 (plan→impl, 기존 challenge 없음)", () => {
	it("challenge-gate1이 삽입되고 plan-1 → gate1 → impl-1 순서가 된다", () => {
		const plan1 = makeNode({ id: "plan-1", purpose: "plan" });
		const impl1 = makeNode({ id: "impl-1", purpose: "implement", dependsOn: ["plan-1"] });
		const review1 = makeNode({ id: "review-1", purpose: "review", dependsOn: ["impl-1"] });

		const bp = makeBp([plan1, impl1, review1]);
		injectChallengerGates(bp);

		const gate1 = bp.nodes.find((n) => n.id === "challenge-gate1");
		expect(gate1).toBeDefined();
		expect(gate1!.dependsOn).toContain("plan-1");

		const impl = bp.nodes.find((n) => n.id === "impl-1")!;
		expect(impl.dependsOn).toContain("challenge-gate1");
		expect(impl.dependsOn).not.toContain("plan-1");
	});
});

// ── Case 4: Gate 2 기본 삽입 ─────────────────────────────────────────────────
// 입력: impl-1, extra-1(explore), review-1(→impl-1)  [plan 없음]
// 기대: challenge-gate2 삽입, impl-1 → gate2 → review-1 순서
describe("Case 4 — Gate 2 기본 삽입 (impl→review, challenge 없음)", () => {
	it("challenge-gate2가 삽입되고 impl-1 → gate2 → review-1 순서가 된다", () => {
		// plan 없이 impl→review만 있는 케이스 (nodes >= 3 조건 충족)
		const impl1 = makeNode({ id: "impl-1", purpose: "implement" });
		const extra = makeNode({ id: "extra-1", purpose: "explore" });
		const review1 = makeNode({ id: "review-1", purpose: "review", dependsOn: ["impl-1"] });

		const bp = makeBp([impl1, extra, review1]);
		injectChallengerGates(bp);

		const gate2 = bp.nodes.find((n) => n.id === "challenge-gate2");
		expect(gate2).toBeDefined();
		expect(gate2!.dependsOn).toContain("impl-1");

		const review = bp.nodes.find((n) => n.id === "review-1")!;
		expect(review.dependsOn).toContain("challenge-gate2");
		expect(review.dependsOn).not.toContain("impl-1");
	});
});

// ── Case 5: existingChallengeCount >= 2 → 전체 skip ─────────────────────────
// 입력: plan-1, ch-1(→plan-1), ch-2(→plan-1), impl-1(→plan-1), review-1(→impl-1)
// 기대: challenge 수 변화 없음, gate 삽입 안 됨
describe("Case 5 — 기존 challenge 2개 이상 → 게이트 삽입 안 함", () => {
	it("이미 challenge 2개이면 어떤 게이트도 추가되지 않는다", () => {
		const plan1 = makeNode({ id: "plan-1", purpose: "plan" });
		const ch1 = makeNode({ id: "ch-1", purpose: "challenge", dependsOn: ["plan-1"] });
		const ch2 = makeNode({ id: "ch-2", purpose: "challenge", dependsOn: ["plan-1"] });
		const impl1 = makeNode({ id: "impl-1", purpose: "implement", dependsOn: ["plan-1"] });
		const review1 = makeNode({ id: "review-1", purpose: "review", dependsOn: ["impl-1"] });

		const bp = makeBp([plan1, ch1, ch2, impl1, review1]);
		const beforeCount = bp.nodes.length;
		injectChallengerGates(bp);

		// 노드 수 변화 없음 (gate 삽입 안 됨)
		expect(bp.nodes.length).toBe(beforeCount);
		expect(bp.nodes.find((n) => n.id === "challenge-gate1")).toBeUndefined();
		expect(bp.nodes.find((n) => n.id === "challenge-gate2")).toBeUndefined();
	});
});
