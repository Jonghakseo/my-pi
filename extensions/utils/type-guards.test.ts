import { describe, expect, it } from "vitest";
import { asArray, asBoolean, asNumber, asRecord, asString, safeJsonParse } from "./type-guards.ts";

// ── asRecord ─────────────────────────────────────────────────────────────────

describe("asRecord", () => {
	it("should return record for plain objects", () => {
		const obj = { a: 1, b: "two" };
		expect(asRecord(obj)).toBe(obj);
	});

	it("should return null for arrays", () => {
		expect(asRecord([1, 2, 3])).toBe(null);
	});

	it("should return null for null", () => {
		expect(asRecord(null)).toBe(null);
	});

	it("should return null for undefined", () => {
		expect(asRecord(undefined)).toBe(null);
	});

	it("should return null for primitives", () => {
		expect(asRecord("string")).toBe(null);
		expect(asRecord(42)).toBe(null);
		expect(asRecord(true)).toBe(null);
	});

	it("should handle empty object", () => {
		const obj = {};
		expect(asRecord(obj)).toBe(obj);
	});
});

// ── asString ─────────────────────────────────────────────────────────────────

describe("asString", () => {
	it("should return trimmed non-empty string", () => {
		expect(asString("  hello  ")).toBe("hello");
	});

	it("should return null for empty string", () => {
		expect(asString("")).toBe(null);
	});

	it("should return null for whitespace-only", () => {
		expect(asString("   ")).toBe(null);
	});

	it("should return null for non-strings", () => {
		expect(asString(42)).toBe(null);
		expect(asString(null)).toBe(null);
		expect(asString(undefined)).toBe(null);
		expect(asString(true)).toBe(null);
		expect(asString({})).toBe(null);
	});

	it("should handle Korean text", () => {
		expect(asString("  안녕  ")).toBe("안녕");
	});
});

// ── asBoolean ────────────────────────────────────────────────────────────────

describe("asBoolean", () => {
	it("should return true for true", () => {
		expect(asBoolean(true)).toBe(true);
	});

	it("should return false for false", () => {
		expect(asBoolean(false)).toBe(false);
	});

	it("should return null for non-booleans", () => {
		expect(asBoolean(0)).toBe(null);
		expect(asBoolean(1)).toBe(null);
		expect(asBoolean("true")).toBe(null);
		expect(asBoolean(null)).toBe(null);
		expect(asBoolean(undefined)).toBe(null);
	});
});

// ── asNumber ─────────────────────────────────────────────────────────────────

describe("asNumber", () => {
	it("should return finite numbers", () => {
		expect(asNumber(42)).toBe(42);
		expect(asNumber(3.14)).toBe(3.14);
		expect(asNumber(-1)).toBe(-1);
		expect(asNumber(0)).toBe(0);
	});

	it("should parse numeric strings", () => {
		expect(asNumber("42")).toBe(42);
		expect(asNumber("3.14")).toBe(3.14);
		expect(asNumber("-5")).toBe(-5);
	});

	it("should return null for non-finite", () => {
		expect(asNumber(Number.POSITIVE_INFINITY)).toBe(null);
		expect(asNumber(Number.NEGATIVE_INFINITY)).toBe(null);
		expect(asNumber(Number.NaN)).toBe(null);
	});

	it("should return null for non-numeric strings", () => {
		expect(asNumber("abc")).toBe(null);
		// Note: Number("") === 0 which is finite, so asNumber("") returns 0
		expect(asNumber("")).toBe(0);
	});

	it("should return null for other types", () => {
		expect(asNumber(null)).toBe(null);
		expect(asNumber(undefined)).toBe(null);
		expect(asNumber(true)).toBe(null);
		expect(asNumber({})).toBe(null);
	});
});

// ── asArray ──────────────────────────────────────────────────────────────────

describe("asArray", () => {
	it("should return arrays as-is", () => {
		const arr = [1, 2, 3];
		expect(asArray(arr)).toBe(arr);
	});

	it("should return empty array for non-arrays", () => {
		expect(asArray(null)).toEqual([]);
		expect(asArray(undefined)).toEqual([]);
		expect(asArray("string")).toEqual([]);
		expect(asArray(42)).toEqual([]);
		expect(asArray({})).toEqual([]);
	});

	it("should handle empty arrays", () => {
		expect(asArray([])).toEqual([]);
	});
});

// ── safeJsonParse ────────────────────────────────────────────────────────────

describe("safeJsonParse", () => {
	it("should parse valid JSON", () => {
		expect(safeJsonParse<{ a: number }>('{"a": 1}')).toEqual({ a: 1 });
	});

	it("should parse arrays", () => {
		expect(safeJsonParse("[1,2,3]")).toEqual([1, 2, 3]);
	});

	it("should parse strings", () => {
		expect(safeJsonParse('"hello"')).toBe("hello");
	});

	it("should return null for invalid JSON", () => {
		expect(safeJsonParse("{invalid}")).toBe(null);
		expect(safeJsonParse("")).toBe(null);
	});

	it("should return null for malformed JSON", () => {
		expect(safeJsonParse("{'key': 'value'}")).toBe(null);
	});

	it("should handle nested objects", () => {
		const result = safeJsonParse<{ a: { b: number } }>('{"a": {"b": 2}}');
		expect(result).toEqual({ a: { b: 2 } });
	});
});
