import { describe, expect, it } from "vitest";
import { countByKey, normalizeOptions, parseCandidateList, sameStringArray, uniqueByKey } from "./data-utils.ts";

// ── countByKey ───────────────────────────────────────────────────────────────

describe("countByKey", () => {
	it("should count unique keys", () => {
		const result = countByKey(["a", "b", "c"]);
		expect(result.get("a")).toBe(1);
		expect(result.get("b")).toBe(1);
		expect(result.get("c")).toBe(1);
	});

	it("should count duplicate keys", () => {
		const result = countByKey(["a", "a", "b", "a"]);
		expect(result.get("a")).toBe(3);
		expect(result.get("b")).toBe(1);
	});

	it("should handle empty array", () => {
		const result = countByKey([]);
		expect(result.size).toBe(0);
	});

	it("should handle single element", () => {
		const result = countByKey(["x"]);
		expect(result.get("x")).toBe(1);
		expect(result.size).toBe(1);
	});

	it("should handle Korean keys", () => {
		const result = countByKey(["가", "나", "가"]);
		expect(result.get("가")).toBe(2);
		expect(result.get("나")).toBe(1);
	});
});

// ── sameStringArray ──────────────────────────────────────────────────────────

describe("sameStringArray", () => {
	it("should return true for identical arrays", () => {
		expect(sameStringArray(["a", "b", "c"], ["a", "b", "c"])).toBe(true);
	});

	it("should return false for different lengths", () => {
		expect(sameStringArray(["a", "b"], ["a", "b", "c"])).toBe(false);
	});

	it("should return false for different elements", () => {
		expect(sameStringArray(["a", "b"], ["a", "c"])).toBe(false);
	});

	it("should return true for empty arrays", () => {
		expect(sameStringArray([], [])).toBe(true);
	});

	it("should be order-sensitive", () => {
		expect(sameStringArray(["a", "b"], ["b", "a"])).toBe(false);
	});

	it("should handle Korean strings", () => {
		expect(sameStringArray(["가", "나"], ["가", "나"])).toBe(true);
		expect(sameStringArray(["가", "나"], ["가", "다"])).toBe(false);
	});
});

// ── normalizeOptions ─────────────────────────────────────────────────────────

describe("normalizeOptions", () => {
	it("should deduplicate options", () => {
		expect(normalizeOptions(["a", "b", "a"])).toEqual(["a", "b"]);
	});

	it("should trim whitespace", () => {
		expect(normalizeOptions(["  hello  ", "  world  "])).toEqual(["hello", "world"]);
	});

	it("should skip empty strings", () => {
		expect(normalizeOptions(["a", "", "  ", "b"])).toEqual(["a", "b"]);
	});

	it("should skip non-strings", () => {
		expect(normalizeOptions(["a", 42, null, "b"])).toEqual(["a", "b"]);
	});

	it("should return empty for non-array", () => {
		expect(normalizeOptions(null)).toEqual([]);
		expect(normalizeOptions(undefined)).toEqual([]);
		expect(normalizeOptions("string")).toEqual([]);
		expect(normalizeOptions(42)).toEqual([]);
	});

	it("should handle empty array", () => {
		expect(normalizeOptions([])).toEqual([]);
	});

	it("should preserve order of first occurrence", () => {
		expect(normalizeOptions(["c", "b", "a", "b", "c"])).toEqual(["c", "b", "a"]);
	});
});

// ── parseCandidateList ───────────────────────────────────────────────────────

describe("parseCandidateList", () => {
	it("should parse comma-separated string", () => {
		expect(parseCandidateList("sox,rec,arecord", ["fallback"])).toEqual(["sox", "rec", "arecord"]);
	});

	it("should trim values", () => {
		expect(parseCandidateList(" sox , rec ", ["fallback"])).toEqual(["sox", "rec"]);
	});

	it("should use fallback for undefined", () => {
		expect(parseCandidateList(undefined, ["default1", "default2"])).toEqual(["default1", "default2"]);
	});

	it("should use fallback for empty string", () => {
		expect(parseCandidateList("", ["fallback"])).toEqual(["fallback"]);
	});

	it("should deduplicate values", () => {
		expect(parseCandidateList("a,b,a,c,b", [])).toEqual(["a", "b", "c"]);
	});

	it("should filter empty parts", () => {
		expect(parseCandidateList("a,,b,,,c", [])).toEqual(["a", "b", "c"]);
	});
});

// ── uniqueByKey ──────────────────────────────────────────────────────────────

describe("uniqueByKey", () => {
	it("should keep first occurrence by key", () => {
		const items = [
			{ name: "a", v: 1 },
			{ name: "b", v: 2 },
			{ name: "a", v: 3 },
		];
		const result = uniqueByKey(items, (i) => i.name);
		expect(result).toEqual([
			{ name: "a", v: 1 },
			{ name: "b", v: 2 },
		]);
	});

	it("should handle empty array", () => {
		expect(uniqueByKey([], (i: unknown) => String(i))).toEqual([]);
	});

	it("should handle all unique", () => {
		const items = [
			{ id: "1", x: 10 },
			{ id: "2", x: 20 },
			{ id: "3", x: 30 },
		];
		const result = uniqueByKey(items, (i) => i.id);
		expect(result).toEqual(items);
	});

	it("should handle all duplicates", () => {
		const items = [
			{ name: "same", idx: 0 },
			{ name: "same", idx: 1 },
			{ name: "same", idx: 2 },
		];
		const result = uniqueByKey(items, (i) => i.name);
		expect(result).toEqual([{ name: "same", idx: 0 }]);
	});

	it("should work with string arrays", () => {
		const result = uniqueByKey(["apple", "banana", "apple", "cherry"], (s) => s);
		expect(result).toEqual(["apple", "banana", "cherry"]);
	});
});
