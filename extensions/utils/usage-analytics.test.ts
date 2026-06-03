import { describe, expect, it } from "vitest";
import { __test__ } from "../usage-analytics/index.ts";

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

	it("recovers an unlogged trailing subagent_end from a resumed session entry", () => {
		const epoch = Date.parse("2026-06-01T04:45:00.000Z");
		const sessionEntries = [
			{ type: "assistant", content: "hi" },
			{
				type: "custom_message",
				customType: "subagent-tool",
				content: "[subagent#42] completed",
				timestamp: "2026-06-01T04:45:00.000Z",
				details: { runId: 42, status: "done", elapsedMs: 1200, agent: "worker", model: "m" },
			},
		];
		const recovered = __test__.findUnloggedSubagentEnds(sessionEntries, new Set<string>());
		expect(recovered).toEqual([
			{
				type: "subagent_end",
				ts: new Date(epoch).toISOString(),
				epoch,
				agent: "worker",
				runId: 42,
				batchId: undefined,
				pipelineId: undefined,
				stepIndex: undefined,
				status: "done",
				elapsedMs: 1200,
				model: "m",
			},
		]);
	});

	it("skips a completion whose run key is already logged (idempotent backfill)", () => {
		const sessionEntries = [
			{
				type: "custom_message",
				customType: "subagent-tool",
				content: "[subagent#7] completed",
				timestamp: "2026-06-01T04:45:00.000Z",
				details: { runId: 7, status: "done", elapsedMs: 500, agent: "worker" },
			},
		];
		const alreadyLogged = __test__.loggedEndKeys([
			{
				type: "subagent_end" as const,
				ts: "2026-06-01T04:45:00.000Z",
				epoch: Date.parse("2026-06-01T04:45:00.000Z"),
				agent: "worker",
				runId: 7,
				status: "done" as const,
				elapsedMs: 500,
			},
		]);
		expect(__test__.findUnloggedSubagentEnds(sessionEntries, alreadyLogged)).toEqual([]);
	});

	it("dedupes duplicate completion entries within a single scan", () => {
		const dup = {
			type: "custom_message",
			customType: "subagent-command",
			content: "[subagent#9] completed",
			timestamp: "2026-06-01T04:45:00.000Z",
			details: { runId: 9, status: "done", elapsedMs: 100, agent: "reviewer" },
		};
		const recovered = __test__.findUnloggedSubagentEnds([dup, { ...dup }], new Set<string>());
		expect(recovered).toHaveLength(1);
	});

	it("ignores non-completion and non-subagent session entries", () => {
		const sessionEntries = [
			{ type: "user", content: "hello" },
			{ type: "custom_message", customType: "subagent-display-task", details: { runId: 1 } },
			{
				type: "custom_message",
				customType: "subagent-tool",
				content: "[subagent#3] running",
				timestamp: "2026-06-01T04:45:00.000Z",
				details: { runId: 3, status: "running" },
			},
		];
		expect(__test__.findUnloggedSubagentEnds(sessionEntries, new Set<string>())).toEqual([]);
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
