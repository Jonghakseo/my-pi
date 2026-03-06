import { describe, expect, it } from "vitest";
import { scoreMemorySearchMatch } from "../memory-layer/storage.ts";

describe("scoreMemorySearchMatch", () => {
	it("matches on any query token, not only the full query string", () => {
		const score = scoreMemorySearchMatch("tool output rendering read override-builtin-tools compact output", {
			topic: "general",
			title: "Compact read tool output",
			content: "override-builtin-tools renders read output in a compact format",
		});

		expect(score).toBeGreaterThan(0);
	});

	it("prefers stronger matches with more token overlap", () => {
		const stronger = scoreMemorySearchMatch("tool output rendering read", {
			topic: "general",
			title: "Read tool output rendering",
			content: "Compact output for the read tool",
		});
		const weaker = scoreMemorySearchMatch("tool output rendering read", {
			topic: "general",
			title: "Rendering note",
			content: "Unrelated details with only one matching token: tool",
		});

		expect(stronger).toBeGreaterThan(weaker);
	});

	it("returns zero when nothing matches", () => {
		const score = scoreMemorySearchMatch("payment domain client", {
			topic: "general",
			title: "Slack usage",
			content: "How to send a direct message",
		});

		expect(score).toBe(0);
	});
});
