import { describe, expect, it } from "vitest";
import {
	BUILTIN_TOOL_ALIASES,
	expandArgs,
	fallbackReason,
	findJsonObjectEnd,
	getClaudeToolName,
	getMatcherCandidates,
	matcherMatches,
	normalizeToolInput,
	parseAgentFrontmatter,
	parseJsonFromStdout,
	parseReminderRequest,
	splitTodoFrontMatter,
	toBlockReason,
} from "./parse-utils.js";

// ─── parseAgentFrontmatter ────────────────────────────────────────────────

describe("parseAgentFrontmatter", () => {
	it("parses frontmatter with description", () => {
		const raw = "---\ndescription: A helper\nname: helper\n---\nBody text";
		const result = parseAgentFrontmatter(raw);
		expect(result.description).toBe("A helper");
		expect(result.body).toBe("Body text");
		expect(result.fields.name).toBe("helper");
	});

	it("returns raw body when no frontmatter", () => {
		const result = parseAgentFrontmatter("Just body");
		expect(result.body).toBe("Just body");
		expect(result.description).toBe("");
		expect(result.fields).toEqual({});
	});

	it("handles empty string", () => {
		const result = parseAgentFrontmatter("");
		expect(result.body).toBe("");
	});

	it("handles multi-colon values", () => {
		const raw = "---\nurl: http://example.com:3000\n---\nbody";
		const result = parseAgentFrontmatter(raw);
		expect(result.fields.url).toBe("http://example.com:3000");
	});
});

// ─── expandArgs ──────────────────────────────────────────────────────────

describe("expandArgs", () => {
	it("replaces $ARGUMENTS", () => {
		expect(expandArgs("Run $ARGUMENTS now", "test suite")).toBe("Run test suite now");
	});

	it("replaces $@ alias", () => {
		expect(expandArgs("Run $@ now", "test suite")).toBe("Run test suite now");
	});

	it("replaces positional args", () => {
		expect(expandArgs("$1 and $2", "foo bar")).toBe("foo and bar");
	});

	it("handles no placeholders", () => {
		expect(expandArgs("literal text", "args")).toBe("literal text");
	});
});

// ─── findJsonObjectEnd ──────────────────────────────────────────────────

describe("findJsonObjectEnd", () => {
	it("finds closing brace of simple object", () => {
		expect(findJsonObjectEnd('{"key":"value"}')).toBe(14);
	});

	it("handles nested objects", () => {
		expect(findJsonObjectEnd('{"a":{"b":"c"}}')).toBe(14);
	});

	it("handles strings with escaped quotes", () => {
		expect(findJsonObjectEnd('{"key":"val\\"ue"}')).toBe(16);
	});

	it("returns -1 for unclosed object", () => {
		expect(findJsonObjectEnd('{"key":"value"')).toBe(-1);
	});

	it("handles empty object", () => {
		expect(findJsonObjectEnd("{}")).toBe(1);
	});

	it("handles braces inside strings", () => {
		expect(findJsonObjectEnd('{"key":"{"}')).toBe(10);
	});
});

// ─── splitTodoFrontMatter ───────────────────────────────────────────────

describe("splitTodoFrontMatter", () => {
	it("splits JSON frontmatter and body", () => {
		const content = '{"id":"abc","title":"Test"}\n\nBody text here';
		const result = splitTodoFrontMatter(content);
		expect(result.frontMatter).toBe('{"id":"abc","title":"Test"}');
		expect(result.body).toBe("Body text here");
	});

	it("returns empty frontMatter when not starting with {", () => {
		const result = splitTodoFrontMatter("Just body text");
		expect(result.frontMatter).toBe("");
		expect(result.body).toBe("Just body text");
	});

	it("handles no body", () => {
		const result = splitTodoFrontMatter('{"id":"abc"}');
		expect(result.frontMatter).toBe('{"id":"abc"}');
		expect(result.body).toBe("");
	});
});

// ─── parseJsonFromStdout ────────────────────────────────────────────────

describe("parseJsonFromStdout", () => {
	it("parses valid JSON", () => {
		expect(parseJsonFromStdout('{"ok":true}')).toEqual({ ok: true });
	});

	it("parses from last line", () => {
		expect(parseJsonFromStdout('some log\n{"ok":true}')).toEqual({ ok: true });
	});

	it("returns null for empty", () => {
		expect(parseJsonFromStdout("")).toBeNull();
	});

	it("returns null for non-JSON", () => {
		expect(parseJsonFromStdout("not json at all")).toBeNull();
	});

	it("handles whitespace-only", () => {
		expect(parseJsonFromStdout("   \n  ")).toBeNull();
	});
});

// ─── normalizeToolInput ─────────────────────────────────────────────────

