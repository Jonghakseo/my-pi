import { describe, expect, it } from "vitest";
import {
	AGENT_NAME_PALETTE,
	AGENT_SYMBOL_MAP,
	agentBgIndex,
	estimateTokens,
	extractCostTotal,
	formatAgentList,
	formatCommandRunSummary,
	formatContextUsageBar,
	formatPriority,
	formatPurposeStatus,
	formatStateLabel,
	formatSymbolHints,
	formatTodoHeading,
	formatTodoId,
	formatTodoList,
	formatTodoMetadataParts,
	formatTodoMetadataSuffix,
	formatTokens,
	formatUsageStats,
	formatUsd,
	getContextBarColorByRemaining,
	getRemainingContextPercent,
	getUsedContextPercent,
	normalizeModelRef,
	type TodoFrontMatterLike,
	truncateLines,
	truncateToWidthWithEllipsis,
} from "./format-utils.js";

// ─── formatUsd ───────────────────────────────────────────────────────────────

describe("formatUsd", () => {
	it("returns $0.00 for zero", () => {
		expect(formatUsd(0)).toBe("$0.00");
	});

	it("returns $0.00 for negative values", () => {
		expect(formatUsd(-5)).toBe("$0.00");
	});

	it("returns $0.00 for NaN", () => {
		expect(formatUsd(NaN)).toBe("$0.00");
	});

	it("returns $0.00 for Infinity", () => {
		expect(formatUsd(Infinity)).toBe("$0.00");
	});

	it("formats >= $1 with 2 decimal places", () => {
		expect(formatUsd(1.5)).toBe("$1.50");
		expect(formatUsd(100.123)).toBe("$100.12");
	});

	it("formats >= $0.1 with 3 decimal places", () => {
		expect(formatUsd(0.123)).toBe("$0.123");
		expect(formatUsd(0.999)).toBe("$0.999");
	});

	it("formats < $0.1 with 4 decimal places", () => {
		expect(formatUsd(0.0001)).toBe("$0.0001");
		expect(formatUsd(0.0999)).toBe("$0.0999");
	});

	it("formats very small positive values", () => {
		expect(formatUsd(0.00001)).toBe("$0.0000");
	});
});

// ─── estimateTokens ──────────────────────────────────────────────────────────

describe("estimateTokens", () => {
	it("returns 0 for empty string", () => {
		expect(estimateTokens("")).toBe(0);
	});

	it("estimates ~1 token per 4 chars", () => {
		expect(estimateTokens("abcd")).toBe(1);
		expect(estimateTokens("abcde")).toBe(2);
	});

	it("handles long text", () => {
		expect(estimateTokens("a".repeat(1000))).toBe(250);
	});

	it("handles Korean text", () => {
		const korean = "한글 테스트 문장입니다";
		expect(estimateTokens(korean)).toBeGreaterThan(0);
	});
});

// ─── extractCostTotal ────────────────────────────────────────────────────────

describe("extractCostTotal", () => {
	it("returns 0 for null/undefined", () => {
		expect(extractCostTotal(null)).toBe(0);
		expect(extractCostTotal(undefined)).toBe(0);
	});

	it("extracts direct number cost", () => {
		expect(extractCostTotal({ cost: 1.23 })).toBe(1.23);
	});

	it("extracts string cost", () => {
		expect(extractCostTotal({ cost: "4.56" })).toBe(4.56);
	});

	it("extracts nested total", () => {
		expect(extractCostTotal({ cost: { total: 7.89 } })).toBe(7.89);
		expect(extractCostTotal({ cost: { total: "10.11" } })).toBe(10.11);
	});

	it("returns 0 for non-finite", () => {
		expect(extractCostTotal({ cost: NaN })).toBe(0);
		expect(extractCostTotal({ cost: Infinity })).toBe(0);
	});

	it("returns 0 for non-object", () => {
		expect(extractCostTotal("hello")).toBe(0);
		expect(extractCostTotal(42)).toBe(0);
	});
});

