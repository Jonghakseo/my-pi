import { describe, expect, it } from "vitest";
import {
	buildIndex,
	buildSearchText,
	buildTopicFile,
	decodeEntryTitle,
	ENTRY_MARKER_PREFIX,
	ENTRY_MARKER_SUFFIX,
	encodeEntryTitle,
	isNewEntryFormat,
	makeEntryKey,
	parseIndex,
	parseRememberArgs,
	parseTopicFile,
	parseTopicFileLegacy,
	parseTopicFileMarker,
} from "./memory-parse-utils.ts";

// ── parseIndex ───────────────────────────────────────────────────────────────

describe("parseIndex", () => {
	it("should parse multiple sections", () => {
		const content = [
			"# Memory Index",
			"",
			"## general.md",
			"- rule one",
			"- rule two",
			"",
			"## coding.md",
			"- coding tip",
			"",
		].join("\n");
		const result = parseIndex(content);
		expect(result).toHaveLength(2);
		expect(result[0]).toEqual({ topic: "general", entries: ["rule one", "rule two"] });
		expect(result[1]).toEqual({ topic: "coding", entries: ["coding tip"] });
	});

	it("should return empty for empty content", () => {
		expect(parseIndex("")).toEqual([]);
	});

	it("should return empty for content without sections", () => {
		expect(parseIndex("# Memory Index\n\nSome text")).toEqual([]);
	});

	it("should handle section with no entries", () => {
		const content = "## empty.md\n## next.md\n- entry";
		const result = parseIndex(content);
		expect(result).toEqual([
			{ topic: "empty", entries: [] },
			{ topic: "next", entries: ["entry"] },
		]);
	});

	it("should handle Korean topic names", () => {
		const content = "## 코딩규칙.md\n- 한글 규칙";
		const result = parseIndex(content);
		expect(result).toEqual([{ topic: "코딩규칙", entries: ["한글 규칙"] }]);
	});
});

// ── buildIndex ───────────────────────────────────────────────────────────────

describe("buildIndex", () => {
	it("should build index from sections", () => {
		const result = buildIndex([
			{ topic: "general", entries: ["entry1", "entry2"] },
			{ topic: "coding", entries: ["tip1"] },
		]);
		expect(result).toContain("# Memory Index");
		expect(result).toContain("## general.md");
		expect(result).toContain("- entry1");
		expect(result).toContain("- entry2");
		expect(result).toContain("## coding.md");
		expect(result).toContain("- tip1");
	});

	it("should handle empty sections array", () => {
		const result = buildIndex([]);
		expect(result).toBe("# Memory Index\n");
	});

	it("should round-trip with parseIndex", () => {
		const original = [
			{ topic: "test", entries: ["a", "b"] },
			{ topic: "other", entries: ["c"] },
		];
		const built = buildIndex(original);
		const parsed = parseIndex(built);
		expect(parsed).toEqual(original);
	});
});

// ── encodeEntryTitle / decodeEntryTitle ──────────────────────────────────────

describe("encodeEntryTitle / decodeEntryTitle", () => {
	it("should round-trip ASCII strings", () => {
		const title = "My Rule";
		expect(decodeEntryTitle(encodeEntryTitle(title))).toBe(title);
	});

	it("should round-trip Korean strings", () => {
		const title = "코딩 규칙은 중요합니다";
		expect(decodeEntryTitle(encodeEntryTitle(title))).toBe(title);
	});

	it("should round-trip emoji", () => {
		const title = "🎉 축하! 🎊";
		expect(decodeEntryTitle(encodeEntryTitle(title))).toBe(title);
	});

	it("should round-trip empty string", () => {
		expect(decodeEntryTitle(encodeEntryTitle(""))).toBe("");
	});

	it("should produce valid base64", () => {
		const encoded = encodeEntryTitle("test");
		expect(encoded).toMatch(/^[A-Za-z0-9+/=]+$/);
	});
});

// ── isNewEntryFormat ─────────────────────────────────────────────────────────

describe("isNewEntryFormat", () => {
	it("should detect marker format", () => {
		expect(isNewEntryFormat(`${ENTRY_MARKER_PREFIX}abc${ENTRY_MARKER_SUFFIX}`)).toBe(true);
	});

	it("should return false for legacy format", () => {
		expect(isNewEntryFormat("# Heading\n## Entry\ncontent")).toBe(false);
	});

	it("should return false for empty string", () => {
		expect(isNewEntryFormat("")).toBe(false);
	});
});

// ── parseTopicFileMarker ─────────────────────────────────────────────────────

describe("parseTopicFileMarker", () => {
	it("should parse heading and entries", () => {
		const encoded = encodeEntryTitle("My Rule");
		const raw = [
			"# General",
			"",
			`${ENTRY_MARKER_PREFIX}${encoded}${ENTRY_MARKER_SUFFIX}`,
			"Rule content here",
			"",
		].join("\n");
		const result = parseTopicFileMarker(raw);
		expect(result.heading).toBe("General");
		expect(result.entries).toHaveLength(1);
		expect(result.entries[0].title).toBe("My Rule");
		expect(result.entries[0].content).toBe("Rule content here");
	});

	it("should handle multiple entries", () => {
		const e1 = encodeEntryTitle("First");
		const e2 = encodeEntryTitle("Second");
		const raw = [
			"# Topic",
			`${ENTRY_MARKER_PREFIX}${e1}${ENTRY_MARKER_SUFFIX}`,
			"body1",
			`${ENTRY_MARKER_PREFIX}${e2}${ENTRY_MARKER_SUFFIX}`,
			"body2",
		].join("\n");
		const result = parseTopicFileMarker(raw);
		expect(result.entries).toHaveLength(2);
		expect(result.entries[0].title).toBe("First");
		expect(result.entries[1].title).toBe("Second");
	});
});

