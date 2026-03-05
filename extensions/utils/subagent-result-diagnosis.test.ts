import { describe, expect, it } from "vitest";
import { diagnoseResultFailure } from "../subagent/tool-execute.ts";
import type { SingleResult } from "../subagent/types.ts";

function makeResult(partial: Partial<SingleResult>): SingleResult {
	return {
		agent: "worker",
		agentSource: "project",
		task: "task",
		exitCode: 0,
		messages: [],
		stderr: "",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
		...partial,
	};
}

describe("diagnoseResultFailure", () => {
	it("fails when subagent returns no messages and no output", () => {
		const result = makeResult({ messages: [], stderr: "" });
		const diagnosis = diagnoseResultFailure(result);
		expect(diagnosis.failed).toBe(true);
		expect(diagnosis.reason).toContain("no messages");
	});

	it("fails with explicit exit code reason", () => {
		const result = makeResult({ exitCode: 2 });
		const diagnosis = diagnoseResultFailure(result);
		expect(diagnosis.failed).toBe(true);
		expect(diagnosis.reason).toContain("code 2");
	});

	it("passes when assistant text exists", () => {
		const result = makeResult({
			messages: [{ role: "assistant", content: [{ type: "text", text: "done" }] } as any],
		});
		const diagnosis = diagnoseResultFailure(result);
		expect(diagnosis.failed).toBe(false);
	});
});
