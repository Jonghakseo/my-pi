import { describe, expect, it } from "vitest";
import { shouldApplyFinalStreamingHTML } from "../generative-ui/index.js";

describe("shouldApplyFinalStreamingHTML", () => {
	it("allows the first final document replacement", () => {
		expect(shouldApplyFinalStreamingHTML("<div>done</div>", false)).toBe(true);
	});

	it("blocks repeat replacements after the final document was applied", () => {
		expect(shouldApplyFinalStreamingHTML("<div>done</div>", true)).toBe(false);
	});

	it("does not apply when no final HTML exists yet", () => {
		expect(shouldApplyFinalStreamingHTML(null, false)).toBe(false);
	});
});
