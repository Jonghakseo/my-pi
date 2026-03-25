import { describe, expect, it } from "vitest";
import {
	buildNameContext,
	extractNameFromResult,
	extractSessionFilePath,
	formatNameStatus,
	isSubagentSessionPath,
	isSuccessfulResult,
	MAX_MESSAGE_LENGTH,
	MAX_NAME_LENGTH,
	MAX_STATUS_CHARS,
	NAME_SYSTEM_PROMPT,
	SUBAGENT_SESSION_DIR,
	SUCCESSFUL_STOP_REASON,
} from "./auto-name-utils.js";

// ─── isSubagentSessionPath ───────────────────────────────────────────────────

describe("isSubagentSessionPath", () => {
	it("returns false for undefined", () => {
		expect(isSubagentSessionPath(undefined)).toBe(false);
	});

	it("returns false for empty string", () => {
		expect(isSubagentSessionPath("")).toBe(false);
	});

	it("returns false for a regular session path", () => {
		expect(isSubagentSessionPath("/Users/me/.pi/agent/sessions/main.json")).toBe(false);
	});

	it("returns true for a path under subagent session dir (posix sep)", () => {
		const p = `${SUBAGENT_SESSION_DIR}/run-42.json`;
		expect(isSubagentSessionPath(p)).toBe(true);
	});

	it("returns true for a nested path under subagent session dir", () => {
		const p = `${SUBAGENT_SESSION_DIR}/deep/nested/run.json`;
		expect(isSubagentSessionPath(p)).toBe(true);
	});

	it("returns false for a path that merely contains the dir name as substring", () => {
		// e.g. "/Users/me/.pi/agent/sessions/subagents-extra/run.json"
		const p = `${SUBAGENT_SESSION_DIR}-extra/run.json`;
		expect(isSubagentSessionPath(p)).toBe(false);
	});

	it("returns false for the directory itself without trailing separator", () => {
		expect(isSubagentSessionPath(SUBAGENT_SESSION_DIR)).toBe(false);
	});
});

// ─── extractSessionFilePath ──────────────────────────────────────────────────

describe("extractSessionFilePath", () => {
	it("returns undefined for null", () => {
		expect(extractSessionFilePath(null)).toBeUndefined();
	});

	it("returns undefined for non-object", () => {
		expect(extractSessionFilePath("hello")).toBeUndefined();
		expect(extractSessionFilePath(42)).toBeUndefined();
	});

	it("returns undefined when getSessionFile is not a function", () => {
		expect(extractSessionFilePath({ getSessionFile: "not-a-fn" })).toBeUndefined();
	});

	it("returns undefined when getSessionFile returns null", () => {
		expect(extractSessionFilePath({ getSessionFile: () => null })).toBeUndefined();
	});

	it("returns undefined when getSessionFile returns empty string", () => {
		expect(extractSessionFilePath({ getSessionFile: () => "" })).toBeUndefined();
	});

	it("returns undefined when getSessionFile returns only whitespace/control chars", () => {
		expect(extractSessionFilePath({ getSessionFile: () => "\n\t  \r" })).toBeUndefined();
	});

	it("extracts and trims the session file path", () => {
		const sm = { getSessionFile: () => "  /path/to/session.json\n" };
		expect(extractSessionFilePath(sm)).toBe("/path/to/session.json");
	});

	it("strips \\r\\n\\t from the path", () => {
		const sm = { getSessionFile: () => "/path/to\r\n\tsession.json" };
		expect(extractSessionFilePath(sm)).toBe("/path/tosession.json");
	});

	it("returns undefined when getSessionFile throws", () => {
		const sm = {
			getSessionFile: () => {
				throw new Error("boom");
			},
		};
		expect(extractSessionFilePath(sm)).toBeUndefined();
	});
});

// ─── formatNameStatus ────────────────────────────────────────────────────────

describe("formatNameStatus", () => {
	it("returns the name as-is when short", () => {
		expect(formatNameStatus("hello world")).toBe("hello world");
	});

	it("normalizes multiple whitespace to single space", () => {
		expect(formatNameStatus("  hello   world  ")).toBe("hello world");
	});

	it("normalizes newlines and tabs to space", () => {
		expect(formatNameStatus("hello\n\tworld")).toBe("hello world");
	});

	it("clips at MAX_STATUS_CHARS with ellipsis", () => {
		const long = "가".repeat(MAX_STATUS_CHARS + 10);
		const result = formatNameStatus(long);
		expect(result).toContain("…");
		expect(result.length).toBe(MAX_STATUS_CHARS);
	});

	it("does not clip when exactly at MAX_STATUS_CHARS", () => {
		const exact = "x".repeat(MAX_STATUS_CHARS);
		expect(formatNameStatus(exact)).toBe(exact);
		expect(formatNameStatus(exact)).not.toContain("…");
	});

	it("handles empty string", () => {
		expect(formatNameStatus("")).toBe("");
	});
});

