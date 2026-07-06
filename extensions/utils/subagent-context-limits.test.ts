import { afterEach, describe, expect, it } from "vitest";
import {
	CONTEXT_GUARD_SIGNATURE,
	isContextOverflowText,
	resolveContextGuardCeiling,
} from "../subagent/context-limits.ts";

const ENV_KEY = "PI_SUBAGENT_CONTEXT_GUARD_TOKENS";

afterEach(() => {
	delete process.env[ENV_KEY];
});

describe("isContextOverflowText", () => {
	it("matches provider overflow errors", () => {
		expect(isContextOverflowText("Your input exceeds the context window of this model")).toBe(true);
		expect(isContextOverflowText("prompt is too long: 213462 tokens > 200000 maximum")).toBe(true);
		expect(isContextOverflowText("Input length (265330) exceeds model's maximum context length (262144).")).toBe(true);
		expect(isContextOverflowText("context_length_exceeded")).toBe(true);
	});

	it("matches our own proactive guard signature", () => {
		expect(isContextOverflowText(`${CONTEXT_GUARD_SIGNATURE} stopped at 235100 tokens (ceiling 235000)`)).toBe(true);
	});

	it("excludes rate-limit / throttling errors", () => {
		expect(isContextOverflowText("rate limit exceeded")).toBe(false);
		expect(isContextOverflowText("Throttling error: Too many tokens, please wait")).toBe(false);
		expect(isContextOverflowText("429 too many requests")).toBe(false);
	});

	it("returns false for empty / unrelated text", () => {
		expect(isContextOverflowText("")).toBe(false);
		expect(isContextOverflowText(undefined)).toBe(false);
		expect(isContextOverflowText("some normal assistant output")).toBe(false);
	});
});

describe("resolveContextGuardCeiling", () => {
	it("applies a ceiling to openai-codex pi-runtime models", () => {
		expect(resolveContextGuardCeiling("openai-codex/gpt-5.5", "pi")).toBe(235_000);
		expect(resolveContextGuardCeiling("openai-codex/gpt-5.5", undefined)).toBe(235_000);
	});

	it("returns undefined for unknown models and non-pi runtimes", () => {
		expect(resolveContextGuardCeiling("anthropic/claude-opus-4-6", "pi")).toBeUndefined();
		expect(resolveContextGuardCeiling("openai-codex/gpt-5.5", "claude")).toBeUndefined();
		expect(resolveContextGuardCeiling(undefined, "pi")).toBeUndefined();
	});

	it("honors an env override for all pi models", () => {
		process.env[ENV_KEY] = "120000";
		expect(resolveContextGuardCeiling("anthropic/claude-opus-4-6", "pi")).toBe(120_000);
		expect(resolveContextGuardCeiling("openai-codex/gpt-5.5", "pi")).toBe(120_000);
	});

	it("disables the guard when env override is 0 or invalid", () => {
		process.env[ENV_KEY] = "0";
		expect(resolveContextGuardCeiling("openai-codex/gpt-5.5", "pi")).toBeUndefined();
		process.env[ENV_KEY] = "not-a-number";
		expect(resolveContextGuardCeiling("openai-codex/gpt-5.5", "pi")).toBeUndefined();
	});
});