// ── parseTopicFileLegacy ─────────────────────────────────────────────────────

describe("parseTopicFileLegacy", () => {
	it("should parse heading and entries", () => {
		const raw = "# General\n\n## Rule One\nContent of rule one\n\n## Rule Two\nContent two";
		const result = parseTopicFileLegacy(raw);
		expect(result.heading).toBe("General");
		expect(result.entries).toHaveLength(2);
		expect(result.entries[0].title).toBe("Rule One");
		expect(result.entries[1].title).toBe("Rule Two");
	});

	it("should handle empty content", () => {
		const result = parseTopicFileLegacy("");
		expect(result.heading).toBe("");
		expect(result.entries).toEqual([]);
	});

	it("should skip leading blank lines before heading", () => {
		const raw = "\n\n# My Topic\n## Entry\ncontent";
		const result = parseTopicFileLegacy(raw);
		expect(result.heading).toBe("My Topic");
		expect(result.entries).toHaveLength(1);
	});
});

// ── parseTopicFile (auto-detect) ─────────────────────────────────────────────

describe("parseTopicFile", () => {
	it("should auto-detect marker format", () => {
		const encoded = encodeEntryTitle("test");
		const raw = `# H\n${ENTRY_MARKER_PREFIX}${encoded}${ENTRY_MARKER_SUFFIX}\nbody`;
		const result = parseTopicFile(raw);
		expect(result.entries[0].title).toBe("test");
	});

	it("should fall back to legacy format", () => {
		const raw = "# H\n## Entry\nbody";
		const result = parseTopicFile(raw);
		expect(result.entries[0].title).toBe("Entry");
	});
});

// ── buildTopicFile ───────────────────────────────────────────────────────────

describe("buildTopicFile", () => {
	it("should build valid marker-format content", () => {
		const entries = [{ title: "Rule 1", content: "Do this" }];
		const result = buildTopicFile("General", entries);
		expect(result).toContain("# General");
		expect(result).toContain(ENTRY_MARKER_PREFIX);
		expect(result).toContain("Do this");
	});

	it("should round-trip with parseTopicFile", () => {
		const entries = [
			{ title: "한글 규칙", content: "내용입니다" },
			{ title: "English", content: "content" },
		];
		const built = buildTopicFile("Test", entries);
		const parsed = parseTopicFile(built);
		expect(parsed.heading).toBe("Test");
		expect(parsed.entries).toHaveLength(2);
		expect(parsed.entries[0].title).toBe("한글 규칙");
		expect(parsed.entries[0].content).toBe("내용입니다");
	});
});

// ── makeEntryKey ─────────────────────────────────────────────────────────────

describe("makeEntryKey", () => {
	it("should combine title and content with null separator", () => {
		const key = makeEntryKey("title", "content");
		expect(key).toBe("title\0content");
	});

	it("should normalize before combining", () => {
		const key1 = makeEntryKey("  title  ", "  content\r\n");
		const key2 = makeEntryKey("title", "content");
		expect(key1).toBe(key2);
	});
});

// ── parseRememberArgs ────────────────────────────────────────────────────────

describe("parseRememberArgs", () => {
	it("should default scope to project", () => {
		const result = parseRememberArgs("remember this fact");
		expect(result.scope).toBe("project");
		expect(result.content).toBe("remember this fact");
	});

	it("should parse explicit user scope", () => {
		const result = parseRememberArgs("user my global preference");
		expect(result.scope).toBe("user");
		expect(result.content).toBe("my global preference");
	});

	it("should parse explicit project scope", () => {
		const result = parseRememberArgs("project use pnpm");
		expect(result.scope).toBe("project");
		expect(result.content).toBe("use pnpm");
	});

	it("should handle content that starts with scope-like word", () => {
		const result = parseRememberArgs("username is test");
		expect(result.scope).toBe("project");
		expect(result.content).toBe("username is test");
	});
});

// ── buildSearchText ──────────────────────────────────────────────────────────

describe("buildSearchText", () => {
	it("should join all fields lowercased", () => {
		const result = buildSearchText({
			scope: "user",
			topic: "General",
			title: "My Rule",
			content: "Details",
		});
		expect(result).toContain("user");
		expect(result).toContain("general");
		expect(result).toContain("my rule");
		expect(result).toContain("details");
	});

	it("should include projectId when present", () => {
		const result = buildSearchText({
			scope: "project",
			projectId: "my-project",
			topic: "coding",
			title: "rule",
			content: "body",
		});
		expect(result).toContain("my-project");
	});

	it("should handle missing projectId", () => {
		const result = buildSearchText({
			scope: "user",
			topic: "t",
			title: "r",
			content: "c",
		});
		expect(result).not.toContain("undefined");
	});
});
