import { describe, expect, it } from "vitest";
import {
	applyEditOverrideToContent,
	applyEditOverrideToRawContent,
	inspectTextFormatting,
	normalizeSpecialCharacters,
	preserveQuoteStyle,
	restoreTextFormatting,
} from "./edit-override.ts";

describe("edit-override formatting helpers", () => {
	it("preserves BOM and CRLF line endings", () => {
		const rawContent = "\uFEFFalpha\r\nbeta\r\n";
		const formatting = inspectTextFormatting(rawContent);
		expect(formatting.bom).toBe("\uFEFF");
		expect(formatting.lineEnding).toBe("\r\n");
		expect(restoreTextFormatting("alpha\ngamma\n", formatting)).toBe("\uFEFFalpha\r\ngamma\r\n");

		const result = applyEditOverrideToRawContent(rawContent, [{ oldText: "beta\n", newText: "gamma\n" }], "sample.txt");
		expect(result.rawNewContent).toBe("\uFEFFalpha\r\ngamma\r\n");
		expect(result.firstChangedLine).toBe(2);
		expect(result.diff).toContain("-2 beta");
		expect(result.diff).toContain("+2 gamma");
	});

	it("preserves CR-only line endings", () => {
		const rawContent = "alpha\rbeta\r";
		const formatting = inspectTextFormatting(rawContent);
		expect(formatting.bom).toBe("");
		expect(formatting.lineEnding).toBe("\r");
		expect(restoreTextFormatting("alpha\ngamma\n", formatting)).toBe("alpha\rgamma\r");

		const result = applyEditOverrideToRawContent(rawContent, [{ oldText: "beta\n", newText: "gamma\n" }], "sample.txt");
		expect(result.rawNewContent).toBe("alpha\rgamma\r");
		expect(result.firstChangedLine).toBe(2);
		expect(result.diff).toContain("-2 beta");
		expect(result.diff).toContain("+2 gamma");
	});

	it("normalizes smart quotes, dashes, and special spaces", () => {
		expect(normalizeSpecialCharacters("‘a’ “b” – c\u00A0d")).toBe("'a' \"b\" - c d");
	});

	it("preserves curly quote style for replacement text", () => {
		expect(preserveQuoteStyle('"We\'re ready."', '"Don\'t panic."', "“Don’t panic.”")).toBe("“We’re ready.”");
		expect(preserveQuoteStyle("'hello'", "'hello'", "‘hello’")).toBe("‘hello’");
	});
});

