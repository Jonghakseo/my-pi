import { describe, expect, it } from "vitest";
import { normalizeProviderInput, normalizeQueryList } from "./index.js";

describe("web-access index helpers", () => {
	it("normalizes provider input with trimming and auto fallback", () => {
		expect(normalizeProviderInput(undefined)).toBeUndefined();
		expect(normalizeProviderInput(" Exa ")).toBe("exa");
		expect(normalizeProviderInput("gemini")).toBe("gemini");
		expect(normalizeProviderInput("perplexity")).toBe("auto");
		expect(normalizeProviderInput("unknown")).toBe("auto");
		expect(normalizeProviderInput(123)).toBe("auto");
	});

	it("normalizes query lists by trimming strings and dropping empty or non-string values", () => {
		expect(normalizeQueryList(["  a  ", "", 42, null, "b"])).toEqual(["a", "b"]);
		expect(normalizeQueryList([])).toEqual([]);
	});
});
