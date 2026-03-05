import { describe, expect, it } from "vitest";
import {
	commitStateBadge,
	mapDiffStatusCode,
	mergeDiffEntries,
	parseGitLogOutput,
	parseNameStatusZ,
	parsePorcelainStatusZ,
	parseStatus,
	toggleOverlayViewMode,
} from "./diff-overlay-utils.js";

describe("mapDiffStatusCode", () => {
	it("maps core git statuses", () => {
		expect(mapDiffStatusCode("A")).toBe("added");
		expect(mapDiffStatusCode("D")).toBe("deleted");
		expect(mapDiffStatusCode("R100")).toBe("renamed");
		expect(mapDiffStatusCode("C95")).toBe("copied");
		expect(mapDiffStatusCode("M")).toBe("modified");
	});

	it("falls back to modified for unknown codes", () => {
		expect(mapDiffStatusCode("")).toBe("modified");
		expect(mapDiffStatusCode("X")).toBe("modified");
	});
});

describe("parseStatus", () => {
	it("parses porcelain 2-char state", () => {
		expect(parseStatus("??")).toBe("untracked");
		expect(parseStatus("A ")).toBe("added");
		expect(parseStatus(" D")).toBe("deleted");
		expect(parseStatus("R ")).toBe("renamed");
		expect(parseStatus("C ")).toBe("copied");
		expect(parseStatus("MM")).toBe("modified");
	});
});

describe("parseNameStatusZ", () => {
	it("parses normal + rename entries", () => {
		const stdout = ["M", "src/a.ts", "R100", "src/old.ts", "src/new.ts"].join("\0") + "\0";
		const parsed = parseNameStatusZ(stdout);
		expect(parsed).toEqual([
			{ path: "src/a.ts", status: "modified", rawStatus: "M" },
			{ path: "src/new.ts", status: "renamed", rawStatus: "R100" },
		]);
	});

	it("returns empty array on empty input", () => {
		expect(parseNameStatusZ("")).toEqual([]);
	});
});

describe("parsePorcelainStatusZ", () => {
	it("parses tracked + untracked + rename entries", () => {
		const stdout = [" M src/a.ts", "?? src/new.ts", "R  src/old.ts", "src/new-name.ts"].join("\0") + "\0";
		const parsed = parsePorcelainStatusZ(stdout);
		expect(parsed).toEqual([
			{ path: "src/a.ts", status: "modified", rawStatus: "M" },
			{ path: "src/new.ts", status: "untracked", rawStatus: "??" },
			{ path: "src/new-name.ts", status: "renamed", rawStatus: "R" },
		]);
	});

	it("returns empty array on empty input", () => {
		expect(parsePorcelainStatusZ("")).toEqual([]);
	});
});

describe("mergeDiffEntries", () => {
	it("builds commit-state for committed-only / working-only / both", () => {
		const merged = mergeDiffEntries(
			[
				{ path: "a.ts", status: "modified", rawStatus: "M" },
				{ path: "c.ts", status: "added", rawStatus: "A" },
			],
			[
				{ path: "b.ts", status: "untracked", rawStatus: "??" },
				{ path: "c.ts", status: "modified", rawStatus: "M" },
			],
		);

		expect(merged).toEqual([
			{ path: "a.ts", status: "modified", rawStatus: "M", commitState: "committed" },
			{ path: "c.ts", status: "modified", rawStatus: "M", commitState: "both" },
			{ path: "b.ts", status: "untracked", rawStatus: "??", commitState: "uncommitted" },
		]);
	});

	it("prefers working entry for display status/rawStatus when both exist", () => {
		const merged = mergeDiffEntries(
			[{ path: "a.ts", status: "added", rawStatus: "A" }],
			[{ path: "a.ts", status: "deleted", rawStatus: "D" }],
		);
		expect(merged).toEqual([{ path: "a.ts", status: "deleted", rawStatus: "D", commitState: "both" }]);
	});
});

describe("commitStateBadge", () => {
	it("returns compact badges", () => {
		expect(commitStateBadge("committed")).toBe("C");
		expect(commitStateBadge("uncommitted")).toBe("W");
		expect(commitStateBadge("both")).toBe("C+W");
	});
});

describe("toggleOverlayViewMode", () => {
	it("toggles diff and commit", () => {
		expect(toggleOverlayViewMode("diff")).toBe("commit");
		expect(toggleOverlayViewMode("commit")).toBe("diff");
	});
});

describe("parseGitLogOutput", () => {
	it("parses pretty-formatted git log rows", () => {
		const stdout =
			"abc123\x1fabc123\x1fAlice\x1f2 hours ago\x1ffeat: add overlay\x1e" +
			"def456\x1fdef456\x1fBob\x1f1 day ago\x1ffix: tests\x1e";
		const parsed = parseGitLogOutput(stdout);
		expect(parsed).toEqual([
			{
				hash: "abc123",
				shortHash: "abc123",
				author: "Alice",
				relativeDate: "2 hours ago",
				subject: "feat: add overlay",
			},
			{
				hash: "def456",
				shortHash: "def456",
				author: "Bob",
				relativeDate: "1 day ago",
				subject: "fix: tests",
			},
		]);
	});

	it("ignores malformed rows", () => {
		const parsed = parseGitLogOutput("\x1f\x1f\x1f\x1f\x1e");
		expect(parsed).toEqual([]);
	});
});
