import { describe, expect, it } from "vitest";
import {
	attachCommonSubagentRule,
	buildPrompt,
	COMMON_SUBAGENT_NO_RECURSION_RULE,
	centerPad,
	clampLines,
	extractTranscriptFromStdout,
	formatBlockReason,
	formatInjection,
	getLastNonEmptyLine,
	normalizeTranscript,
	sliceToDisplayWidth,
	splitLongToken,
	stripMarkdownForSpeech,
	summarizeForSpeech,
	summarizeJson,
	toSingleLinePreview,
	truncateSingleLine,
	truncateText,
	wrapText,
} from "./text-utils.js";

// ─── splitLongToken ───────────────────────────────────────────────────────

describe("splitLongToken", () => {
	it("returns token as-is if shorter than max", () => {
		expect(splitLongToken("abc", 5)).toEqual(["abc"]);
	});

	it("splits evenly", () => {
		expect(splitLongToken("abcdef", 3)).toEqual(["abc", "def"]);
	});

	it("splits with remainder", () => {
		expect(splitLongToken("abcdefg", 3)).toEqual(["abc", "def", "g"]);
	});

	it("handles exact match", () => {
		expect(splitLongToken("ab", 2)).toEqual(["ab"]);
	});
});

// ─── wrapText ─────────────────────────────────────────────────────────────

describe("wrapText", () => {
	it("wraps long line", () => {
		const result = wrapText("hello world foo bar", 10);
		expect(result.every((line) => line.length <= 10)).toBe(true);
		expect(result.length).toBeGreaterThan(1);
	});

	it("preserves blank lines", () => {
		const result = wrapText("hello\n\nworld", 20);
		expect(result).toContain("");
	});

	it("returns text as-is for maxWidth=1", () => {
		expect(wrapText("abc", 1)).toEqual(["abc"]);
	});

	it("returns [''] for empty input", () => {
		expect(wrapText("", 10)).toEqual([""]);
	});

	it("handles tabs and carriage returns", () => {
		const result = wrapText("a\tb\rc", 100);
		expect(result[0]).not.toContain("\t");
		expect(result[0]).not.toContain("\r");
	});
});

// ─── toSingleLinePreview ─────────────────────────────────────────────────

describe("toSingleLinePreview", () => {
	it("returns (empty) for empty text", () => {
		expect(toSingleLinePreview("", 20)).toBe("(empty)");
	});

	it("returns (empty) for whitespace-only", () => {
		expect(toSingleLinePreview("   \n  ", 20)).toBe("(empty)");
	});

	it("truncates with ellipsis", () => {
		const result = toSingleLinePreview("abcdefghijklmnop", 10);
		expect(result.length).toBeLessThanOrEqual(10);
		expect(result).toContain("…");
	});

	it("collapses newlines", () => {
		expect(toSingleLinePreview("hello\nworld", 100)).toBe("hello world");
	});

	it("short text unchanged", () => {
		expect(toSingleLinePreview("hi", 10)).toBe("hi");
	});
});

// ─── stripMarkdownForSpeech ──────────────────────────────────────────────

describe("stripMarkdownForSpeech", () => {
	it("removes code blocks", () => {
		expect(stripMarkdownForSpeech("before ```code``` after")).toBe("before after");
	});

	it("unwraps inline code", () => {
		expect(stripMarkdownForSpeech("use `npm install`")).toBe("use npm install");
	});

	it("unwraps links", () => {
		expect(stripMarkdownForSpeech("[click here](http://example.com)")).toBe("click here");
	});

	it("removes headers", () => {
		expect(stripMarkdownForSpeech("## Title")).toBe("Title");
	});

	it("empty string", () => {
		expect(stripMarkdownForSpeech("")).toBe("");
	});
});

// ─── normalizeTranscript ─────────────────────────────────────────────────

describe("normalizeTranscript", () => {
	it("collapses whitespace", () => {
		expect(normalizeTranscript("  hello   world  ")).toBe("hello world");
	});

	it("handles newlines and tabs", () => {
		expect(normalizeTranscript("a\n\tb")).toBe("a b");
	});

	it("empty string", () => {
		expect(normalizeTranscript("")).toBe("");
	});
});

// ─── summarizeForSpeech ──────────────────────────────────────────────────

describe("summarizeForSpeech", () => {
	it("returns empty for empty input", () => {
		expect(summarizeForSpeech("", 100)).toBe("");
	});

	it("returns first sentence", () => {
		const result = summarizeForSpeech("Hello world. This is a test. And more.", 100);
		expect(result).toContain("Hello world.");
	});

	it("truncates long summary", () => {
		const long = "A".repeat(200);
		const result = summarizeForSpeech(long, 50);
		expect(result.length).toBeLessThanOrEqual(50);
		expect(result).toContain("…");
	});
});

// ─── extractTranscriptFromStdout ─────────────────────────────────────────

describe("extractTranscriptFromStdout", () => {
	it("extracts timestamped lines", () => {
		const input = "[00:00:00.000 --> 00:00:05.000] Hello world\n[00:00:05.000 --> 00:00:10.000] How are you";
		expect(extractTranscriptFromStdout(input)).toBe("Hello world How are you");
	});

	it("filters whisper log lines", () => {
		const input = "whisper_init: loading model\nmain: processing\nHello world";
		expect(extractTranscriptFromStdout(input)).toBe("Hello world");
	});

	it("handles empty stdout", () => {
		expect(extractTranscriptFromStdout("")).toBe("");
	});
});

// ─── getLastNonEmptyLine ─────────────────────────────────────────────────