// ─── buildNameContext ────────────────────────────────────────────────────────

describe("buildNameContext", () => {
	it("prefixes with Korean label", () => {
		expect(buildNameContext("hello")).toBe("사용자 메시지: hello");
	});

	it("truncates message at MAX_MESSAGE_LENGTH", () => {
		const long = "a".repeat(MAX_MESSAGE_LENGTH + 100);
		const result = buildNameContext(long);
		// prefix length + MAX_MESSAGE_LENGTH
		const prefix = "사용자 메시지: ";
		expect(result).toBe(prefix + "a".repeat(MAX_MESSAGE_LENGTH));
	});

	it("does not truncate short messages", () => {
		const short = "짧은 메시지";
		expect(buildNameContext(short)).toBe(`사용자 메시지: ${short}`);
	});

	it("handles empty message", () => {
		expect(buildNameContext("")).toBe("사용자 메시지: ");
	});
});

// ─── isSuccessfulResult ──────────────────────────────────────────────────────

describe("isSuccessfulResult", () => {
	it("returns true only for stop", () => {
		expect(isSuccessfulResult(SUCCESSFUL_STOP_REASON)).toBe(true);
		expect(isSuccessfulResult("error")).toBe(false);
		expect(isSuccessfulResult("aborted")).toBe(false);
		expect(isSuccessfulResult("length")).toBe(false);
	});

	it("returns false for undefined", () => {
		expect(isSuccessfulResult(undefined)).toBe(false);
	});
});

// ─── extractNameFromResult ───────────────────────────────────────────────────

describe("extractNameFromResult", () => {
	it("extracts text from a single text content", () => {
		const content = [{ type: "text", text: "세션 목적 요약" }];
		expect(extractNameFromResult(content)).toBe("세션 목적 요약");
	});

	it("joins multiple text contents", () => {
		const content = [
			{ type: "text", text: "파트1" },
			{ type: "text", text: " 파트2" },
		];
		expect(extractNameFromResult(content)).toBe("파트1 파트2");
	});

	it("filters out non-text content types", () => {
		const content = [
			{ type: "thinking", text: "내부 사고" },
			{ type: "text", text: "실제 결과" },
			{ type: "toolCall" },
		];
		expect(extractNameFromResult(content)).toBe("실제 결과");
	});

	it("trims whitespace", () => {
		const content = [{ type: "text", text: "  spaced  " }];
		expect(extractNameFromResult(content)).toBe("spaced");
	});

	it("clips at MAX_NAME_LENGTH", () => {
		const long = "한".repeat(MAX_NAME_LENGTH + 20);
		const content = [{ type: "text", text: long }];
		const result = extractNameFromResult(content);
		expect(result.length).toBe(MAX_NAME_LENGTH);
	});

	it("returns empty string for empty content array", () => {
		expect(extractNameFromResult([])).toBe("");
	});

	it("returns empty string when only non-text content exists", () => {
		const content = [{ type: "thinking", text: "thinking only" }];
		expect(extractNameFromResult(content)).toBe("");
	});

	it("skips text entries where text is not a string", () => {
		const content = [
			{ type: "text", text: undefined as unknown as string },
			{ type: "text", text: "valid" },
		];
		expect(extractNameFromResult(content)).toBe("valid");
	});
});

// ─── Constants sanity ────────────────────────────────────────────────────────

describe("constants", () => {
	it("SUBAGENT_SESSION_DIR ends with 'subagents'", () => {
		expect(SUBAGENT_SESSION_DIR).toMatch(/subagents$/);
	});

	it("NAME_SYSTEM_PROMPT is a non-empty string", () => {
		expect(NAME_SYSTEM_PROMPT.length).toBeGreaterThan(0);
	});

	it("MAX_MESSAGE_LENGTH is 500", () => {
		expect(MAX_MESSAGE_LENGTH).toBe(500);
	});

	it("MAX_NAME_LENGTH is 30", () => {
		expect(MAX_NAME_LENGTH).toBe(30);
	});

	it("MAX_STATUS_CHARS is 90", () => {
		expect(MAX_STATUS_CHARS).toBe(90);
	});
});