// ─── formatTokens ────────────────────────────────────────────────────────────

describe("formatTokens", () => {
	it("formats small counts as-is", () => {
		expect(formatTokens(0)).toBe("0");
		expect(formatTokens(999)).toBe("999");
	});

	it("formats thousands with 1 decimal", () => {
		expect(formatTokens(1000)).toBe("1.0k");
		expect(formatTokens(5500)).toBe("5.5k");
		expect(formatTokens(9999)).toBe("10.0k");
	});

	it("formats 10k+ with rounded k", () => {
		expect(formatTokens(10000)).toBe("10k");
		expect(formatTokens(50000)).toBe("50k");
		expect(formatTokens(999999)).toBe("1000k");
	});

	it("formats millions", () => {
		expect(formatTokens(1000000)).toBe("1.0M");
		expect(formatTokens(1500000)).toBe("1.5M");
	});
});

// ─── formatUsageStats ────────────────────────────────────────────────────────

describe("formatUsageStats", () => {
	it("returns empty for all zeros", () => {
		expect(
			formatUsageStats({
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				cost: 0,
			}),
		).toBe("");
	});

	it("includes all non-zero parts", () => {
		const result = formatUsageStats({
			input: 1000,
			output: 500,
			cacheRead: 2000,
			cacheWrite: 100,
			cost: 0.05,
			contextTokens: 3000,
			turns: 3,
		});
		expect(result).toContain("3 turns");
		expect(result).toContain("↑1.0k");
		expect(result).toContain("↓500");
		expect(result).toContain("R2.0k");
		expect(result).toContain("W100");
		expect(result).toContain("$0.0500");
		expect(result).toContain("ctx:3.0k");
	});

	it("appends model name", () => {
		const result = formatUsageStats({ input: 100, output: 50, cacheRead: 0, cacheWrite: 0, cost: 0 }, "sonnet");
		expect(result).toContain("sonnet");
	});

	it("handles single turn without plural", () => {
		const result = formatUsageStats({
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			cost: 0,
			turns: 1,
		});
		expect(result).toBe("1 turn");
	});
});

// ─── normalizeModelRef ───────────────────────────────────────────────────────

describe("normalizeModelRef", () => {
	it("handles plain model id", () => {
		expect(normalizeModelRef("claude-sonnet")).toEqual({ id: "claude-sonnet" });
	});

	it("handles provider/model format", () => {
		expect(normalizeModelRef("anthropic/claude-sonnet")).toEqual({
			provider: "anthropic",
			id: "claude-sonnet",
		});
	});

	it("strips colon suffix", () => {
		expect(normalizeModelRef("model-name:extended")).toEqual({ id: "model-name" });
	});

	it("handles whitespace", () => {
		expect(normalizeModelRef("  model  ")).toEqual({ id: "model" });
	});
});

// ─── getUsedContextPercent ───────────────────────────────────────────────────

describe("getUsedContextPercent", () => {
	it("returns undefined for missing context window", () => {
		expect(getUsedContextPercent(100, 0)).toBeUndefined();
		expect(getUsedContextPercent(100, undefined)).toBeUndefined();
	});

	it("returns undefined for negative tokens", () => {
		expect(getUsedContextPercent(-1, 1000)).toBeUndefined();
	});

	it("calculates percentage correctly", () => {
		expect(getUsedContextPercent(500, 1000)).toBe(50);
		expect(getUsedContextPercent(0, 1000)).toBe(0);
		expect(getUsedContextPercent(1000, 1000)).toBe(100);
	});

	it("clamps to 0-100", () => {
		expect(getUsedContextPercent(2000, 1000)).toBe(100);
	});
});

// ─── getRemainingContextPercent ──────────────────────────────────────────────