describe("getLastNonEmptyLine", () => {
	it("gets last non-empty line", () => {
		expect(getLastNonEmptyLine("hello\nworld\n\n")).toBe("world");
	});

	it("returns empty for empty input", () => {
		expect(getLastNonEmptyLine("")).toBe("");
	});

	it("returns empty for all-whitespace", () => {
		expect(getLastNonEmptyLine("\n  \n  \n")).toBe("");
	});

	it("handles single line", () => {
		expect(getLastNonEmptyLine("only line")).toBe("only line");
	});
});

// ─── truncateSingleLine ─────────────────────────────────────────────────

describe("truncateSingleLine", () => {
	it("returns as-is if within limit", () => {
		expect(truncateSingleLine("abc", 5)).toBe("abc");
	});

	it("truncates with ...", () => {
		expect(truncateSingleLine("abcdefgh", 6)).toBe("abc...");
	});

	it("handles max <= 3 by slicing", () => {
		expect(truncateSingleLine("abcdefgh", 2)).toBe("ab");
	});

	it("exact length", () => {
		expect(truncateSingleLine("abc", 3)).toBe("abc");
	});
});

// ─── summarizeJson ──────────────────────────────────────────────────────

describe("summarizeJson", () => {
	it("returns empty for null", () => {
		expect(summarizeJson(null)).toBe("");
	});

	it("returns empty for undefined", () => {
		expect(summarizeJson(undefined)).toBe("");
	});

	it("returns empty for empty object", () => {
		expect(summarizeJson({})).toBe("");
	});

	it("summarizes object", () => {
		expect(summarizeJson({ key: "value" })).toBe('{"key":"value"}');
	});

	it("truncates long JSON", () => {
		const long = { data: "x".repeat(200) };
		const result = summarizeJson(long, 50);
		expect(result.length).toBeLessThanOrEqual(50);
		expect(result).toContain("...");
	});
});

// ─── clampLines ─────────────────────────────────────────────────────────

describe("clampLines", () => {
	it("returns as-is for fewer lines", () => {
		expect(clampLines("a\nb\nc", 5)).toBe("a\nb\nc");
	});

	it("truncates excess lines", () => {
		const result = clampLines("1\n2\n3\n4\n5", 3);
		expect(result.split("\n")).toHaveLength(3);
		expect(result).toContain("+2 lines");
	});

	it("exact line count", () => {
		expect(clampLines("a\nb", 2)).toBe("a\nb");
	});
});

// ─── buildPrompt ────────────────────────────────────────────────────────

describe("buildPrompt", () => {
	it("returns question only without context", () => {
		expect(buildPrompt("Hello?")).toBe("Hello?");
	});

	it("appends context", () => {
		expect(buildPrompt("Hello?", "Extra info")).toBe("Hello?\n\nExtra info");
	});

	it("ignores empty context", () => {
		expect(buildPrompt("Hello?", "  ")).toBe("Hello?");
	});
});

// ─── formatInjection ────────────────────────────────────────────────────

describe("formatInjection", () => {
	it("formats context files", () => {
		const result = formatInjection([{ path: "/a/b.md", content: "hello" }]);
		expect(result).toContain("/a/b.md");
		expect(result).toContain("hello");
		expect(result).toContain("---");
	});

	it("handles empty array", () => {
		expect(formatInjection([])).toBe("");
	});
});

// ─── formatBlockReason ──────────────────────────────────────────────────

describe("formatBlockReason", () => {
	it("includes target path and file list", () => {
		const result = formatBlockReason("/target.ts", [{ path: "/a.md" }, { path: "/b.md" }]);
		expect(result).toContain("/target.ts");
		expect(result).toContain("/a.md");
		expect(result).toContain("/b.md");
		expect(result).toContain("Blocked");
	});
});

// ─── attachCommonSubagentRule ───────────────────────────────────────────

describe("attachCommonSubagentRule", () => {
	it("appends rule to prompt", () => {
		const result = attachCommonSubagentRule("System prompt.");
		expect(result).toContain("System prompt.");
		expect(result).toContain("Global Runtime Rule");
	});

	it("does not duplicate rule", () => {
		const withRule = attachCommonSubagentRule("System prompt.");
		const twice = attachCommonSubagentRule(withRule);
		const count = (twice.match(/Global Runtime Rule/g) || []).length;
		expect(count).toBe(1);
	});

	it("handles empty prompt", () => {
		const result = attachCommonSubagentRule("");
		expect(result).toBe(COMMON_SUBAGENT_NO_RECURSION_RULE);
	});
});

// ─── Display-width aware functions ──────────────────────────────────────

describe("sliceToDisplayWidth", () => {
	it("returns empty for maxWidth=0", () => {
		expect(sliceToDisplayWidth("hello", 0)).toBe("");
	});

	it("returns empty for empty string", () => {
		expect(sliceToDisplayWidth("", 5)).toBe("");
	});

	it("slices ASCII correctly", () => {
		const result = sliceToDisplayWidth("hello world", 5);
		expect(result).toBe("hello");
	});
});

describe("truncateText", () => {
	it("returns as-is for short text", () => {
		expect(truncateText("hi", 10)).toBe("hi");
	});

	it("returns empty for empty string", () => {
		expect(truncateText("", 10)).toBe("");
	});

	it("returns empty for max=0", () => {
		expect(truncateText("hello", 0)).toBe("");
	});
});

describe("centerPad", () => {
	it("pads short text", () => {
		const result = centerPad("hi", 10);
		expect(result.length).toBeGreaterThanOrEqual(2);
		expect(result).toContain("hi");
	});

	it("truncates long text", () => {
		const result = centerPad("a very long string that exceeds width", 10);
		// just verify it doesn't crash
		expect(typeof result).toBe("string");
	});
});