describe("applyEditOverrideToContent", () => {
	it("keeps exact unique matches even when fuzzy normalization would duplicate them", () => {
		const content = ["const exact = “hi”;", 'const fuzzy = "hi";'].join("\n");
		const result = applyEditOverrideToContent(
			content,
			[{ oldText: "const exact = “hi”;", newText: 'const exact = "bye";' }],
			"sample.ts",
		);

		expect(result.newContent).toBe(['const exact = "bye";', 'const fuzzy = "hi";'].join("\n"));
		expect(result.matchedEdits[0]?.stage).toBe("exact");
	});

	it("matches multiline edits with trailing whitespace differences only", () => {
		const content = ["alpha  ", "beta\t ", "omega"].join("\n");
		const result = applyEditOverrideToContent(
			content,
			[{ oldText: "alpha\nbeta\n", newText: "ALPHA\nBETA\n" }],
			"sample.txt",
		);

		expect(result.newContent).toBe(["ALPHA", "BETA", "omega"].join("\n"));
		expect(result.matchedEdits[0]?.stage).toBe("trim-trailing-whitespace");
	});

	it("matches exact spans correctly after astral characters", () => {
		const result = applyEditOverrideToContent("😀abc", [{ oldText: "abc", newText: "XYZ" }], "sample.txt");

		expect(result.newContent).toBe("😀XYZ");
		expect(result.matchedEdits[0]).toMatchObject({
			matchIndex: 2,
			matchLength: 3,
			stage: "exact",
		});
	});

	it("matches smart quotes, unicode dashes, and special spaces", () => {
		const content = "Greeting: “hello” – hi\u00A0there";
		const result = applyEditOverrideToContent(
			content,
			[{ oldText: 'Greeting: "hello" - hi there', newText: 'Greeting: "hello" - goodbye there' }],
			"sample.txt",
		);

		expect(result.newContent).toBe("Greeting: “hello” - goodbye there");
		expect(result.matchedEdits[0]?.stage).toBe("normalize-special-characters");
	});

	it("preserves curly quotes and apostrophes when fuzzy matching", () => {
		const content = "const title = “Don’t panic.”";
		const result = applyEditOverrideToContent(
			content,
			[{ oldText: 'const title = "Don\'t panic."', newText: 'const title = "We\'re ready."' }],
			"sample.ts",
		);

		expect(result.newContent).toBe("const title = “We’re ready.”");
		expect(result.matchedEdits[0]?.stage).toBe("normalize-special-characters");
	});

	it("throws when an exact match is duplicated", () => {
		const content = ["duplicate", "duplicate"].join("\n");
		expect(() =>
			applyEditOverrideToContent(content, [{ oldText: "duplicate", newText: "changed" }], "sample.txt"),
		).toThrow("Found 2 occurrences of the text in sample.txt");
	});

	it("throws when matched edits overlap in the original content", () => {
		expect(() =>
			applyEditOverrideToContent(
				"abcdef",
				[
					{ oldText: "abcde", newText: "X" },
					{ oldText: "cde", newText: "Y" },
				],
				"sample.txt",
			),
		).toThrow("overlap in sample.txt");
	});

	it("replaces every occurrence when replaceAll is explicitly enabled", () => {
		const result = applyEditOverrideToContent(
			["foo", "bar foo", "foo"].join("\n"),
			[{ oldText: "foo", newText: "baz", replaceAll: true }],
			"sample.txt",
		);

		expect(result.newContent).toBe(["baz", "bar baz", "baz"].join("\n"));
		expect(result.matchedEdits).toHaveLength(3);
		expect(result.matchedEdits.every((match) => match.replaceAll)).toBe(true);
	});

	it("rejects replaceAll when mixed with multi-edit requests", () => {
		expect(() =>
			applyEditOverrideToContent(
				"foo\nbar",
				[
					{ oldText: "foo", newText: "one", replaceAll: true },
					{ oldText: "bar", newText: "two" },
				],
				"sample.txt",
			),
		).toThrow("replaceAll is only supported when exactly one edit is provided in sample.txt");
	});

	it("preserves unrelated trailing whitespace elsewhere in the file", () => {
		const content = ["keep   ", "match   ", "next\t ", "tail"].join("\n");
		const result = applyEditOverrideToContent(
			content,
			[{ oldText: "match\nnext\n", newText: "done\nNEXT\n" }],
			"sample.txt",
		);

		expect(result.newContent).toBe(["keep   ", "done", "NEXT", "tail"].join("\n"));
	});

	it("applies multiple disjoint edits against the original content", () => {
		const content = ["foo", "bar", "baz"].join("\n");
		const result = applyEditOverrideToContent(
			content,
			[
				{ oldText: "foo", newText: "one" },
				{ oldText: "baz", newText: "three" },
			],
			"sample.txt",
		);

		expect(result.newContent).toBe(["one", "bar", "three"].join("\n"));
		expect(result.firstChangedLine).toBe(1);
		expect(result.diff).toContain("-1 foo");
		expect(result.diff).toContain("+1 one");
		expect(result.diff).toContain("-3 baz");
		expect(result.diff).toContain("+3 three");
	});

	it("throws a no-op error when replacements do not change the content", () => {
		expect(() => applyEditOverrideToContent("same", [{ oldText: "same", newText: "same" }], "sample.txt")).toThrow(
			"No changes made to sample.txt",
		);
	});

	it("does not fuzzy-match whitespace-only oldText against tab-only content", () => {
		expect(() => applyEditOverrideToContent("\t\t", [{ oldText: "  ", newText: "Y" }], "sample.txt")).toThrow(
			"Could not find the exact text in sample.txt",
		);
	});

	it("does not fuzzy-match whitespace-only oldText against empty content", () => {
		expect(() => applyEditOverrideToContent("", [{ oldText: "  ", newText: "Y" }], "sample.txt")).toThrow(
			"Could not find the exact text in sample.txt",
		);
	});

	it("still allows exact whitespace-only matches", () => {
		const result = applyEditOverrideToContent("  ", [{ oldText: "  ", newText: "Y" }], "sample.txt");

		expect(result.newContent).toBe("Y");
		expect(result.matchedEdits[0]?.stage).toBe("exact");
	});
});

describe("applyEditOverrideToRawContent", () => {
	it("uses LF semantics for single-line files without existing newlines", () => {
		const result = applyEditOverrideToRawContent("alpha", [{ oldText: "alpha", newText: "a\nb" }], "sample.txt");

		expect(result.formatting.lineEnding).toBe("\n");
		expect(result.rawNewContent).toBe("a\nb");
	});
});