describe("getRemainingContextPercent", () => {
	it("returns undefined for undefined input", () => {
		expect(getRemainingContextPercent(undefined)).toBeUndefined();
	});

	it("calculates remaining correctly", () => {
		expect(getRemainingContextPercent(30)).toBe(70);
		expect(getRemainingContextPercent(0)).toBe(100);
		expect(getRemainingContextPercent(100)).toBe(0);
	});

	it("clamps to 0-100", () => {
		expect(getRemainingContextPercent(150)).toBe(0);
	});
});

// ─── formatContextUsageBar ───────────────────────────────────────────────────

describe("formatContextUsageBar", () => {
	it("renders 0%", () => {
		expect(formatContextUsageBar(0, 10)).toBe("[----------] 0%");
	});

	it("renders 100%", () => {
		expect(formatContextUsageBar(100, 10)).toBe("[##########] 100%");
	});

	it("renders 50%", () => {
		expect(formatContextUsageBar(50, 10)).toBe("[#####-----] 50%");
	});

	it("clamps overflow", () => {
		expect(formatContextUsageBar(200, 10)).toBe("[##########] 100%");
	});

	it("clamps negative", () => {
		expect(formatContextUsageBar(-50, 10)).toBe("[----------] 0%");
	});
});

// ─── getContextBarColorByRemaining ───────────────────────────────────────────

describe("getContextBarColorByRemaining", () => {
	it("returns error for <= 15%", () => {
		expect(getContextBarColorByRemaining(15)).toBe("error");
		expect(getContextBarColorByRemaining(0)).toBe("error");
	});

	it("returns warning for <= 40%", () => {
		expect(getContextBarColorByRemaining(40)).toBe("warning");
		expect(getContextBarColorByRemaining(16)).toBe("warning");
	});

	it("returns undefined for > 40%", () => {
		expect(getContextBarColorByRemaining(41)).toBeUndefined();
		expect(getContextBarColorByRemaining(100)).toBeUndefined();
	});
});

// ─── agentBgIndex ────────────────────────────────────────────────────────────

describe("agentBgIndex", () => {
	it("returns a value within palette range", () => {
		const idx = agentBgIndex("worker");
		expect(idx).toBeGreaterThanOrEqual(0);
		expect(idx).toBeLessThan(AGENT_NAME_PALETTE.length);
	});

	it("is deterministic", () => {
		expect(agentBgIndex("finder")).toBe(agentBgIndex("finder"));
	});

	it("varies by name", () => {
		const names = ["finder", "worker", "reviewer", "planner", "verifier"];
		const indices = new Set(names.map(agentBgIndex));
		// At least some variation expected
		expect(indices.size).toBeGreaterThan(1);
	});
});

// ─── truncateLines ───────────────────────────────────────────────────────────

describe("truncateLines", () => {
	it("returns text as-is if within limit", () => {
		expect(truncateLines("line1\nline2", 3)).toBe("line1\nline2");
	});

	it("truncates with ellipsis", () => {
		expect(truncateLines("a\nb\nc\nd", 2)).toBe("a\nb\n...");
	});

	it("handles single line", () => {
		expect(truncateLines("hello", 1)).toBe("hello");
	});

	it("handles empty string", () => {
		expect(truncateLines("", 2)).toBe("");
	});
});

describe("truncateToWidthWithEllipsis", () => {
	it("returns input as-is when it fits", () => {
		expect(truncateToWidthWithEllipsis("hello", 5)).toBe("hello");
	});

	it("appends ellipsis when truncated", () => {
		expect(truncateToWidthWithEllipsis("hello world", 8)).toBe("hello...");
	});

	it("returns width-only truncation when maxWidth <= 3", () => {
		expect(truncateToWidthWithEllipsis("abcdef", 3)).toBe("abc");
	});

	it("handles CJK width correctly", () => {
		expect(truncateToWidthWithEllipsis("안녕하세요반갑습니다", 8)).toBe("안녕...");
	});
});

// ─── formatCommandRunSummary ─────────────────────────────────────────────────

