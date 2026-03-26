import { describe, expect, it } from "vitest";
import { __test__ } from "../usage-analytics.ts";

function iso(epoch: number): string {
	return new Date(epoch).toISOString();
}

describe("usage-analytics failure/interrupted paths", () => {
	it("counts a failed chain step from subagent_end without double-counting its matching start", () => {
		const now = Date.now();
		const entries = [
			{
				type: "subagent_start" as const,
				ts: iso(now - 1000),
				epoch: now - 1000,
				agent: "worker",
				mode: "chain" as const,
				runId: 1,
				pipelineId: "p_test",
				stepIndex: 0,
			},
			{
				type: "subagent_end" as const,
				ts: iso(now),
				epoch: now,
				agent: "worker",
				runId: 1,
				pipelineId: "p_test",
				stepIndex: 0,
				status: "error" as const,
				elapsedMs: 1500,
				model: "openai-codex/gpt-5.4",
			},
		];

		const stats = __test__.computeStats(entries, "week");
		expect(stats).toHaveLength(1);
		const worker = stats[0]?.agents.get("worker");
		expect(worker).toMatchObject({ total: 1, done: 0, error: 1, avgMs: 1500 });

		const overall = __test__.computeOverall(entries);
		expect(overall.totalSubagentRuns).toBe(1);
		expect(overall.agents[0]).toMatchObject({ name: "worker", total: 1, done: 0, error: 1, avgMs: 1500 });
	});

	it("falls back to an unmatched chain start for interrupted runs with no completion event", () => {
		const now = Date.now();
		const entries = [
			{
				type: "subagent_start" as const,
				ts: iso(now),
				epoch: now,
				agent: "reviewer",
				mode: "chain" as const,
				runId: 2,
				pipelineId: "p_interrupted",
				stepIndex: 1,
			},
		];

		const stats = __test__.computeStats(entries, "week");
		expect(stats).toHaveLength(1);
		const reviewer = stats[0]?.agents.get("reviewer");
		expect(reviewer).toMatchObject({ total: 1, done: 0, error: 0, avgMs: 0 });

		const overall = __test__.computeOverall(entries);
		expect(overall.totalSubagentRuns).toBe(1);
		expect(overall.agents[0]).toMatchObject({ name: "reviewer", total: 1, done: 0, error: 0, avgMs: 0 });
	});

	it("extracts grouped error run summaries from a failed chain completion message", () => {
		const entries = __test__.extractSubagentEndEntriesFromCustomMessage({
			content: "[subagent-chain#p_err] error",
			details: {
				pipelineId: "p_err",
				status: "error",
				runSummaries: [
					{ agent: "worker", runId: 11, pipelineId: "p_err", stepIndex: 0, status: "error", elapsedMs: 1234 },
				],
			},
		});

		expect(entries).toEqual([
			{
				agent: "worker",
				runId: 11,
				batchId: undefined,
				pipelineId: "p_err",
				stepIndex: 0,
				status: "error",
				elapsedMs: 1234,
				model: undefined,
			},
		]);
	});

	it("ignores grouped stopped chain completions under the current semantics", () => {
		const entries = __test__.extractSubagentEndEntriesFromCustomMessage({
			content: "[subagent-chain#p_stop] stopped",
			details: {
				pipelineId: "p_stop",
				status: "stopped",
				runSummaries: [
					{ agent: "worker", runId: 21, pipelineId: "p_stop", stepIndex: 0, status: "done", elapsedMs: 999 },
				],
			},
		});

		expect(entries).toEqual([]);
	});
});
