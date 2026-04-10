import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const sdkRunnerMock = vi.hoisted(() => vi.fn());

vi.mock("../subagent/claude-sdk-runner.js", () => ({
	runClaudeAgentViaSdk: sdkRunnerMock,
}));

describe("runSingleAgent SDK dispatch", () => {
	const originalRuntime = process.env.PI_CLAUDE_RUNTIME;

	beforeEach(() => {
		process.env.PI_CLAUDE_RUNTIME = "sdk";
		sdkRunnerMock.mockReset();
		vi.resetModules();
	});

	afterEach(() => {
		if (originalRuntime === undefined) process.env.PI_CLAUDE_RUNTIME = undefined;
		else process.env.PI_CLAUDE_RUNTIME = originalRuntime;
	});

	it("uses runClaudeAgentViaSdk when PI_CLAUDE_RUNTIME=sdk", async () => {
		sdkRunnerMock.mockResolvedValue({
			agent: "worker",
			agentSource: "project",
			task: "do work",
			exitCode: 0,
			messages: [],
			stderr: "",
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
			runtime: "claude",
		});

		const { runSingleAgent } = await import("../subagent/runner.ts");
		const result = await runSingleAgent(
			"/tmp/project",
			[
				{
					name: "worker",
					description: "Worker",
					tools: ["read"],
					model: "claude-sonnet-4-6",
					systemPrompt: "Follow instructions.",
					source: "project",
					filePath: "/tmp/worker.md",
					runtime: "claude",
				},
			],
			"worker",
			"do work",
			undefined,
			undefined,
			undefined,
			(results) => ({ mode: "single", inheritMainContext: false, projectAgentsDir: null, results }),
			{ sidecarSessionFile: "/tmp/project/sidecar.jsonl" },
		);

		expect(result.exitCode).toBe(0);
		expect(sdkRunnerMock).toHaveBeenCalledTimes(1);
		expect(sdkRunnerMock).toHaveBeenCalledWith(
			"/tmp/project",
			expect.objectContaining({ name: "worker" }),
			"do work",
			undefined,
			undefined,
			undefined,
			expect.any(Function),
			undefined,
			"/tmp/project/sidecar.jsonl",
		);
	});
});