describe("formatCommandRunSummary", () => {
	it("formats a complete run summary", () => {
		const result = formatCommandRunSummary({
			id: 42,
			status: "done",
			agent: "worker",
			contextMode: "main",
			turnCount: 3,
			elapsedMs: 5500,
			toolCalls: 12,
		});
		expect(result).toBe("#42 [done] worker ctx:main turn:3 6s tools:12");
	});

	it("defaults to isolated context", () => {
		const result = formatCommandRunSummary({
			id: 1,
			status: "running",
			agent: "finder",
			elapsedMs: 0,
			toolCalls: 0,
		});
		expect(result).toContain("ctx:isolated");
	});

	it("defaults turnCount to 1", () => {
		const result = formatCommandRunSummary({
			id: 1,
			status: "done",
			agent: "test",
			elapsedMs: 1000,
			toolCalls: 5,
		});
		expect(result).toContain("turn:1");
	});
});

// ─── formatSymbolHints ───────────────────────────────────────────────────────

describe("formatSymbolHints", () => {
	it("includes all symbols from AGENT_SYMBOL_MAP", () => {
		const result = formatSymbolHints();
		for (const [sym, agent] of Object.entries(AGENT_SYMBOL_MAP)) {
			expect(result).toContain(`>>${sym} ${agent}`);
		}
	});

	it("uses custom prefix", () => {
		const result = formatSymbolHints("$$");
		expect(result).toContain("$$/ finder");
	});
});

// ─── formatAgentList ─────────────────────────────────────────────────────────

describe("formatAgentList", () => {
	it("returns 'none' for empty list", () => {
		expect(formatAgentList([], 5)).toEqual({ text: "none", remaining: 0 });
	});

	it("lists agents up to maxItems", () => {
		const agents = [
			{ name: "a", description: "desc-a", source: "user" },
			{ name: "b", description: "desc-b", source: "project" },
			{ name: "c", description: "desc-c", source: "user" },
		];
		const result = formatAgentList(agents, 2);
		expect(result.text).toContain("a (user): desc-a");
		expect(result.text).toContain("b (project): desc-b");
		expect(result.text).not.toContain("desc-c");
		expect(result.remaining).toBe(1);
	});

	it("shows all when maxItems >= length", () => {
		const agents = [{ name: "solo", description: "d", source: "user" }];
		const result = formatAgentList(agents, 10);
		expect(result.remaining).toBe(0);
	});
});

// ─── formatStateLabel ────────────────────────────────────────────────────────

describe("formatStateLabel", () => {
	it("returns UNKNOWN for null", () => {
		expect(formatStateLabel(null)).toBe("UNKNOWN");
	});

	it("replaces underscores and uppercases", () => {
		expect(formatStateLabel("in_progress")).toBe("IN PROGRESS");
		expect(formatStateLabel("open")).toBe("OPEN");
	});

	it("handles already uppercase", () => {
		expect(formatStateLabel("MERGED")).toBe("MERGED");
	});
});

// ─── formatTodoId ────────────────────────────────────────────────────────────

describe("formatTodoId", () => {
	it("prepends TODO- prefix", () => {
		expect(formatTodoId("deadbeef")).toBe("TODO-deadbeef");
	});

	it("handles empty string", () => {
		expect(formatTodoId("")).toBe("TODO-");
	});
});

// ─── formatPriority ──────────────────────────────────────────────────────────

describe("formatPriority", () => {
	it("returns Korean labels for known priorities", () => {
		expect(formatPriority("high")).toBe("상");
		expect(formatPriority("medium")).toBe("중");
		expect(formatPriority("low")).toBe("하");
	});

	it("returns 'none' for undefined", () => {
		expect(formatPriority(undefined)).toBe("none");
	});
});

// ─── formatTodoMetadataParts ─────────────────────────────────────────────────

describe("formatTodoMetadataParts", () => {
	it("returns empty for no metadata", () => {
		expect(formatTodoMetadataParts({})).toEqual([]);
	});

	it("includes all present metadata", () => {
		const parts = formatTodoMetadataParts({
			priority: "high",
			due_date: "2026-01-01",
			estimate: "2h",
		});
		expect(parts).toEqual(["P:상", "due:2026-01-01", "est:2h"]);
	});

	it("includes only provided fields", () => {
		expect(formatTodoMetadataParts({ priority: "low" })).toEqual(["P:하"]);
	});
});