describe("normalizeToolInput", () => {
	it("resolves relative path", () => {
		const result = normalizeToolInput("read", { path: "src/index.ts" }, "/project");
		expect(result.path).toBe("/project/src/index.ts");
	});

	it("keeps absolute path", () => {
		const result = normalizeToolInput("read", { path: "/abs/path.ts" }, "/project");
		expect(result.path).toBe("/abs/path.ts");
	});

	it("adds empty command for bash", () => {
		const result = normalizeToolInput("bash", {}, "/project");
		expect(result.command).toBe("");
	});

	it("handles null input", () => {
		const result = normalizeToolInput("read", null, "/project");
		expect(result).toEqual({});
	});
});

// ─── getClaudeToolName ──────────────────────────────────────────────────

describe("getClaudeToolName", () => {
	it("maps builtin tools", () => {
		expect(getClaudeToolName("bash")).toBe("Bash");
		expect(getClaudeToolName("read")).toBe("Read");
		expect(getClaudeToolName("edit")).toBe("Edit");
	});

	it("returns original for unknown tools", () => {
		expect(getClaudeToolName("custom_tool")).toBe("custom_tool");
	});
});

// ─── getMatcherCandidates ───────────────────────────────────────────────

describe("getMatcherCandidates", () => {
	it("includes original and canonical", () => {
		const result = getMatcherCandidates("bash");
		expect(result).toContain("bash");
		expect(result).toContain("Bash");
	});

	it("deduplicates", () => {
		const result = getMatcherCandidates("Bash");
		const unique = new Set(result);
		expect(result.length).toBe(unique.size);
	});
});

// ─── matcherMatches ─────────────────────────────────────────────────────

describe("matcherMatches", () => {
	it("matches empty matcher (wildcard)", () => {
		expect(matcherMatches("", "bash")).toBe(true);
		expect(matcherMatches(undefined, "bash")).toBe(true);
	});

	it("matches exact name", () => {
		expect(matcherMatches("Bash", "bash")).toBe(true);
	});

	it("matches regex pattern", () => {
		expect(matcherMatches("Bash|Read", "bash")).toBe(true);
	});

	it("rejects non-matching", () => {
		expect(matcherMatches("Edit", "bash")).toBe(false);
	});

	it("handles pipe-separated literals", () => {
		expect(matcherMatches("bash|read|edit", "read")).toBe(true);
	});
});

// ─── fallbackReason ─────────────────────────────────────────────────────

describe("fallbackReason", () => {
	it("prefers stderr", () => {
		expect(fallbackReason("err", "out")).toBe("err");
	});

	it("falls back to stdout", () => {
		expect(fallbackReason("", "output")).toBe("output");
	});

	it("returns undefined for empty", () => {
		expect(fallbackReason("", "")).toBeUndefined();
	});

	it("truncates long text", () => {
		const long = "x".repeat(3000);
		const result = fallbackReason(long, "");
		expect(result!.length).toBeLessThanOrEqual(2003);
		expect(result).toContain("...");
	});
});

// ─── toBlockReason ──────────────────────────────────────────────────────

describe("toBlockReason", () => {
	it("returns reason if present", () => {
		expect(toBlockReason("Custom reason", "fallback")).toBe("Custom reason");
	});

	it("returns fallback if reason empty", () => {
		expect(toBlockReason("", "fallback")).toBe("fallback");
	});

	it("returns fallback for undefined", () => {
		expect(toBlockReason(undefined, "fallback")).toBe("fallback");
	});

	it("truncates long reason", () => {
		const long = "x".repeat(3000);
		const result = toBlockReason(long, "fallback");
		expect(result.length).toBeLessThanOrEqual(2003);
	});
});

// ─── parseReminderRequest ───────────────────────────────────────────────

describe("parseReminderRequest", () => {
	it("parses explicit delay", () => {
		const result = parseReminderRequest("10분 있다가 배포 로그 확인해");
		expect(result).not.toBeNull();
		expect(result!.task).toBe("배포 로그 확인해");
		expect(result!.delayMs).toBe(10 * 60 * 1000);
		expect(result!.delayLabel).toBe("10분");
	});

	it("parses 초 unit", () => {
		const result = parseReminderRequest("30초 후에 체크해줘");
		expect(result).not.toBeNull();
		expect(result!.delayMs).toBe(30 * 1000);
	});

	it("parses 시간 unit", () => {
		const result = parseReminderRequest("2시간 뒤에 미팅 참석");
		expect(result).not.toBeNull();
		expect(result!.delayMs).toBe(2 * 60 * 60 * 1000);
	});

	it("parses '좀 있다가' form", () => {
		const result = parseReminderRequest("좀 있다가 리뷰해줘");
		expect(result).not.toBeNull();
		expect(result!.task).toBe("리뷰해줘");
		expect(result!.delayMs).toBe(10 * 60 * 1000);
	});

	it("returns null for non-reminder", () => {
		expect(parseReminderRequest("일반 메시지")).toBeNull();
	});

	it("returns null for empty", () => {
		expect(parseReminderRequest("")).toBeNull();
	});

	it("returns null for too large delay", () => {
		const result = parseReminderRequest("99999시간 있다가 작업해");
		expect(result).toBeNull();
	});

	it("returns null when no task provided", () => {
		const result = parseReminderRequest("10분 있다가 ");
		expect(result).toBeNull();
	});
});
