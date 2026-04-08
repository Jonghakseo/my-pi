import { describe, expect, it } from "vitest";

import { runBoundedTasks } from "../claude-mcp-bridge/warmup.ts";

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("claude MCP warmup scheduler", () => {
	it("caps concurrent workers", async () => {
		let active = 0;
		let maxActive = 0;

		const results = await runBoundedTasks({
			items: [1, 2, 3, 4, 5],
			maxConcurrency: 2,
			worker: async (item) => {
				active += 1;
				maxActive = Math.max(maxActive, active);
				await sleep(10);
				active -= 1;
				return item * 2;
			},
		});

		expect(maxActive).toBeLessThanOrEqual(2);
		expect(results).toEqual([
			{ status: "fulfilled", value: 2 },
			{ status: "fulfilled", value: 4 },
			{ status: "fulfilled", value: 6 },
			{ status: "fulfilled", value: 8 },
			{ status: "fulfilled", value: 10 },
		]);
	});

	it("isolates failures without aborting the batch", async () => {
		const results = await runBoundedTasks({
			items: ["ok-1", "boom", "ok-2"],
			maxConcurrency: 3,
			worker: async (item) => {
				if (item === "boom") throw new Error("failed");
				return item.toUpperCase();
			},
		});

		expect(results[0]).toEqual({ status: "fulfilled", value: "OK-1" });
		expect(results[2]).toEqual({ status: "fulfilled", value: "OK-2" });
		expect(results[1]?.status).toBe("rejected");
		if (results[1]?.status === "rejected") {
			expect(results[1].reason).toBeInstanceOf(Error);
			expect((results[1].reason as Error).message).toBe("failed");
		}
	});
});
