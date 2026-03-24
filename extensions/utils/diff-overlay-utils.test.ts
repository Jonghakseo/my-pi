import { describe, expect, it } from "vitest";
import {
	applyHighlightToDiff,
	buildFileTree,
	collapseFileTree,
	collectAllDirPaths,
	commitStateBadge,
	extractCodeBlock,
	flattenVisibleTree,
	mapDiffStatusCode,
	mergeDiffEntries,
	parseDiffLines,
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
		const stdout = `${["M", "src/a.ts", "R100", "src/old.ts", "src/new.ts"].join("\0")}\0`;
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
		// porcelain -z format: rename is "XY <newPath>\0<oldPath>\0"
		const stdout = `${[" M src/a.ts", "?? src/new.ts", "R  src/new-name.ts", "src/old.ts"].join("\0")}\0`;
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

// ─── File Tree ─────────────────────────────────────────────────────────────

describe("buildFileTree", () => {
	it("builds tree from flat paths — dirs first, files at root level", () => {
		const tree = buildFileTree(["src/a.ts", "src/b.ts", "README.md"]);
		expect(tree).toEqual([
			{
				type: "dir",
				name: "src",
				fullPath: "src",
				children: [
					{ type: "file", name: "a.ts", fullPath: "src/a.ts" },
					{ type: "file", name: "b.ts", fullPath: "src/b.ts" },
				],
			},
			{ type: "file", name: "README.md", fullPath: "README.md" },
		]);
	});

	it("handles deeply nested paths", () => {
		const tree = buildFileTree(["a/b/c/d.ts"]);
		expect(tree).toEqual([
			{
				type: "dir",
				name: "a",
				fullPath: "a",
				children: [
					{
						type: "dir",
						name: "b",
						fullPath: "a/b",
						children: [
							{
								type: "dir",
								name: "c",
								fullPath: "a/b/c",
								children: [{ type: "file", name: "d.ts", fullPath: "a/b/c/d.ts" }],
							},
						],
					},
				],
			},
		]);
	});

	it("returns empty array for no paths", () => {
		expect(buildFileTree([])).toEqual([]);
	});

	it("sorts directories alphabetically before files", () => {
		const tree = buildFileTree(["z.ts", "a/x.ts", "m/y.ts"]);
		expect(tree.map((n) => n.name)).toEqual(["a", "m", "z.ts"]);
	});
});

describe("collapseFileTree", () => {
	it("collapses single-child directory chains", () => {
		const tree = buildFileTree(["src/components/Button.tsx"]);
		const collapsed = collapseFileTree(tree);
		expect(collapsed).toEqual([
			{
				type: "dir",
				name: "src/components",
				fullPath: "src/components",
				children: [{ type: "file", name: "Button.tsx", fullPath: "src/components/Button.tsx" }],
			},
		]);
	});

	it("does NOT collapse when dir has multiple children", () => {
		const tree = buildFileTree(["src/a.ts", "src/b.ts"]);
		const collapsed = collapseFileTree(tree);
		expect(collapsed).toEqual([
			{
				type: "dir",
				name: "src",
				fullPath: "src",
				children: [
					{ type: "file", name: "a.ts", fullPath: "src/a.ts" },
					{ type: "file", name: "b.ts", fullPath: "src/b.ts" },
				],
			},
		]);
	});

	it("does NOT collapse when single child is a file", () => {
		const tree = buildFileTree(["src/only.ts"]);
		const collapsed = collapseFileTree(tree);
		expect(collapsed).toEqual([
			{
				type: "dir",
				name: "src",
				fullPath: "src",
				children: [{ type: "file", name: "only.ts", fullPath: "src/only.ts" }],
			},
		]);
	});

	it("collapses deeply nested single-child chains", () => {
		const tree = buildFileTree(["a/b/c/d/file.ts"]);
		const collapsed = collapseFileTree(tree);
		expect(collapsed).toEqual([
			{
				type: "dir",
				name: "a/b/c/d",
				fullPath: "a/b/c/d",
				children: [{ type: "file", name: "file.ts", fullPath: "a/b/c/d/file.ts" }],
			},
		]);
	});
});

describe("flattenVisibleTree", () => {
	it("shows all rows when all dirs expanded", () => {
		const tree = collapseFileTree(buildFileTree(["src/a.ts", "src/b.ts", "README.md"]));
		const rows = flattenVisibleTree(tree, new Set(["src"]));
		expect(rows).toEqual([
			{ type: "dir", depth: 0, fullPath: "src", name: "src", expanded: true },
			{ type: "file", depth: 1, fullPath: "src/a.ts", name: "a.ts" },
			{ type: "file", depth: 1, fullPath: "src/b.ts", name: "b.ts" },
			{ type: "file", depth: 0, fullPath: "README.md", name: "README.md" },
		]);
	});

	it("hides children when dir collapsed", () => {
		const tree = collapseFileTree(buildFileTree(["src/a.ts", "README.md"]));
		const rows = flattenVisibleTree(tree, new Set());
		expect(rows).toEqual([
			{ type: "dir", depth: 0, fullPath: "src", name: "src", expanded: false },
			{ type: "file", depth: 0, fullPath: "README.md", name: "README.md" },
		]);
	});

	it("handles nested expanded dirs with proper depth", () => {
		const tree = collapseFileTree(buildFileTree(["a/b/x.ts", "a/b/y.ts", "a/c.ts"]));
		// After collapse: a (has 2 children: dir "b", file "c.ts") — no collapse
		const rows = flattenVisibleTree(tree, new Set(["a", "a/b"]));
		expect(rows).toEqual([
			{ type: "dir", depth: 0, fullPath: "a", name: "a", expanded: true },
			{ type: "dir", depth: 1, fullPath: "a/b", name: "b", expanded: true },
			{ type: "file", depth: 2, fullPath: "a/b/x.ts", name: "x.ts" },
			{ type: "file", depth: 2, fullPath: "a/b/y.ts", name: "y.ts" },
			{ type: "file", depth: 1, fullPath: "a/c.ts", name: "c.ts" },
		]);
	});
});

describe("collectAllDirPaths", () => {
	it("returns all directory fullPaths", () => {
		const tree = buildFileTree(["a/b/c.ts", "a/d.ts", "e/f.ts"]);
		const paths = collectAllDirPaths(tree);
		expect(paths.sort()).toEqual(["a", "a/b", "e"].sort());
	});

	it("returns empty for file-only tree", () => {
		expect(collectAllDirPaths(buildFileTree(["file.ts"]))).toEqual([]);
	});
});

// ─── Diff Syntax Highlight Utilities ───────────────────────────────────────

const SAMPLE_DIFF = [
	"diff --git a/src/foo.ts b/src/foo.ts",
	"index abc123..def456 100644",
	"--- a/src/foo.ts",
	"+++ b/src/foo.ts",
	"@@ -10,5 +10,6 @@ function hello() {",
	"   const a = 1;",
	"-  const b = 2;",
	"+  const b = 3;",
	"+  const c = 4;",
	"   return a + b;",
	" }",
].join("\n");

describe("parseDiffLines", () => {
	it("categorizes meta, hunk, and code lines in a normal diff", () => {
		const parsed = parseDiffLines(SAMPLE_DIFF);

		expect(parsed[0]).toEqual({
			category: "meta",
			prefix: "",
			code: "",
			originalLine: "diff --git a/src/foo.ts b/src/foo.ts",
		});
		expect(parsed[1]).toEqual({
			category: "meta",
			prefix: "",
			code: "",
			originalLine: "index abc123..def456 100644",
		});
		expect(parsed[2]).toEqual({
			category: "meta",
			prefix: "",
			code: "",
			originalLine: "--- a/src/foo.ts",
		});
		expect(parsed[3]).toEqual({
			category: "meta",
			prefix: "",
			code: "",
			originalLine: "+++ b/src/foo.ts",
		});
		expect(parsed[4]).toEqual({
			category: "hunk",
			prefix: "",
			code: "",
			originalLine: "@@ -10,5 +10,6 @@ function hello() {",
		});
	});

	it("categorizes added/removed/context lines within hunks", () => {
		const parsed = parseDiffLines(SAMPLE_DIFF);

		// "   const a = 1;" — context
		expect(parsed[5]).toEqual({
			category: "context",
			prefix: " ",
			code: "  const a = 1;",
			originalLine: "   const a = 1;",
		});
		// "-  const b = 2;" — removed
		expect(parsed[6]).toEqual({
			category: "removed",
			prefix: "-",
			code: "  const b = 2;",
			originalLine: "-  const b = 2;",
		});
		// "+  const b = 3;" — added
		expect(parsed[7]).toEqual({
			category: "added",
			prefix: "+",
			code: "  const b = 3;",
			originalLine: "+  const b = 3;",
		});
	});

	it("treats --- and +++ inside hunk as removed/added (not meta)", () => {
		const diff = ["diff --git a/x b/x", "--- a/x", "+++ b/x", "@@ -1,2 +1,2 @@", "----", "++++"].join("\n");
		const parsed = parseDiffLines(diff);

		// Inside hunk: "----" starts with "-" → removed, code is "---"
		expect(parsed[4]).toEqual({ category: "removed", prefix: "-", code: "---", originalLine: "----" });
		// "++++" starts with "+" → added, code is "+++"
		expect(parsed[5]).toEqual({ category: "added", prefix: "+", code: "+++", originalLine: "++++" });
	});

	it("handles untracked file (no diff header, all + lines)", () => {
		const raw = ["+ const x = 1;", "+ const y = 2;"].join("\n");
		const parsed = parseDiffLines(raw);

		// No "diff " header → inHunk starts true
		expect(parsed[0]).toEqual({
			category: "added",
			prefix: "+",
			code: " const x = 1;",
			originalLine: "+ const x = 1;",
		});
		expect(parsed[1]).toEqual({
			category: "added",
			prefix: "+",
			code: " const y = 2;",
			originalLine: "+ const y = 2;",
		});
	});

	it("handles '\\No newline at end of file' as meta", () => {
		const diff = [
			"diff --git a/x b/x",
			"--- a/x",
			"+++ b/x",
			"@@ -1 +1 @@",
			"-old",
			"+new",
			"\\ No newline at end of file",
		].join("\n");
		const parsed = parseDiffLines(diff);
		expect(parsed[6].category).toBe("meta");
		expect(parsed[6].originalLine).toBe("\\ No newline at end of file");
	});

	it("handles multi-file diff (resets on new diff --git)", () => {
		const diff = [
			"diff --git a/a.ts b/a.ts",
			"--- a/a.ts",
			"+++ b/a.ts",
			"@@ -1 +1 @@",
			"-old",
			"+new",
			"diff --git a/b.ts b/b.ts",
			"new file mode 100644",
			"--- /dev/null",
			"+++ b/b.ts",
			"@@ -0,0 +1 @@",
			"+hello",
		].join("\n");
		const parsed = parseDiffLines(diff);

		// After second "diff --git", the "new file mode" line should be meta
		expect(parsed[6].category).toBe("meta"); // diff --git a/b.ts
		expect(parsed[7].category).toBe("meta"); // new file mode 100644
		expect(parsed[8].category).toBe("meta"); // --- /dev/null
		expect(parsed[9].category).toBe("meta"); // +++ b/b.ts
		expect(parsed[10].category).toBe("hunk"); // @@ -0,0 +1 @@
		expect(parsed[11]).toEqual({ category: "added", prefix: "+", code: "hello", originalLine: "+hello" });
	});

	it("handles empty diff", () => {
		expect(parseDiffLines("")).toEqual([{ category: "context", prefix: "", code: "", originalLine: "" }]);
	});

	it("handles empty lines within a hunk as context", () => {
		const diff = ["diff --git a/x b/x", "--- a/x", "+++ b/x", "@@ -1,3 +1,3 @@", " a", "", " b"].join("\n");
		const parsed = parseDiffLines(diff);
		expect(parsed[5]).toEqual({ category: "context", prefix: "", code: "", originalLine: "" });
	});
});

describe("extractCodeBlock", () => {
	it("extracts only code lines (added/removed/context), skipping meta and hunk", () => {
		const parsed = parseDiffLines(SAMPLE_DIFF);
		const { code, indices } = extractCodeBlock(parsed);

		const codeLines = code.split("\n");
		expect(codeLines).toEqual([
			"  const a = 1;", // context
			"  const b = 2;", // removed
			"  const b = 3;", // added
			"  const c = 4;", // added
			"  return a + b;", // context
			"}", // context
		]);

		// indices should point to parsed lines 5–10
		expect(indices).toEqual([5, 6, 7, 8, 9, 10]);
	});

	it("returns empty for meta-only diff", () => {
		const parsed = parseDiffLines("diff --git a/x b/x\nindex abc..def 100644");
		const { code, indices } = extractCodeBlock(parsed);
		expect(code).toBe("");
		expect(indices).toEqual([]);
	});

	it("handles untracked file (all added)", () => {
		const parsed = parseDiffLines("+ line1\n+ line2");
		const { code } = extractCodeBlock(parsed);
		expect(code).toBe(" line1\n line2");
	});

	it("preserves order matching parseDiffLines iteration order", () => {
		const diff = ["diff --git a/x b/x", "--- a/x", "+++ b/x", "@@ -1,2 +1,2 @@", "-old", "+new", " ctx"].join("\n");
		const parsed = parseDiffLines(diff);
		const { code, indices } = extractCodeBlock(parsed);

		expect(code.split("\n")).toEqual(["old", "new", "ctx"]);
		expect(indices).toEqual([4, 5, 6]);
	});
});

describe("applyHighlightToDiff", () => {
	// Simple mock helpers
	const metaColor = (line: string) => `[META:${line}]`;
	const hunkColor = (line: string) => `[HUNK:${line}]`;
	const prefixColor = (cat: string, pfx: string) => (pfx ? `[${cat.toUpperCase()}:${pfx}]` : "");

	it("maps highlighted code lines back to correct positions", () => {
		const parsed = parseDiffLines(SAMPLE_DIFF);
		const { code } = extractCodeBlock(parsed);
		// Simulate highlighting by uppercasing each line
		const highlighted = code.split("\n").map((l) => l.toUpperCase());

		const result = applyHighlightToDiff(parsed, highlighted, metaColor, hunkColor, prefixColor);

		// Meta lines
		expect(result[0]).toBe("[META:diff --git a/src/foo.ts b/src/foo.ts]");
		expect(result[1]).toBe("[META:index abc123..def456 100644]");
		expect(result[2]).toBe("[META:--- a/src/foo.ts]");
		expect(result[3]).toBe("[META:+++ b/src/foo.ts]");
		// Hunk header
		expect(result[4]).toBe("[HUNK:@@ -10,5 +10,6 @@ function hello() {]");
		// Code lines: colored prefix + highlighted content
		expect(result[5]).toBe("[CONTEXT: ]  CONST A = 1;"); // context
		expect(result[6]).toBe("[REMOVED:-]  CONST B = 2;"); // removed
		expect(result[7]).toBe("[ADDED:+]  CONST B = 3;"); // added
		expect(result[8]).toBe("[ADDED:+]  CONST C = 4;"); // added
		expect(result[9]).toBe("[CONTEXT: ]  RETURN A + B;"); // context
		expect(result[10]).toBe("[CONTEXT: ]}"); // context
	});

	it("falls back to raw code when highlighted array is shorter", () => {
		const parsed = parseDiffLines("+ a\n+ b\n+ c");
		// Provide only 1 highlighted line instead of 3
		const result = applyHighlightToDiff(parsed, ["HIGHLIGHTED"], metaColor, hunkColor, prefixColor);

		expect(result[0]).toBe("[ADDED:+]HIGHLIGHTED");
		expect(result[1]).toBe("[ADDED:+] b"); // fallback to raw code
		expect(result[2]).toBe("[ADDED:+] c"); // fallback to raw code
	});

	it("handles empty parsed array", () => {
		expect(applyHighlightToDiff([], [], metaColor, hunkColor, prefixColor)).toEqual([]);
	});

	it("handles diff with only meta (no code lines)", () => {
		const parsed = parseDiffLines("diff --git a/x b/x\nindex abc..def 100644");
		const result = applyHighlightToDiff(parsed, [], metaColor, hunkColor, prefixColor);

		expect(result).toEqual(["[META:diff --git a/x b/x]", "[META:index abc..def 100644]"]);
	});

	it("handles untracked file correctly", () => {
		const parsed = parseDiffLines("+ const x = 1;\n+ export default x;");
		const highlighted = [" CONST X = 1;", " EXPORT DEFAULT X;"];
		const result = applyHighlightToDiff(parsed, highlighted, metaColor, hunkColor, prefixColor);

		expect(result).toEqual(["[ADDED:+] CONST X = 1;", "[ADDED:+] EXPORT DEFAULT X;"]);
	});

	it("context lines with empty prefix pass through correctly", () => {
		// Empty line within a hunk: prefix="" code=""
		const parsed = parseDiffLines("diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n");
		const { code } = extractCodeBlock(parsed);
		const highlighted = code.split("\n").map((l) => `HL:${l}`);
		const result = applyHighlightToDiff(parsed, highlighted, metaColor, hunkColor, prefixColor);

		// Last line is empty context: prefix="" so prefixColor returns ""
		expect(result[result.length - 1]).toBe("HL:");
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
