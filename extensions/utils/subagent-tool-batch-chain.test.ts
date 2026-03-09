import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createStore } from "../subagent/store.ts";
import type { SingleResult } from "../subagent/types.ts";

const mockDiscoverAgents = vi.fn();
const mockEnqueueSubagentInvocation = vi.fn();
const mockRunSingleAgent = vi.fn();
const mockUpdateCommandRunsWidget = vi.fn();

vi.mock("../subagent/agents.js", () => ({
	discoverAgents: (...args: unknown[]) => mockDiscoverAgents(...args),
}));

vi.mock("../subagent/invocation-queue.js", () => ({
	enqueueSubagentInvocation: (...args: unknown[]) => mockEnqueueSubagentInvocation(...args),
}));

vi.mock("../subagent/widget.js", () => ({
	updateCommandRunsWidget: (...args: unknown[]) => mockUpdateCommandRunsWidget(...args),
}));

vi.mock("../subagent/runner.js", async () => {
	const actual = await vi.importActual<typeof import("../subagent/runner.js")>("../subagent/runner.js");
	return {
		...actual,
		runSingleAgent: (...args: unknown[]) => mockRunSingleAgent(...args),
	};
});

type SentMessage = {
	content?: string;
	details?: Record<string, unknown>;
};

type SentOptions = {
	deliverAs?: "followUp";
	triggerTurn?: boolean;
};

type SentCall = {
	message: SentMessage;
	options: SentOptions | undefined;
};

type ToolCtx = {
	cwd: string;
	hasUI: boolean;
	sessionManager: {
		getSessionFile: () => string;
		getEntries: () => unknown[];
	};
};

function makeResult(agent: string, task: string, text: string): SingleResult {
	return {
		agent,
		agentSource: "user",
		task,
		exitCode: 0,
		messages: [{ role: "assistant", content: [{ type: "text", text }] } as never],
		stderr: "",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 1 },
	};
}

async function loadToolExecute() {
	vi.resetModules();
	return await import("../subagent/tool-execute.ts");
}

function createPi(sent: SentCall[]) {
	return {
		sendMessage: vi.fn((message: SentMessage, options?: SentOptions) => {
			sent.push({ message, options });
		}),
	};
}

function createCtx(): ToolCtx {
	return {
		cwd: process.cwd(),
		hasUI: false,
		sessionManager: {
			getSessionFile: () => "/tmp/main-session.jsonl",
			getEntries: () => [],
		},
	};
}

async function waitForAssertion(assertion: () => void, attempts = 20): Promise<void> {
	let lastError: unknown;
	for (let index = 0; index < attempts; index++) {
		try {
			assertion();
			return;
		} catch (error: unknown) {
			lastError = error;
			await Promise.resolve();
		}
	}
	throw lastError instanceof Error ? lastError : new Error("Assertion did not pass in time");
}

describe("createSubagentToolExecute batch/chain grouped behavior", () => {
	beforeEach(() => {
		mockDiscoverAgents.mockReset();
		mockEnqueueSubagentInvocation.mockReset();
		mockRunSingleAgent.mockReset();
		mockUpdateCommandRunsWidget.mockReset();
		mockDiscoverAgents.mockReturnValue({
			agents: [
				{ name: "worker-fast", source: "user", systemPrompt: "" },
				{ name: "reviewer", source: "user", systemPrompt: "" },
			],
			projectAgentsDir: null,
		});
		mockEnqueueSubagentInvocation.mockImplementation(async (fn: () => Promise<unknown>) => await fn());
	});

	afterEach(() => {
		vi.clearAllMocks();
	});

	it("emits only grouped batch follow-up and no per-member follow-ups", async () => {
		mockRunSingleAgent.mockImplementation(async (_cwd: unknown, _agents: unknown, agentName: string, task: string) => {
			return makeResult(agentName, task, agentName === "worker-fast" ? "NB_A" : "NB_B");
		});
		const { createSubagentToolExecute } = await loadToolExecute();
		const store = createStore();
		const sent: SentCall[] = [];
		const pi = createPi(sent);
		const execute = createSubagentToolExecute(pi as never, store);
		const ctx = createCtx();

		const result = await execute(
			"call-1",
			{
				command: 'subagent batch --main --agent worker-fast --task "batch a" --agent reviewer --task "batch b"',
			},
			undefined,
			undefined,
			ctx,
		);

		expect(result.content[0]?.text).toContain("Started async subagent batch");
		await waitForAssertion(() => {
			expect(sent).toHaveLength(1);
		});
		expect(sent[0]?.message.content).toContain("[subagent-batch#");
		expect(sent[0]?.message.content).toContain("NB_A");
		expect(sent[0]?.message.content).toContain("NB_B");
		expect(sent[0]?.message.content).not.toContain("[subagent:worker-fast#");
		expect(sent[0]?.message.content).not.toContain("[subagent:reviewer#");
	});

	it("passes previous-step reference to later chain steps while emitting only grouped follow-up", async () => {
		const seenTasks: string[] = [];
		mockRunSingleAgent.mockImplementation(async (_cwd: unknown, _agents: unknown, agentName: string, task: string) => {
			seenTasks.push(task);
			return makeResult(agentName, task, agentName === "worker-fast" ? "CHAIN_TOKEN_TEST" : "CHAIN_SEEN_OK");
		});
		const { createSubagentToolExecute } = await loadToolExecute();
		const store = createStore();
		const sent: SentCall[] = [];
		const pi = createPi(sent);
		const execute = createSubagentToolExecute(pi as never, store);
		const ctx = createCtx();

		const result = await execute(
			"call-2",
			{
				command: 'subagent chain --main --agent worker-fast --task "step one" --agent reviewer --task "step two"',
			},
			undefined,
			undefined,
			ctx,
		);

		expect(result.content[0]?.text).toContain("Started async subagent chain");
		await waitForAssertion(() => {
			expect(seenTasks).toHaveLength(2);
			expect(sent).toHaveLength(1);
		});
		expect(seenTasks[1]).toContain("[PIPELINE PREVIOUS STEP — REFERENCE ONLY]");
		expect(seenTasks[1]).toContain("CHAIN_TOKEN_TEST");
		expect(seenTasks[1]).toContain("[REQUEST — AUTHORITATIVE]\nstep two");
		expect(sent[0]?.message.content).toContain("[subagent-chain#");
		expect(sent[0]?.message.content).toContain("CHAIN_SEEN_OK");
		expect(sent[0]?.message.content).not.toContain("[subagent:worker-fast#");
		expect(sent[0]?.message.content).not.toContain("[subagent:reviewer#");
	});
});
