import { describe, expect, it } from "vitest";
import { overrideAnthropicCacheTtl } from "./payload.js";

describe("overrideAnthropicCacheTtl", () => {
	it("sets every ephemeral cache control to the one-hour TTL without mutating the payload", () => {
		const payload = {
			system: [{ type: "text", text: "system", cache_control: { type: "ephemeral" } }],
			tools: [{ name: "read", cache_control: { type: "ephemeral", ttl: "5m" } }],
			messages: [
				{
					role: "user",
					content: [{ type: "text", text: "hello", cache_control: { type: "ephemeral" } }],
				},
			],
		};

		const rewritten = overrideAnthropicCacheTtl(payload, "1h") as typeof payload;

		expect(rewritten).not.toBe(payload);
		expect(rewritten.system[0].cache_control).toEqual({ type: "ephemeral", ttl: "1h" });
		expect(rewritten.tools[0].cache_control).toEqual({ type: "ephemeral", ttl: "1h" });
		expect(rewritten.messages[0].content[0].cache_control).toEqual({ type: "ephemeral", ttl: "1h" });
		expect(payload.tools[0].cache_control).toEqual({ type: "ephemeral", ttl: "5m" });
	});

	it("removes a one-hour TTL to restore the Anthropic five-minute default", () => {
		const payload = {
			messages: [
				{
					content: [{ cache_control: { type: "ephemeral", ttl: "1h", custom: "preserved" } }],
				},
			],
		};

		const rewritten = overrideAnthropicCacheTtl(payload, undefined) as typeof payload;

		expect(rewritten.messages[0].content[0].cache_control).toEqual({ type: "ephemeral", custom: "preserved" });
	});

	it("preserves payloads without ephemeral cache controls", () => {
		const payload = { model: "claude", metadata: { cache_control: { type: "persistent" } } };

		expect(overrideAnthropicCacheTtl(payload, "1h")).toBe(payload);
	});
});
