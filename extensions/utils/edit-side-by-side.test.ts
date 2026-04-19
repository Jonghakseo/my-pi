import { describe, expect, it } from "vitest";
import {
	buildEditSideBySideRows,
	countEditDiffChanges,
	parseEditUnifiedDiff,
	renderEditSideBySide,
	slicePreviewRows,
} from "./edit-side-by-side.ts";

const theme = {
	fg: (_color: string, text: string) => text,
	bold: (text: string) => text,
};

describe("parseEditUnifiedDiff", () => {
	it("parses added, removed, context, and ellipsis rows", () => {
		const parsed = parseEditUnifiedDiff(["  1 alpha", "- 2 beta", "+ 2 gamma", "    ..."].join("\n"));
		expect(parsed).toEqual([
			{ type: "context", lineNum: "1", content: "alpha" },
			{ type: "removed", lineNum: "2", content: "beta" },
			{ type: "added", lineNum: "2", content: "gamma" },
			{ type: "ellipsis", lineNum: "", content: "..." },
		]);
	});
});

describe("buildEditSideBySideRows", () => {
	it("aligns removed and added rows side by side", () => {
		const rows = buildEditSideBySideRows(
			parseEditUnifiedDiff(["  1 alpha", "- 2 beta", "+ 2 gamma", "  3 omega"].join("\n")),
		);

		expect(rows[0]).toEqual({
			left: { type: "context", lineNum: "1", content: "alpha" },
			right: { type: "context", lineNum: "1", content: "alpha" },
		});
		expect(rows[1]).toEqual({
			left: { type: "removed", lineNum: "2", content: "beta" },
			right: { type: "added", lineNum: "2", content: "gamma" },
		});
		expect(rows[2]).toEqual({
			left: { type: "context", lineNum: "3", content: "omega" },
			right: { type: "context", lineNum: "3", content: "omega" },
		});
	});
});

describe("countEditDiffChanges", () => {
	it("counts only added and removed lines", () => {
		expect(countEditDiffChanges(["  1 alpha", "- 2 beta", "+ 2 gamma", "+ 3 delta"].join("\n"))).toEqual({
			additions: 2,
			removals: 1,
		});
	});
});

describe("slicePreviewRows", () => {
	it("starts the preview around the first changed row", () => {
		const rows = buildEditSideBySideRows(
			parseEditUnifiedDiff(["  1 alpha", "  2 beta", "- 3 gamma", "+ 3 delta", "  4 omega", "  5 tail"].join("\n")),
		);

		const preview = slicePreviewRows(rows, 3);
		expect(preview.rows).toHaveLength(3);
		expect(preview.rows[0]?.left.content).toBe("beta");
		expect(preview.hiddenCount).toBe(2);
	});
});

describe("renderEditSideBySide", () => {
	it("renders summary and side-by-side rows", () => {
		const lines = renderEditSideBySide({
			diff: ["  1 alpha", "- 2 beta", "+ 2 gamma", "  3 omega"].join("\n"),
			width: 80,
			theme,
		});

		expect(lines[0]).toContain("+1 / -1");
		expect(lines[2]).toContain("beta");
		expect(lines[2]).toContain("gamma");
		expect(lines[2]).toContain("│");
	});

	it("adds compact preview footer when rows are truncated", () => {
		const lines = renderEditSideBySide({
			diff: ["  1 alpha", "  2 beta", "- 3 gamma", "+ 3 delta", "  4 omega", "  5 tail"].join("\n"),
			width: 80,
			theme,
			maxRows: 2,
			isPreview: true,
		});

		expect(lines[0]).toContain("(preview)");
		expect(lines.at(-1)).toContain("more rows");
	});
});
