import { describe, expect, it } from "vitest";
import {
	collectToolCallCount,
	extractLatestAssistantText,
	extractTextFromBlocks,
	extractTextFromContent,
	getDisplayItems,
	getFinalOutput,
	type MessageLike,
	stringifyToolCallArguments,
	wrapTaskWithMainContext,
} from "./message-utils.ts";

// ── extractTextFromContent ───────────────────────────────────────────────────

describe("extractTextFromContent", () => {
	it("should return string content as-is", () => {
		expect(extractTextFromContent("hello world")).toBe("hello world");
	});

	it("should extract text parts from array", () => {
		const content = [
			{ type: "text", text: "first" },
			{ type: "image", url: "http://example.com" },
			{ type: "text", text: "second" },
		];
		expect(extractTextFromContent(content)).toBe("first\nsecond");
	});

	it("should return empty for null", () => {
		expect(extractTextFromContent(null)).toBe("");
	});

	it("should return empty for undefined", () => {
		expect(extractTextFromContent(undefined)).toBe("");
	});

	it("should return empty for empty array", () => {
		expect(extractTextFromContent([])).toBe("");
	});

	it("should skip non-text parts", () => {
		const content = [{ type: "image" }, { type: "text", text: "only this" }];
		expect(extractTextFromContent(content)).toBe("only this");
	});
});

// ── extractTextFromBlocks ────────────────────────────────────────────────────

describe("extractTextFromBlocks", () => {
	it("should return string as-is", () => {
		expect(extractTextFromBlocks("hello")).toBe("hello");
	});

	it("should join text blocks without separator", () => {
		const blocks = [{ text: "hello" }, { text: " world" }];
		expect(extractTextFromBlocks(blocks)).toBe("hello world");
	});

	it("should return empty for non-array non-string", () => {
		expect(extractTextFromBlocks(42)).toBe("");
		expect(extractTextFromBlocks(null)).toBe("");
	});

	it("should skip blocks without text", () => {
		const blocks = [{ type: "image" }, { text: "only" }];
		expect(extractTextFromBlocks(blocks)).toBe("only");
	});
});

// ── stringifyToolCallArguments ───────────────────────────────────────────────

describe("stringifyToolCallArguments", () => {
	it("should return empty for undefined", () => {
		expect(stringifyToolCallArguments(undefined)).toBe("");
	});

	it("should return empty for null", () => {
		expect(stringifyToolCallArguments(null)).toBe("");
	});

	it("should return string as-is", () => {
		expect(stringifyToolCallArguments("hello")).toBe("hello");
	});

	it("should JSON.stringify objects", () => {
		expect(stringifyToolCallArguments({ key: "value" })).toBe('{"key":"value"}');
	});

	it("should handle arrays", () => {
		expect(stringifyToolCallArguments([1, 2, 3])).toBe("[1,2,3]");
	});

	it("should handle circular references gracefully", () => {
		const obj: Record<string, unknown> = {};
		obj.self = obj;
		const result = stringifyToolCallArguments(obj);
		expect(typeof result).toBe("string");
	});
});

// ── getFinalOutput ───────────────────────────────────────────────────────────

describe("getFinalOutput", () => {
	it("should return last assistant text", () => {
		const messages: MessageLike[] = [
			{ role: "user", content: "hello" },
			{ role: "assistant", content: [{ type: "text", text: "first response" }] },
			{ role: "user", content: "more" },
			{ role: "assistant", content: [{ type: "text", text: "final response" }] },
		];
		expect(getFinalOutput(messages)).toBe("final response");
	});

	it("should return empty for no assistant messages", () => {
		const messages: MessageLike[] = [{ role: "user", content: "hello" }];
		expect(getFinalOutput(messages)).toBe("");
	});

	it("should return empty for empty array", () => {
		expect(getFinalOutput([])).toBe("");
	});

	it("should handle string content", () => {
		const messages: MessageLike[] = [{ role: "assistant", content: "direct string" }];
		expect(getFinalOutput(messages)).toBe("direct string");
	});

	it("should skip tool call parts", () => {
		const messages: MessageLike[] = [
			{
				role: "assistant",
				content: [
					{ type: "toolCall", name: "read", arguments: {} },
					{ type: "text", text: "result" },
				],
			},
		];
		expect(getFinalOutput(messages)).toBe("result");
	});
});

// ── getDisplayItems ──────────────────────────────────────────────────────────

