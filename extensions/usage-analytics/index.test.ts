import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { CustomMessageEntry, ExtensionAPI, ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import usageAnalytics, { __test__ } from "./index.ts";

vi.mock("node:os", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:os")>();
	const fs = await import("node:fs");
	const path = await import("node:path");
	const home = fs.mkdtempSync(path.join(actual.tmpdir(), "pi-usage-analytics-test-"));
	return { ...actual, homedir: () => home };
});

const logPath = path.join(os.homedir(), ".pi", "agent", "state", "usage-analytics.jsonl");
afterAll(() => fs.rmSync(os.homedir(), { recursive: true, force: true }));

function readLog() {
	return fs.existsSync(logPath)
		? fs
				.readFileSync(logPath, "utf8")
				.trim()
				.split("\n")
				.filter(Boolean)
				.map((line) => JSON.parse(line))
		: [];
}

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

describe("usage-analytics run identity", () => {
	it.each(["batch", "chain"] as const)("does not match different %s groups by a reused runId", (mode) => {
		const epoch = Date.now();
		const entries = [
			{
				type: "subagent_start" as const,
				ts: iso(epoch),
				epoch,
				agent: "worker",
				mode,
				runId: 1,
				...(mode === "batch" ? { batchId: "group-a" } : { pipelineId: "group-a" }),
				stepIndex: 0,
			},
			{
				type: "subagent_end" as const,
				ts: iso(epoch),
				epoch,
				agent: "worker",
				runId: 1,
				...(mode === "batch" ? { batchId: "group-b" } : { pipelineId: "group-b" }),
				stepIndex: 0,
				status: "done" as const,
				elapsedMs: 100,
			},
		];
		expect(__test__.computeOverall(entries).totalSubagentRuns).toBe(2);
		expect(__test__.computeStats(entries, "week")[0]?.agents.get("worker")).toMatchObject({ total: 2, done: 1 });
	});

	it("does not match a grouped start against an unrelated standalone completion", () => {
		const epoch = Date.now();
		const entries = [
			{
				type: "subagent_start" as const,
				ts: iso(epoch),
				epoch,
				agent: "worker",
				mode: "batch" as const,
				batchId: "b",
				stepIndex: 0,
				runId: 1,
			},
			{ type: "subagent_end" as const, ts: iso(epoch), epoch, agent: "worker", runId: 1, status: "done" as const },
		];
		expect(__test__.computeOverall(entries).totalSubagentRuns).toBe(2);
	});

	it("scopes standalone run keys to their session and never uses bare legacy runIds", () => {
		const a = { runId: 1, sessionId: "session-a" };
		const b = { runId: 1, sessionId: "session-b" };
		expect(__test__.getRunAnalyticsKeys(a)).not.toEqual(__test__.getRunAnalyticsKeys(b));
		expect(__test__.getRunAnalyticsKeys({ runId: 1 })).toEqual([]);
	});

	it("uses a group step even when standalone scope or runId differs", () => {
		const start = { batchId: "b", stepIndex: 0, runId: 1, sessionId: "s" };
		const legacyEnd = { batchId: "b", stepIndex: 0, runId: 9 };
		expect(__test__.getRunAnalyticsKeys(start)).toEqual(__test__.getRunAnalyticsKeys(legacyEnd));
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
				errorClass: undefined,
				peakContextTokens: undefined,
				lastToolName: undefined,
				lastToolOutputChars: undefined,
			},
		]);
	});

	it("preserves normalized failure telemetry from a completion message", () => {
		const entries = __test__.extractSubagentEndEntriesFromCustomMessage({
			content: "[subagent:worker#6] failed",
			details: {
				runId: 6,
				agent: "worker",
				status: "error",
				errorClass: "context_overflow",
				peakContextTokens: 127196,
				lastToolName: "read",
				lastToolOutputChars: 9032,
			},
		});

		expect(entries).toEqual([
			{
				agent: "worker",
				runId: 6,
				batchId: undefined,
				pipelineId: undefined,
				stepIndex: undefined,
				status: "error",
				elapsedMs: undefined,
				model: undefined,
				errorClass: "context_overflow",
				peakContextTokens: 127196,
				lastToolName: "read",
				lastToolOutputChars: 9032,
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
		const recovered = __test__.findUnloggedSubagentEnds(sessionEntries, new Set<string>(), { sessionId: "session-a" });
		expect(recovered).toEqual([
			{
				type: "subagent_end",
				sessionId: "session-a",
				sessionEntryId: sessionEntries[1]?.id,
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
				errorClass: undefined,
				peakContextTokens: undefined,
				lastToolName: undefined,
				lastToolOutputChars: undefined,
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
				sessionId: "session-a",
				sessionEntryId: sessionEntries[0]?.id,
				ts: "2026-06-01T04:45:00.000Z",
				epoch: Date.parse("2026-06-01T04:45:00.000Z"),
				agent: "worker",
				runId: 7,
				status: "done" as const,
				elapsedMs: 500,
			},
		]);
		expect(__test__.findUnloggedSubagentEnds(sessionEntries, alreadyLogged, { sessionId: "session-a" })).toEqual([]);
	});

	it("dedupes duplicate completion entries within a single scan", () => {
		const dup = customMessageEntry("subagent-command", {
			content: "[subagent#9] completed",
			timestamp: "2026-06-01T04:45:00.000Z",
			details: { runId: 9, status: "done", elapsedMs: 100, agent: "reviewer" },
		});
		const recovered = __test__.findUnloggedSubagentEnds([dup, { ...dup }], new Set<string>(), {
			sessionId: "session-a",
		});
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
		expect(__test__.findUnloggedSubagentEnds(sessionEntries, new Set<string>(), { sessionId: "session-a" })).toEqual(
			[],
		);
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

describe("usage-analytics lifecycle logging", () => {
	beforeEach(() => fs.rmSync(logPath, { force: true }));

	function harness() {
		const handlers = new Map<string, (event: never, ctx: ExtensionContext) => unknown>();
		const entries: SessionEntry[] = [];
		let sessionId = "session-a";
		const ctx = {
			sessionManager: { getEntries: () => entries, getSessionId: () => sessionId },
		} as unknown as ExtensionContext;
		usageAnalytics({
			on: (name: string, handler: (event: never, ctx: ExtensionContext) => unknown) => handlers.set(name, handler),
			registerCommand: vi.fn(),
		} as unknown as ExtensionAPI);
		return {
			entries,
			setSession: (id: string) => {
				sessionId = id;
				entries.length = 0;
			},
			emit: async (name: string, event: unknown = {}) => {
				const handler = handlers.get(name);
				expect(handler, `${name} handler`).toBeDefined();
				await handler?.(event as never, ctx);
			},
		};
	}

	it("records the origin session on launches", async () => {
		const h = harness();
		await h.emit("session_start", { reason: "startup" });
		await h.emit("tool_result", {
			toolName: "subagent",
			input: { command: "subagent run worker -- task" },
			details: { launches: [{ agent: "worker", runId: 1 }] },
		});
		expect(readLog()).toEqual([expect.objectContaining({ type: "subagent_start", sessionId: "session-a", runId: 1 })]);
	});

	it("flushes a persisted final completion at agent_end and preserves its timestamp", async () => {
		const h = harness();
		await h.emit("session_start", { reason: "startup" });
		const entry = customMessageEntry("subagent-tool", {
			details: { runId: 1, agent: "worker", status: "done", elapsedMs: 500 },
		});
		// The real SDK emits message_end before appending this custom message.
		await h.emit("message_end", {
			message: { role: "custom", customType: entry.customType, content: entry.content, details: entry.details },
		});
		expect(readLog()).toHaveLength(0);
		h.entries.push(entry);
		await h.emit("agent_end");
		expect(readLog()).toEqual([
			expect.objectContaining({ type: "subagent_end", sessionId: "session-a", ts: entry.timestamp, runId: 1 }),
		]);
		await h.emit("session_start", { reason: "reload" });
		expect(readLog()).toHaveLength(1);
	});

	it("keeps separate continue completions with the same runId across reload", async () => {
		const h = harness();
		await h.emit("session_start", { reason: "startup" });
		h.entries.push(
			customMessageEntry("subagent-tool", { details: { runId: 1, agent: "worker", status: "done", elapsedMs: 500 } }),
		);
		await h.emit("agent_end");
		h.entries.push(
			customMessageEntry("subagent-tool", { details: { runId: 1, agent: "worker", status: "done", elapsedMs: 500 } }),
		);
		await h.emit("session_start", { reason: "reload" });
		expect(readLog()).toHaveLength(2);
		await h.emit("session_start", { reason: "reload" });
		expect(readLog()).toHaveLength(2);
	});

	it("does not suppress another session with an identical local runId", async () => {
		const h = harness();
		await h.emit("session_start", { reason: "startup" });
		h.entries.push(customMessageEntry("subagent-tool", { details: { runId: 1, agent: "worker", status: "done" } }));
		await h.emit("agent_end");
		h.setSession("session-b");
		h.entries.push(customMessageEntry("subagent-tool", { details: { runId: 1, agent: "worker", status: "done" } }));
		await h.emit("session_start", { reason: "resume" });
		expect(readLog().map((entry) => entry.sessionId)).toEqual(["session-a", "session-b"]);
	});

	it("retries a completion after a log write failure without advancing the cursor", async () => {
		const h = harness();
		await h.emit("session_start", { reason: "startup" });
		h.entries.push(customMessageEntry("subagent-tool", { details: { runId: 1, agent: "worker", status: "done" } }));
		// A directory at the file path deterministically makes appendFileSync fail.
		fs.mkdirSync(logPath, { recursive: true });
		await h.emit("agent_end");
		fs.rmdirSync(logPath);
		await h.emit("agent_end");
		expect(readLog()).toHaveLength(1);
		await h.emit("agent_end");
		expect(readLog()).toHaveLength(1);
	});

	it("does not let backdated recovered groups unlock ambiguous legacy standalone history", async () => {
		const h = harness();
		fs.mkdirSync(path.dirname(logPath), { recursive: true });
		fs.writeFileSync(
			logPath,
			`${JSON.stringify({
				type: "subagent_end",
				agent: "worker",
				runId: 1,
				status: "done",
				epoch: Date.now(),
				ts: iso(Date.now()),
			})}\n`,
		);
		h.entries.push(
			customMessageEntry("subagent-tool", {
				timestamp: "2026-06-01T04:44:00Z",
				details: { runId: 2, agent: "worker", status: "done", batchId: "b", pipelineStepIndex: 0 },
			}),
			customMessageEntry("subagent-tool", { details: { runId: 1, agent: "worker", status: "done" } }),
		);
		await h.emit("session_start", { reason: "resume" });
		expect(readLog()).toHaveLength(2);
		await h.emit("session_start", { reason: "reload" });
		expect(readLog()).toHaveLength(2);
	});

	it("flushes pending completions before session shutdown", async () => {
		const h = harness();
		await h.emit("session_start", { reason: "startup" });
		h.entries.push(customMessageEntry("subagent-tool", { details: { runId: 1, agent: "worker", status: "done" } }));
		await h.emit("session_shutdown", { reason: "reload" });
		expect(readLog()).toHaveLength(1);
	});
});

describe("usage-analytics recovery boundaries", () => {
	it("keeps separate attempts of the same run and dedupes a repeated attempt", () => {
		const entries = [1000, 2000, 2000].map((startedAt) =>
			customMessageEntry("subagent-tool", {
				details: { runId: 1, agent: "worker", status: "done", startedAt },
			}),
		);
		const recovered = __test__.findUnloggedSubagentEnds(entries, new Set(), { sessionId: "s" });
		expect(recovered.map((end) => end.startedAt)).toEqual([1000, 2000]);
		expect(__test__.findUnloggedSubagentEnds(entries, __test__.loggedEndKeys(recovered), { sessionId: "s" })).toEqual(
			[],
		);
	});

	it("does not recover ambiguous legacy standalone history by guessing timestamps", () => {
		const entry = customMessageEntry("subagent-tool", { details: { runId: 1, agent: "worker", status: "done" } });
		expect(
			__test__.findUnloggedSubagentEnds([entry], new Set(), {
				sessionId: "s",
				legacyRunIds: new Set([1]),
			}),
		).toEqual([]);
	});

	it("does recover a reused legacy runId once scoped tracking has started", () => {
		const entry = customMessageEntry("subagent-tool", { details: { runId: 1, agent: "worker", status: "done" } });
		expect(
			__test__.findUnloggedSubagentEnds([entry], new Set(), {
				sessionId: "s",
				legacyRunIds: new Set([1]),
				trackedSince: new Map([[1, Date.parse(entry.timestamp) - 1000]]),
			}),
		).toHaveLength(1);
	});

	it("recovers an unrelated batch despite a reused legacy standalone ID", () => {
		const entry = customMessageEntry("subagent-tool", {
			details: { runId: 1, agent: "worker", status: "done", batchId: "b", pipelineStepIndex: 0 },
		});
		expect(
			__test__.findUnloggedSubagentEnds([entry], new Set(), {
				sessionId: "s",
				legacyRunIds: new Set([1]),
			}),
		).toHaveLength(1);
	});

	it("matches legacy grouped completions without requiring a session ID", () => {
		const entry = customMessageEntry("subagent-tool", {
			details: { runId: 1, agent: "worker", status: "done", batchId: "b", pipelineStepIndex: 0 },
		});
		const keys = __test__.loggedEndKeys([
			{
				type: "subagent_end",
				ts: entry.timestamp,
				epoch: Date.parse(entry.timestamp),
				agent: "worker",
				status: "done",
				runId: 1,
				batchId: "b",
				stepIndex: 0,
			},
		]);
		expect(__test__.findUnloggedSubagentEnds([entry], keys, { sessionId: "s" })).toEqual([]);
	});

	it("rejects incomplete group identity and invalid historical timestamps", () => {
		const malformedGroup = customMessageEntry("subagent-tool", {
			details: { runId: 1, agent: "worker", status: "done", batchId: "b" },
		});
		const malformedTime = customMessageEntry("subagent-tool", {
			timestamp: "invalid",
			details: { runId: 2, agent: "worker", status: "done" },
		});
		expect(__test__.findUnloggedSubagentEnds([malformedGroup, malformedTime], new Set(), { sessionId: "s" })).toEqual(
			[],
		);
		expect(__test__.getRunAnalyticsKeys({ batchId: "b", runId: 1, sessionId: "s" })).toEqual([]);
	});

	it("does not invent a zero error rate when only unmatched starts exist", () => {
		const epoch = Date.now();
		const overall = __test__.computeOverall([
			{
				type: "subagent_start",
				ts: iso(epoch),
				epoch,
				agent: "worker",
				mode: "batch",
				batchId: "b",
				stepIndex: 0,
			},
		]);
		expect(overall.agents[0]).toMatchObject({ total: 1, done: 0, error: 0, errorRate: "-" });
	});
});
