import { describe, expect, it } from "vitest";
import { AGENT_SYMBOL_MAP as SUBAGENT_SYMBOL_MAP, formatSymbolHints as subagentFormatSymbolHints } from "../subagent/constants.js";
import {
	agentBgIndex as subagentAgentBgIndex,
	AGENT_NAME_PALETTE as SUBAGENT_NAME_PALETTE,
	formatContextUsageBar as subagentFormatContextUsageBar,
	formatTokens as subagentFormatTokens,
	formatToolCallPlain,
	formatUsageStats as subagentFormatUsageStats,
	getContextBarColorByRemaining as subagentGetContextBarColorByRemaining,
	getRemainingContextPercent as subagentGetRemainingContextPercent,
	getUsedContextPercent as subagentGetUsedContextPercent,
	normalizeModelRef as subagentNormalizeModelRef,
	resolveContextWindow,
	truncateLines as subagentTruncateLines,
} from "../subagent/format.js";
import {
	AGENT_NAME_PALETTE,
	AGENT_SYMBOL_MAP,
	agentBgIndex,
	formatContextUsageBar,
	formatTokens,
	formatUsageStats,
	formatSymbolHints,
	getContextBarColorByRemaining,
	getRemainingContextPercent,
	getUsedContextPercent,
	truncateLines,
} from "./format-utils.js";

describe("subagent format bridges", () => {
	it("reuses token/usage formatting from format-utils", () => {
		expect(subagentFormatTokens(9999)).toBe(formatTokens(9999));
		expect(
			subagentFormatUsageStats({ input: 1200, output: 80, cacheRead: 0, cacheWrite: 0, cost: 0.0012, turns: 2 }),
		).toBe(formatUsageStats({ input: 1200, output: 80, cacheRead: 0, cacheWrite: 0, cost: 0.0012, turns: 2 }));
		expect(subagentNormalizeModelRef("anthropic/claude-sonnet:thinking")).toEqual({
			provider: "anthropic",
			id: "claude-sonnet",
		});
	});

	it("reuses context helpers from format-utils", () => {
		expect(subagentGetUsedContextPercent(400, 800)).toBe(getUsedContextPercent(400, 800));
		expect(subagentGetRemainingContextPercent(25)).toBe(getRemainingContextPercent(25));
		expect(subagentFormatContextUsageBar(35, 10)).toBe(formatContextUsageBar(35, 10));
		expect(subagentGetContextBarColorByRemaining(15)).toBe(getContextBarColorByRemaining(15));
	});

	it("reuses palette/hash helpers from format-utils", () => {
		expect(SUBAGENT_NAME_PALETTE).toEqual(AGENT_NAME_PALETTE);
		expect(subagentAgentBgIndex("worker")).toBe(agentBgIndex("worker"));
		expect(subagentTruncateLines("a\nb\nc", 2)).toBe(truncateLines("a\nb\nc", 2));
	});
});

describe("subagent constants bridges", () => {
	it("reuses symbol map and formatter from format-utils", () => {
		expect(SUBAGENT_SYMBOL_MAP).toEqual(AGENT_SYMBOL_MAP);
		expect(subagentFormatSymbolHints()).toBe(formatSymbolHints());
		expect(subagentFormatSymbolHints(">>>")).toBe(formatSymbolHints(">>>"));
	});
});

describe("subagent-specific formatting behavior", () => {
	it("resolves model context window by provider/id and id fallback", () => {
		const ctx = {
			model: { contextWindow: 4096 },
			modelRegistry: {
				getAll: () => [
					{ provider: "anthropic", id: "claude-sonnet", contextWindow: 200000 },
					{ provider: "openai", id: "gpt-4.1", contextWindow: 128000 },
				],
			},
		};

		expect(resolveContextWindow(ctx, "anthropic/claude-sonnet")).toBe(200000);
		expect(resolveContextWindow(ctx, "gpt-4.1")).toBe(128000);
		expect(resolveContextWindow(ctx, "unknown/model")).toBe(4096);
	});

	it("formats plain tool call previews without changing output shape", () => {
		expect(formatToolCallPlain("bash", { command: "echo hello" })).toBe("$ echo hello");
		expect(formatToolCallPlain("read", { path: "/tmp/a.txt", offset: 10, limit: 5 })).toBe("read /tmp/a.txt:10-14");
		expect(formatToolCallPlain("write", { path: "/tmp/a.txt", content: "a\nb" })).toBe("write /tmp/a.txt (2 lines)");
	});
});