describe("getDisplayItems", () => {
	it("should collect text and tool call items", () => {
		const messages: MessageLike[] = [
			{
				role: "assistant",
				content: [
					{ type: "text", text: "hello" },
					{ type: "toolCall", name: "read", arguments: { path: "/test" } },
				],
			},
		];
		const items = getDisplayItems(messages);
		expect(items).toHaveLength(2);
		expect(items[0].type).toBe("text");
		expect(items[0].text).toBe("hello");
		expect(items[1].type).toBe("toolCall");
		expect(items[1].name).toBe("read");
	});

	it("should skip user messages", () => {
		const messages: MessageLike[] = [
			{ role: "user", content: [{ type: "text", text: "user msg" }] },
			{ role: "assistant", content: [{ type: "text", text: "asst msg" }] },
		];
		const items = getDisplayItems(messages);
		expect(items).toHaveLength(1);
		expect(items[0].text).toBe("asst msg");
	});

	it("should return empty for empty messages", () => {
		expect(getDisplayItems([])).toEqual([]);
	});
});

// ── collectToolCallCount ─────────────────────────────────────────────────────

describe("collectToolCallCount", () => {
	it("should count tool calls", () => {
		const messages: MessageLike[] = [
			{
				role: "assistant",
				content: [
					{ type: "toolCall", name: "read", arguments: {} },
					{ type: "text", text: "result" },
					{ type: "toolCall", name: "write", arguments: {} },
				],
			},
		];
		expect(collectToolCallCount(messages)).toBe(2);
	});

	it("should return 0 for no tool calls", () => {
		const messages: MessageLike[] = [{ role: "assistant", content: [{ type: "text", text: "hi" }] }];
		expect(collectToolCallCount(messages)).toBe(0);
	});

	it("should return 0 for empty messages", () => {
		expect(collectToolCallCount([])).toBe(0);
	});
});

// ── extractLatestAssistantText ───────────────────────────────────────────────

describe("extractLatestAssistantText", () => {
	it("should extract last assistant text", () => {
		const messages = [
			{ role: "assistant", content: [{ type: "text", text: "first" }] },
			{ role: "user", content: "question" },
			{ role: "assistant", content: [{ type: "text", text: "  latest  response  " }] },
		];
		expect(extractLatestAssistantText(messages)).toBe("latest response");
	});

	it("should return empty for no assistant messages", () => {
		expect(extractLatestAssistantText([{ role: "user", content: "hi" }])).toBe("");
	});

	it("should return empty for empty array", () => {
		expect(extractLatestAssistantText([])).toBe("");
	});

	it("should skip non-text content parts", () => {
		const messages = [{ role: "assistant", content: [{ type: "image" }, { type: "text", text: "found" }] }];
		expect(extractLatestAssistantText(messages)).toBe("found");
	});

	it("should handle malformed messages gracefully", () => {
		expect(extractLatestAssistantText([null, undefined, 42, "string"])).toBe("");
	});
});

// ── wrapTaskWithMainContext ──────────────────────────────────────────────────

describe("wrapTaskWithMainContext", () => {
	it("should return task as-is when no context and no session file", () => {
		expect(wrapTaskWithMainContext("do something", "")).toBe("do something");
	});

	it("should wrap with context text", () => {
		const result = wrapTaskWithMainContext("do something", "User: hi\nAssistant: hello");
		expect(result).toContain("[Main Session Context]");
		expect(result).toContain("User: hi");
		expect(result).toContain("[Request]");
		expect(result).toContain("do something");
	});

	it("should include session file path", () => {
		const result = wrapTaskWithMainContext("task", "context", {
			mainSessionFile: "/path/to/session.jsonl",
			totalMessageCount: 30,
		});
		expect(result).toContain("[Main Session Log Access]");
		expect(result).toContain("/path/to/session.jsonl");
		expect(result).toContain("Total messages in main session: 30");
	});

	it("should handle session file without context", () => {
		const result = wrapTaskWithMainContext("task", "", {
			mainSessionFile: "/path/session.jsonl",
		});
		expect(result).toContain("[Main Session Log Access]");
		expect(result).toContain("[Request]");
		expect(result).not.toContain("[Main Session Context]");
	});

	it("should sanitize session file with whitespace/control chars", () => {
		const result = wrapTaskWithMainContext("task", "ctx", {
			mainSessionFile: "  /path/session.jsonl\n\t  ",
		});
		expect(result).toContain("/path/session.jsonl");
	});
});
