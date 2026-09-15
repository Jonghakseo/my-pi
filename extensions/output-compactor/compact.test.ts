import { describe, expect, it } from "vitest";
import { applyFastModePayload } from "./compact.ts";

describe("output-compactor Fast Mode payload", () => {
	it("adds priority processing and low verbosity while retaining generated payload fields", () => {
		expect(
			applyFastModePayload({
				model: "gpt-5.6-luna",
				text: { format: { type: "text" } },
			}),
		).toEqual({
			model: "gpt-5.6-luna",
			service_tier: "priority",
			text: { format: { type: "text" }, verbosity: "low" },
		});
	});

	it("leaves an unexpected payload unchanged", () => {
		expect(applyFastModePayload("not-a-payload")).toBe("not-a-payload");
	});
});
