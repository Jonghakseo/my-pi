import { describe, expect, it } from "vitest";
import {
	buildHandoffPrompt,
	buildSpecSnapshot,
	computeAmbiguityScore,
	type DeepInterviewDraft,
	sanitizeListInput,
} from "./deep-interview-utils.ts";

describe("sanitizeListInput", () => {
	it("parses bullet/newline/comma inputs and deduplicates", () => {
		const raw = "- 브라우저 E2E 통과\n- 롤백 가능\n에러 로그 남기기, 브라우저 E2E 통과";
		const items = sanitizeListInput(raw);
		expect(items).toEqual(["브라우저 E2E 통과", "롤백 가능", "에러 로그 남기기"]);
	});

	it("returns empty array for empty input", () => {
		expect(sanitizeListInput(undefined)).toEqual([]);
		expect(sanitizeListInput("")).toEqual([]);
	});
});

describe("computeAmbiguityScore", () => {
	it("returns ready=true for a well-specified draft", () => {
		const draft: DeepInterviewDraft = {
			goal: "결제 장애 재발 방지를 위해 결제 승인 파이프라인에 재시도와 경고 알림을 구현한다",
			constraints: ["기존 DB 스키마는 변경하지 않는다", "배포 중 다운타임은 0초", "로그 포맷은 기존 규약 유지"],
			acceptanceCriteria: [
				"결제 API 타임아웃 발생 시 최대 2회 retry 후 실패 응답을 반환한다",
				"오류 발생 시 alert 채널에 1분 이내 알림이 전송된다",
				"성공/실패 케이스 자동 테스트가 CI에서 통과한다",
				"롤백 플래그로 기능을 즉시 비활성화할 수 있다",
			],
			outOfScope: ["신규 결제 수단 추가", "관리자 대시보드 UI 개편"],
			risks: ["외부 PG 응답 지연", "알림 채널 rate limit"],
		};

		const result = computeAmbiguityScore(draft);
		expect(result.readyForExecution).toBe(true);
		expect(result.ambiguityScore).toBeLessThanOrEqual(0.2);
		expect(result.missingFields).toHaveLength(0);
	});

	it("returns ready=false for sparse draft", () => {
		const draft: DeepInterviewDraft = {
			goal: "좋게 만들자",
			constraints: [],
			acceptanceCriteria: [],
			outOfScope: [],
			risks: [],
		};

		const result = computeAmbiguityScore(draft);
		expect(result.readyForExecution).toBe(false);
		expect(result.ambiguityScore).toBeGreaterThan(0.2);
		expect(result.missingFields).toContain("constraints");
		expect(result.missingFields).toContain("acceptanceCriteria");
	});
});

describe("buildSpecSnapshot", () => {
	it("keeps forced snapshot not-ready even when score is ready", () => {
		const draft: DeepInterviewDraft = {
			goal: "배포 체크리스트 자동화 도구를 구현한다",
			constraints: ["기존 릴리즈 파이프라인 유지", "CLI 인터페이스 유지"],
			acceptanceCriteria: ["체크 실패 시 exit code 1 반환", "성공 시 결과 요약 출력", "CI에서 테스트 통과"],
			outOfScope: ["UI 대시보드"],
			risks: ["오탐(false positive)"],
		};
		const score = computeAmbiguityScore(draft);
		const now = new Date("2026-03-05T00:00:00.000Z");

		const spec = buildSpecSnapshot({
			draft,
			score,
			specVersion: 3,
			forced: true,
			now,
			specId: "di-fixed-id",
		});

		expect(spec.specId).toBe("di-fixed-id");
		expect(spec.specVersion).toBe(3);
		expect(spec.forced).toBe(true);
		expect(spec.readyForExecution).toBe(false);
		expect(spec.createdAt).toBe("2026-03-05T00:00:00.000Z");
		expect(spec.frozenAt).toBe("2026-03-05T00:00:00.000Z");
	});
});

describe("buildHandoffPrompt", () => {
	it("contains authoritative request format and key sections", () => {
		const score = computeAmbiguityScore({
			goal: "로그 수집 지연 문제를 줄인다",
			constraints: ["운영 중단 금지", "비용 증가 10% 이내"],
			acceptanceCriteria: ["p95 지연이 2초 이하", "실패율 1% 이하", "테스트 통과"],
			outOfScope: ["UI 리디자인"],
			risks: ["외부 API 지연"],
		});

		const spec = buildSpecSnapshot({
			draft: {
				goal: "로그 수집 지연 문제를 줄인다",
				constraints: ["운영 중단 금지", "비용 증가 10% 이내"],
				acceptanceCriteria: ["p95 지연이 2초 이하", "실패율 1% 이하", "테스트 통과"],
				outOfScope: ["UI 리디자인"],
				risks: ["외부 API 지연"],
			},
			score,
			specVersion: 1,
			specId: "di-handoff",
			now: new Date("2026-03-05T00:00:00.000Z"),
		});

		const handoff = buildHandoffPrompt(spec);
		expect(handoff).toContain("[REQUEST — AUTHORITATIVE]");
		expect(handoff).toContain("## Constraints");
		expect(handoff).toContain("## Acceptance Criteria");
		expect(handoff).toContain("## Out of Scope");
		expect(handoff).toContain("## Risks");
		expect(handoff).toContain("spec_id: di-handoff");
	});
});
