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
	bg: (color: string, text: string) => `[${color}]${text}[/${color}]`,
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

	it("parses hashline-formatted additions and context rows without exposing hashes", () => {
		const parsed = parseEditUnifiedDiff(["  1#ZP:alpha", "- 2    beta", "+ 2#VR:gamma"].join("\n"));
		expect(parsed).toEqual([
			{ type: "context", lineNum: "1", content: "alpha" },
			{ type: "removed", lineNum: "2", content: "beta" },
			{ type: "added", lineNum: "2", content: "gamma" },
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

	it("renders hashline-formatted diffs without showing hash prefixes", () => {
		const lines = renderEditSideBySide({
			diff: ["  1#ZP:alpha", "- 2    beta", "+ 2#VR:gamma", "  3#WS:omega"].join("\n"),
			width: 80,
			theme,
		});

		expect(lines.join("\n")).not.toContain("#");
		expect(lines[1]).toContain("alpha");
		expect(lines[2]).toContain("beta");
		expect(lines[2]).toContain("gamma");
		expect(lines[3]).toContain("omega");
	});

	it("wraps removed sides in toolErrorBg and added sides in toolSuccessBg", () => {
		const lines = renderEditSideBySide({
			diff: ["  1 alpha", "- 2 beta", "+ 2 gamma", "  3 omega"].join("\n"),
			width: 80,
			theme,
		});

		const changeRow = lines[2] ?? "";
		expect(changeRow).toContain("[toolErrorBg]");
		expect(changeRow).toContain("beta");
		expect(changeRow).toContain("[/toolErrorBg]");
		expect(changeRow).toContain("[toolSuccessBg]");
		expect(changeRow).toContain("gamma");
		expect(changeRow).toContain("[/toolSuccessBg]");
		// Context rows stay unwrapped (no bg).
		expect(lines[1] ?? "").not.toContain("[toolErrorBg]");
		expect(lines[1] ?? "").not.toContain("[toolSuccessBg]");
	});

	it("applies row backgrounds in the narrow-terminal fallback too", () => {
		const narrowTheme = {
			fg: (_color: string, text: string) => text,
			bg: (color: string, text: string) => `<${color}>${text}</${color}>`,
			bold: (text: string) => text,
		};
		const lines = renderEditSideBySide({
			diff: ["- 2 beta", "+ 2 gamma"].join("\n"),
			width: 10,
			theme: narrowTheme,
		});

		expect(lines.some((line) => line.includes("<toolErrorBg>") && line.includes("beta"))).toBe(true);
		expect(lines.some((line) => line.includes("<toolSuccessBg>") && line.includes("gamma"))).toBe(true);
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
