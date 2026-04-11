import { describe, expect, it } from "vitest";
import {
	diffIcon,
	diffStatusColor,
	mapCheckStateFromCheckRun,
	mapCheckStateFromStatusContext,
	mapDiffStatusCode,
	parseGitStatusPorcelainV2,
	parseStatus,
	renderPlainSummary,
	summarizeChecks,
} from "./git-utils.js";

// ─── parseGitStatusPorcelainV2 ───────────────────────────────────────────

describe("parseGitStatusPorcelainV2", () => {
	it("parses ahead/behind tracking metadata from porcelain v2 branch headers", () => {
		const result = parseGitStatusPorcelainV2(
			[
				"# branch.oid 0123456789abcdef",
				"# branch.head main",
				"# branch.upstream origin/main",
				"# branch.ab +2 -3",
			].join("\n"),
		);

		expect(result).toEqual({
			head: "main",
			upstream: "origin/main",
			ahead: 2,
			behind: 3,
			isDetached: false,
			isDirty: false,
		});
	});

	it("marks tracked and untracked entries as dirty", () => {
		const result = parseGitStatusPorcelainV2(
			[
				"# branch.oid fedcba9876543210",
				"# branch.head feature/footer",
				"# branch.upstream origin/feature/footer",
				"# branch.ab +1 -0",
				"1 .M N... 100644 100644 100644 1234567 1234567 footer.ts",
				"? new-file.ts",
			].join("\n"),
		);

		expect(result).toEqual({
			head: "feature/footer",
			upstream: "origin/feature/footer",
			ahead: 1,
			behind: 0,
			isDetached: false,
			isDirty: true,
		});
	});

	it("handles detached heads without upstream tracking", () => {
		const result = parseGitStatusPorcelainV2(
			["# branch.oid 89abcdef01234567", "# branch.head (detached)", "! node_modules/"].join("\n"),
		);

		expect(result).toEqual({
			head: null,
			upstream: null,
			ahead: 0,
			behind: 0,
			isDetached: true,
			isDirty: false,
		});
	});
});

// ─── mapDiffStatusCode ──────────────────────────────────────────────────

describe("mapDiffStatusCode", () => {
	it("maps A to added", () => {
		expect(mapDiffStatusCode("A")).toBe("added");
	});

	it("maps D to deleted", () => {
		expect(mapDiffStatusCode("D")).toBe("deleted");
	});

	it("maps R to renamed", () => {
		expect(mapDiffStatusCode("R100")).toBe("renamed");
	});

	it("maps C to copied", () => {
		expect(mapDiffStatusCode("C")).toBe("copied");
	});

	it("maps M to modified", () => {
		expect(mapDiffStatusCode("M")).toBe("modified");
	});

	it("maps unknown to modified", () => {
		expect(mapDiffStatusCode("X")).toBe("modified");
	});

	it("maps empty string to modified", () => {
		expect(mapDiffStatusCode("")).toBe("modified");
	});
});

// ─── parseStatus ────────────────────────────────────────────────────────

describe("parseStatus", () => {
	it("parses ?? as untracked", () => {
		expect(parseStatus("??")).toBe("untracked");
	});

	it("parses A  as added (first char)", () => {
		expect(parseStatus("A ")).toBe("added");
	});

	it("parses  M as modified (second char)", () => {
		expect(parseStatus(" M")).toBe("modified");
	});

	it("parses  D as deleted (second char)", () => {
		expect(parseStatus(" D")).toBe("deleted");
	});

	it("parses R  as renamed (first char)", () => {
		expect(parseStatus("R ")).toBe("renamed");
	});

	it("parses MM as modified (second char takes priority)", () => {
		expect(parseStatus("MM")).toBe("modified");
	});

	it("parses AD as deleted (second char)", () => {
		expect(parseStatus("AD")).toBe("deleted");
	});
});

// ─── diffIcon ───────────────────────────────────────────────────────────

describe("diffIcon", () => {
	it("added returns +", () => {
		expect(diffIcon("added")).toBe("+");
	});

	it("untracked returns +", () => {
		expect(diffIcon("untracked")).toBe("+");
	});

	it("deleted returns -", () => {
		expect(diffIcon("deleted")).toBe("-");
	});

	it("renamed returns →", () => {
		expect(diffIcon("renamed")).toBe("→");
	});

	it("copied returns ©", () => {
		expect(diffIcon("copied")).toBe("©");
	});

	it("modified returns ~", () => {
		expect(diffIcon("modified")).toBe("~");
	});
});

// ─── diffStatusColor ────────────────────────────────────────────────────

describe("diffStatusColor", () => {
	it("added is success", () => {
		expect(diffStatusColor("added")).toBe("success");
	});

	it("untracked is success", () => {
		expect(diffStatusColor("untracked")).toBe("success");
	});

	it("deleted is error", () => {
		expect(diffStatusColor("deleted")).toBe("error");
	});

	it("modified is warning", () => {
		expect(diffStatusColor("modified")).toBe("warning");
	});

	it("renamed is warning", () => {
		expect(diffStatusColor("renamed")).toBe("warning");
	});
});

// ─── mapCheckStateFromCheckRun ──────────────────────────────────────────