// ─── formatTodoMetadataSuffix ────────────────────────────────────────────────

describe("formatTodoMetadataSuffix", () => {
	it("returns empty for no metadata", () => {
		const todo: TodoFrontMatterLike = {
			id: "abc",
			title: "test",
			tags: [],
			status: "open",
		};
		expect(formatTodoMetadataSuffix(todo)).toBe("");
	});

	it("wraps in parentheses", () => {
		const todo: TodoFrontMatterLike = {
			id: "abc",
			title: "test",
			tags: [],
			status: "open",
			priority: "high",
		};
		expect(formatTodoMetadataSuffix(todo)).toBe(" (P:상)");
	});
});

// ─── formatTodoHeading ───────────────────────────────────────────────────────

describe("formatTodoHeading", () => {
	it("formats a basic heading", () => {
		const todo: TodoFrontMatterLike = {
			id: "deadbeef",
			title: "Fix bug",
			tags: [],
			status: "open",
		};
		expect(formatTodoHeading(todo)).toBe("TODO-deadbeef Fix bug");
	});

	it("includes tags and metadata", () => {
		const todo: TodoFrontMatterLike = {
			id: "abc",
			title: "Task",
			tags: ["qa", "urgent"],
			status: "open",
			priority: "high",
		};
		const heading = formatTodoHeading(todo);
		expect(heading).toContain("[qa, urgent]");
		expect(heading).toContain("P:상");
	});

	it("shows (untitled) for empty title", () => {
		const todo: TodoFrontMatterLike = {
			id: "abc",
			title: "",
			tags: [],
			status: "open",
		};
		expect(formatTodoHeading(todo)).toContain("(untitled)");
	});

	it("includes assignment suffix", () => {
		const todo: TodoFrontMatterLike = {
			id: "abc",
			title: "Task",
			tags: [],
			status: "open",
			assigned_to_session: "session.json",
		};
		expect(formatTodoHeading(todo)).toContain("(assigned: session.json)");
	});
});

// ─── formatTodoList ──────────────────────────────────────────────────────────

describe("formatTodoList", () => {
	it("returns 'No todos.' for empty list", () => {
		expect(formatTodoList([])).toBe("No todos.");
	});

	it("groups by assigned/open/closed", () => {
		const todos: TodoFrontMatterLike[] = [
			{ id: "1", title: "Assigned task", tags: [], status: "open", assigned_to_session: "s.json" },
			{ id: "2", title: "Open task", tags: [], status: "open" },
			{ id: "3", title: "Done task", tags: [], status: "done" },
		];
		const result = formatTodoList(todos);
		expect(result).toContain("Assigned todos (1):");
		expect(result).toContain("Open todos (1):");
		expect(result).toContain("Closed todos (1):");
	});

	it("shows 'none' for empty sections", () => {
		const todos: TodoFrontMatterLike[] = [{ id: "1", title: "Open", tags: [], status: "open" }];
		const result = formatTodoList(todos);
		expect(result).toContain("Assigned todos (0):");
		expect(result).toContain("  none");
	});
});

// ─── formatPurposeStatus ─────────────────────────────────────────────────────

describe("formatPurposeStatus", () => {
	it("formats with target emoji", () => {
		expect(formatPurposeStatus("build tests")).toBe("🎯 build tests");
	});

	it("normalizes whitespace", () => {
		expect(formatPurposeStatus("  hello   world  ")).toBe("🎯 hello world");
	});

	it("clips long purposes with ellipsis", () => {
		const long = "x".repeat(100);
		const result = formatPurposeStatus(long);
		expect(result).toContain("…");
		expect(result.length).toBeLessThan(100);
	});

	it("handles empty string", () => {
		expect(formatPurposeStatus("")).toBe("🎯 ");
	});
});
