import { describe, expect, it } from "vitest";
import {
	normalizeCuratorTimeoutSeconds,
	normalizeProviderInput,
	normalizeQueryList,
	resolveWorkflow,
} from "../web-access/index.js";

describe("web-access index helpers", () => {
	it("normalizes provider input with trimming and auto fallback", () => {
		expect(normalizeProviderInput(undefined)).toBeUndefined();
		expect(normalizeProviderInput(" Exa ")).toBe("exa");
		expect(normalizeProviderInput("PERPLEXITY")).toBe("perplexity");
		expect(normalizeProviderInput("gemini")).toBe("gemini");
		expect(normalizeProviderInput("unknown")).toBe("auto");
		expect(normalizeProviderInput(123)).toBe("auto");
	});

	it("normalizes curator timeout by flooring and clamping finite positive numbers", () => {
		expect(normalizeCuratorTimeoutSeconds(undefined)).toBeUndefined();
		expect(normalizeCuratorTimeoutSeconds(Number.NaN)).toBeUndefined();
		expect(normalizeCuratorTimeoutSeconds(0)).toBeUndefined();
		expect(normalizeCuratorTimeoutSeconds(1.9)).toBe(1);
		expect(normalizeCuratorTimeoutSeconds(999)).toBe(600);
	});

	it("resolves workflow from UI availability and explicit none", () => {
		expect(resolveWorkflow("summary-review", true)).toBe("summary-review");
		expect(resolveWorkflow(" none ", true)).toBe("none");
		expect(resolveWorkflow(undefined, true)).toBe("summary-review");
		expect(resolveWorkflow("summary-review", false)).toBe("none");
	});

	it("normalizes query lists by trimming strings and dropping empty or non-string values", () => {
		expect(normalizeQueryList([" alpha ", "", "   ", 42, "beta"])).toEqual(["alpha", "beta"]);
	});
});
