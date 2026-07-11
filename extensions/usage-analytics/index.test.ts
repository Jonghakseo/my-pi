import type { CustomMessageEntry, SessionEntry } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { __test__ } from "./index.ts";

function iso(epoch: number): string {
	return new Date(epoch).toISOString();
}

let nextSessionEntryId = 0;

function customMessageEntry(
	customType: string,
	overrides: Partial<Omit<CustomMessageEntry, "type" | "id" | "parentId" | "customType" | "display">> = {},
): CustomMessageEntry {
	return {
		type: "custom_message",
		id: `test-entry-${++nextSessionEntryId}`,
		parentId: null,
		timestamp: "2026-06-01T04:45:00.000Z",
		customType,
		content: "",
		display: false,
		...overrides,
	};
}

describe("usage-analytics skill activity", () => {
	it("extracts an explicit skill invocation from an expanded user message", () => {
		const invocation = __test__.extractSkillInvocation({
			role: "user",
			content: [
				{
					type: "text",
					text: '<skill name="picky-cli" location="/skills/picky-cli/SKILL.md">\nReferences are relative to /skills/picky-cli.\n\n# picky-cli\n</skill>\n\ncreate a pickle',
				},
			],
			timestamp: Date.now(),
		});

		expect(invocation).toEqual({
			skill: "picky-cli",
			path: "/skills/picky-cli/SKILL.md",
		});
	});

	it("ignores ordinary user messages and non-user messages", () => {
		expect(
			__test__.extractSkillInvocation({ role: "user", content: "please use picky-cli", timestamp: Date.now() }),
		).toBeNull();
		expect(
			__test__.extractSkillInvocation({
				role: "assistant",
				content: [{ type: "text", text: '<skill name="picky-cli" location="/tmp/SKILL.md">\nx\n</skill>' }],
				provider: "test",
				model: "test",
				api: "test",
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "stop",
				timestamp: Date.now(),
			}),
		).toBeNull();
	});

	it("keeps skill invocations and SKILL.md reads as separate metrics", () => {
		const now = Date.now();
		const entries = [
			{
				type: "skill_invoked" as const,
				ts: iso(now - 2000),
				epoch: now - 2000,
				skill: "picky-cli",
				path: "/skills/picky-cli/SKILL.md",
			},
			{
				type: "skill_invoked" as const,
				ts: iso(now - 1000),
				epoch: now - 1000,
				skill: "picky-cli",
				path: "/skills/picky-cli/SKILL.md",
			},
			{
				type: "skill_read" as const,
				ts: iso(now),
				epoch: now,
				skill: "picky-cli",
				path: "/skills/picky-cli/SKILL.md",
			},
		];

		const stats = __test__.computeStats(entries, "week");
		expect(stats).toHaveLength(1);
		expect(stats[0]?.skills.get("picky-cli")).toEqual({ name: "picky-cli", invoked: 2, reads: 1 });

		const overall = __test__.computeOverall(entries);
		expect(overall.totalSkillInvocations).toBe(2);
		expect(overall.totalSkillReads).toBe(1);
		expect(overall.skills[0]).toEqual({
			name: "picky-cli",
			invoked: 2,
			reads: 1,
			lastInvoked: now - 1000,
			lastRead: now,
		});
	});
});

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
		const sessionEntries: SessionEntry[] = [
			customMessageEntry("other", { content: "hi" }),
			customMessageEntry("subagent-tool", {
				content: "[subagent#42] completed",
				timestamp: "2026-06-01T04:45:00.000Z",
				details: { runId: 42, status: "done", elapsedMs: 1200, agent: "worker", model: "m" },
			}),
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
		const sessionEntries: SessionEntry[] = [
			customMessageEntry("subagent-tool", {
				content: "[subagent#7] completed",
				timestamp: "2026-06-01T04:45:00.000Z",
				details: { runId: 7, status: "done", elapsedMs: 500, agent: "worker" },
			}),
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
		const dup = customMessageEntry("subagent-command", {
			content: "[subagent#9] completed",
			timestamp: "2026-06-01T04:45:00.000Z",
			details: { runId: 9, status: "done", elapsedMs: 100, agent: "reviewer" },
		});
		const recovered = __test__.findUnloggedSubagentEnds([dup, { ...dup }], new Set<string>());
		expect(recovered).toHaveLength(1);
	});

	it("ignores non-completion and non-subagent session entries", () => {
		const sessionEntries: SessionEntry[] = [
			customMessageEntry("other", { content: "hello" }),
			customMessageEntry("subagent-display-task", { details: { runId: 1 } }),
			customMessageEntry("subagent-tool", {
				content: "[subagent#3] running",
				timestamp: "2026-06-01T04:45:00.000Z",
				details: { runId: 3, status: "running" },
			}),
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
