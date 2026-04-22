import { visibleWidth } from "@mariozechner/pi-tui";
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
		const parsed = parseEditUnifiedDiff([" 1 alpha", "-2 beta", "+2 gamma", "    ..."].join("\n"));
		expect(parsed).toEqual([
			{ type: "context", lineNum: "1", content: "alpha" },
			{ type: "removed", lineNum: "2", content: "beta" },
			{ type: "added", lineNum: "2", content: "gamma" },
			{ type: "ellipsis", lineNum: "", content: "..." },
		]);
	});

	it("supports padded line numbers from unified diffs", () => {
		const parsed = parseEditUnifiedDiff(["  12 alpha", "- 13 beta", "+ 13 gamma"].join("\n"));
		expect(parsed).toEqual([
			{ type: "context", lineNum: "12", content: "alpha" },
			{ type: "removed", lineNum: "13", content: "beta" },
			{ type: "added", lineNum: "13", content: "gamma" },
		]);
	});
});

describe("buildEditSideBySideRows", () => {
	it("aligns removed and added rows side by side", () => {
		const rows = buildEditSideBySideRows(
			parseEditUnifiedDiff([" 1 alpha", "-2 beta", "+2 gamma", " 3 omega"].join("\n")),
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
		expect(countEditDiffChanges([" 1 alpha", "-2 beta", "+2 gamma", "+3 delta"].join("\n"))).toEqual({
			additions: 2,
			removals: 1,
		});
	});
});

describe("slicePreviewRows", () => {
	it("starts the preview around the first changed row", () => {
		const rows = buildEditSideBySideRows(
			parseEditUnifiedDiff([" 1 alpha", " 2 beta", "-3 gamma", "+3 delta", " 4 omega", " 5 tail"].join("\n")),
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
			diff: [" 1 alpha", "-2 beta", "+2 gamma", " 3 omega"].join("\n"),
			width: 80,
			theme,
		});

		expect(lines[0]).toContain("+1 / -1");
		expect(lines[2]).toContain("beta");
		expect(lines[2]).toContain("gamma");
		expect(lines[2]).toContain("│");
	});

	it("wraps removed sides in toolErrorBg and added sides in toolSuccessBg", () => {
		const lines = renderEditSideBySide({
			diff: [" 1 alpha", "-2 beta", "+2 gamma", " 3 omega"].join("\n"),
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
			diff: ["-2 beta", "+2 gamma"].join("\n"),
			width: 10,
			theme: narrowTheme,
		});

		expect(lines.some((line) => line.includes("<toolErrorBg>") && line.includes("beta"))).toBe(true);
		expect(lines.some((line) => line.includes("<toolSuccessBg>") && line.includes("gamma"))).toBe(true);
	});

	it("adds compact preview footer when rows are truncated", () => {
		const lines = renderEditSideBySide({
			diff: [" 1 alpha", " 2 beta", "-3 gamma", "+3 delta", " 4 omega", " 5 tail"].join("\n"),
			width: 80,
			theme,
			maxRows: 2,
			isPreview: true,
		});

		expect(lines[0]).toContain("+1 / -1");
		expect(lines[0]).not.toContain("(preview)");
		expect(lines.at(-1)).toContain("more rows");
	});

	it("truncates every narrow fallback row to terminal width", () => {
		const plainTheme = {
			fg: (_color: string, text: string) => text,
			bg: (_color: string, text: string) => text,
			bold: (text: string) => text,
		};
		const width = 12;
		const lines = renderEditSideBySide({
			diff: [
				" 1 const parsed = JSON.parse(stdout) as GhPrViewJson;",
				"-2 if (readPullRequestState(parsed.state) is not supported) return emptyPrSnapshot();",
				'+2 if (readPullRequestState(parsed.state) !== "OPEN") return emptyPrSnapshot();',
			].join("\n"),
			width,
			theme: plainTheme,
		});

		expect(lines.every((line) => visibleWidth(line) <= width)).toBe(true);
	});
});