describe("mapCheckStateFromCheckRun", () => {
	it("pending when status is not COMPLETED", () => {
		expect(mapCheckStateFromCheckRun("IN_PROGRESS", "")).toBe("pending");
	});

	it("success for SUCCESS conclusion", () => {
		expect(mapCheckStateFromCheckRun("COMPLETED", "SUCCESS")).toBe("success");
	});

	it("success for NEUTRAL conclusion", () => {
		expect(mapCheckStateFromCheckRun("COMPLETED", "NEUTRAL")).toBe("success");
	});

	it("failed for FAILURE conclusion", () => {
		expect(mapCheckStateFromCheckRun("COMPLETED", "FAILURE")).toBe("failed");
	});

	it("failed for TIMED_OUT conclusion", () => {
		expect(mapCheckStateFromCheckRun("COMPLETED", "TIMED_OUT")).toBe("failed");
	});

	it("failed for CANCELLED conclusion", () => {
		expect(mapCheckStateFromCheckRun("COMPLETED", "CANCELLED")).toBe("failed");
	});

	it("pending when no conclusion", () => {
		expect(mapCheckStateFromCheckRun("COMPLETED", "")).toBe("pending");
	});

	it("neutral for unknown conclusion", () => {
		expect(mapCheckStateFromCheckRun("COMPLETED", "STALE")).toBe("neutral");
	});

	it("pending for empty status", () => {
		expect(mapCheckStateFromCheckRun("", "")).toBe("pending");
	});
});

// ─── mapCheckStateFromStatusContext ──────────────────────────────────────

describe("mapCheckStateFromStatusContext", () => {
	it("success for SUCCESS", () => {
		expect(mapCheckStateFromStatusContext("SUCCESS")).toBe("success");
	});

	it("failed for FAILURE", () => {
		expect(mapCheckStateFromStatusContext("FAILURE")).toBe("failed");
	});

	it("failed for ERROR", () => {
		expect(mapCheckStateFromStatusContext("ERROR")).toBe("failed");
	});

	it("pending for PENDING", () => {
		expect(mapCheckStateFromStatusContext("PENDING")).toBe("pending");
	});

	it("pending for EXPECTED", () => {
		expect(mapCheckStateFromStatusContext("EXPECTED")).toBe("pending");
	});

	it("neutral for unknown", () => {
		expect(mapCheckStateFromStatusContext("UNKNOWN")).toBe("neutral");
	});
});

// ─── summarizeChecks ────────────────────────────────────────────────────

describe("summarizeChecks", () => {
	it("empty checks", () => {
		expect(summarizeChecks([])).toEqual({
			total: 0,
			success: 0,
			failed: 0,
			pending: 0,
			neutral: 0,
		});
	});

	it("counts by state", () => {
		const checks = [
			{ name: "a", kind: "check-run" as const, state: "success" as const, detail: "", url: null },
			{ name: "b", kind: "check-run" as const, state: "success" as const, detail: "", url: null },
			{ name: "c", kind: "check-run" as const, state: "failed" as const, detail: "", url: null },
			{ name: "d", kind: "status-context" as const, state: "pending" as const, detail: "", url: null },
		];
		const result = summarizeChecks(checks);
		expect(result.total).toBe(4);
		expect(result.success).toBe(2);
		expect(result.failed).toBe(1);
		expect(result.pending).toBe(1);
		expect(result.neutral).toBe(0);
	});
});

// ─── renderPlainSummary ─────────────────────────────────────────────────

describe("renderPlainSummary", () => {
	it("returns error message when error", () => {
		const result = renderPlainSummary({ data: null, error: "Not found", warnings: [] });
		expect(result).toContain("Not found");
	});

	it("returns no-data message when null", () => {
		const result = renderPlainSummary({ data: null, error: null, warnings: [] });
		expect(result).toContain("표시할 GitHub PR 데이터");
	});

	it("renders full summary", () => {
		const result = renderPlainSummary({
			data: {
				repo: "owner/repo",
				pr: {
					number: 42,
					title: "Test PR",
					url: "https://github.com/owner/repo/pull/42",
					state: "OPEN",
					isDraft: false,
					reviewDecision: "REVIEW_REQUIRED",
					mergeStateStatus: "BLOCKED",
					headRefName: "feature",
					baseRefName: "main",
					labels: ["bug"],
					requestedReviewers: ["@reviewer"],
				},
				checkSummary: { total: 3, success: 2, failed: 1, pending: 0, neutral: 0 },
				generalComments: [{}],
				totalThreads: 2,
				totalInlineComments: 5,
			},
			error: null,
			warnings: ["some warning"],
		});
		expect(result).toContain("owner/repo");
		expect(result).toContain("PR #42");
		expect(result).toContain("Test PR");
		expect(result).toContain("bug");
		expect(result).toContain("@reviewer");
		expect(result).toContain("total=3");
		expect(result).toContain("general comments: 1");
		expect(result).toContain("inline threads: 2");
		expect(result).toContain("some warning");
	});

	it("shows (draft) for draft PRs", () => {
		const result = renderPlainSummary({
			data: {
				repo: "o/r",
				pr: {
					number: 1,
					title: "Draft",
					state: "OPEN",
					isDraft: true,
					reviewDecision: "",
					mergeStateStatus: "",
					headRefName: "a",
					baseRefName: "b",
					labels: [],
					requestedReviewers: [],
				},
				checkSummary: { total: 0, success: 0, failed: 0, pending: 0, neutral: 0 },
				generalComments: [],
				totalThreads: 0,
				totalInlineComments: 0,
			},
			error: null,
			warnings: [],
		});
		expect(result).toContain("(draft)");
	});
});
