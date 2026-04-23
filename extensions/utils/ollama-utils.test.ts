import { describe, expect, it } from "vitest";
import {
	convertTools,
	flattenTextContent,
	extractImages,
	mapDoneReason,
	createEmptyAssistantMessage,
} from "./ollama-utils.js";
import type { Model, Api } from "@mariozechner/pi-ai";

// ─── flattenTextContent ──────────────────────────────────────────────────────

describe("flattenTextContent", () => {
	it("should return string input as-is", () => {
		expect(flattenTextContent("hello world")).toBe("hello world");
	});

	it("should join text content blocks with newlines", () => {
		const blocks = [
			{ type: "text" as const, text: "hello" },
			{ type: "text" as const, text: "world" },
		];
		expect(flattenTextContent(blocks)).toBe("hello\nworld");
	});

	it("should filter out non-text content", () => {
		const blocks = [
			{ type: "text" as const, text: "hello" },
			{ type: "image" as const, data: "base64...", mimeType: "image/png" },
			{ type: "text" as const, text: "world" },
		];
		expect(flattenTextContent(blocks)).toBe("hello\nworld");
	});

	it("should return empty string for empty array", () => {
		expect(flattenTextContent([])).toBe("");
	});
});

// ─── extractImages ───────────────────────────────────────────────────────────

describe("extractImages", () => {
	it("should return undefined for string input", () => {
		expect(extractImages("hello")).toBeUndefined();
	});

	it("should extract base64 data from image blocks", () => {
		const blocks = [
			{ type: "text" as const, text: "describe this" },
			{ type: "image" as const, data: "data1", mimeType: "image/png" },
			{ type: "image" as const, data: "data2", mimeType: "image/jpeg" },
		];
		expect(extractImages(blocks)).toEqual(["data1", "data2"]);
	});

	it("should return undefined when no images present", () => {
		const blocks = [{ type: "text" as const, text: "hello" }];
		expect(extractImages(blocks)).toBeUndefined();
	});

	it("should return undefined for empty array", () => {
		expect(extractImages([])).toBeUndefined();
	});
});

// ─── convertTools ────────────────────────────────────────────────────────────

describe("convertTools", () => {
	it("should return undefined for undefined tools", () => {
		expect(convertTools(undefined)).toBeUndefined();
	});

	it("should return undefined for empty tools array", () => {
		expect(convertTools([])).toBeUndefined();
	});

	it("should convert tools to Ollama function format", () => {
		const tools = [
			{
				name: "search",
				description: "Search the web",
				parameters: { type: "object", properties: { query: { type: "string" } } },
			},
		];
		const result = convertTools(tools);
		expect(result).toEqual([
			{
				type: "function",
				function: {
					name: "search",
					description: "Search the web",
					parameters: { type: "object", properties: { query: { type: "string" } } },
				},
			},
		]);
	});
});

// ─── mapDoneReason ───────────────────────────────────────────────────────────

describe("mapDoneReason", () => {
	it("should return 'toolUse' when has tool calls", () => {
		expect(mapDoneReason("stop", true)).toBe("toolUse");
		expect(mapDoneReason(undefined, true)).toBe("toolUse");
	});

	it("should return 'length' for length/max_tokens reasons", () => {
		expect(mapDoneReason("length", false)).toBe("length");
		expect(mapDoneReason("max_tokens", false)).toBe("length");
	});

	it("should return 'stop' for other reasons", () => {
		expect(mapDoneReason("stop", false)).toBe("stop");
		expect(mapDoneReason(undefined, false)).toBe("stop");
		expect(mapDoneReason("other", false)).toBe("stop");
	});
});

// ─── createEmptyAssistantMessage ──────────────────────────────────────────────

describe("createEmptyAssistantMessage", () => {
	it("should create a properly structured empty message", () => {
		const model = {
			id: "test-model",
			api: "test-api" as Api,
			provider: "test-provider",
		} as Model<Api>;

		const msg = createEmptyAssistantMessage(model);
		expect(msg.role).toBe("assistant");
		expect(msg.content).toEqual([]);
		expect(msg.api).toBe("test-api");
		expect(msg.provider).toBe("test-provider");
		expect(msg.model).toBe("test-model");
		expect(msg.stopReason).toBe("stop");
		expect(msg.usage.input).toBe(0);
		expect(msg.usage.output).toBe(0);
		expect(msg.usage.totalTokens).toBe(0);
		expect(msg.usage.cost.total).toBe(0);
	});

	it("should set timestamp to a recent value", () => {
		const model = { id: "m", api: "a" as Api, provider: "p" } as Model<Api>;
		const msg = createEmptyAssistantMessage(model);
		expect(msg.timestamp).toBeGreaterThan(0);
		expect(Date.now() - msg.timestamp).toBeLessThan(5000);
	});
});
