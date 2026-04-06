import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { createStreamState, processClaudeEvent, stateToSingleResult } from "../subagent/claude-stream-parser.ts";

const FIXTURE_DIR = path.resolve(import.meta.dirname, "../subagent/fixtures/claude-stream");

function loadFixture(name: string): string[] {
	const content = fs.readFileSync(path.join(FIXTURE_DIR, name), "utf-8");
	return content
		.split("\n")
		.map((l) => l.trim())
		.filter(Boolean);
}

function replayFixture(name: string) {
	const lines = loadFixture(name);
	const state = createStreamState();
	let gotResult = false;
	for (const line of lines) {
		const event = JSON.parse(line);
		const isResult = processClaudeEvent(state, event);
		if (isResult) gotResult = true;
	}
	return { state, gotResult };
}

describe("claude-stream-parser: basic-text fixture", () => {
	it("extracts session_id from the first event", () => {
		const { state } = replayFixture("basic-text.ndjson");
		expect(state.sessionId).toBe("9a2fd52a-0125-482b-b39d-1073cf29878d");
	});

	it("extracts model from stream events", () => {
		const { state } = replayFixture("basic-text.ndjson");
		expect(state.model).toContain("claude-opus");
	});

	it("receives result event", () => {
		const { gotResult } = replayFixture("basic-text.ndjson");
		expect(gotResult).toBe(true);
	});

	it("sets resultReceived flag", () => {
		const { state } = replayFixture("basic-text.ndjson");
		expect(state.resultReceived).toBe(true);
	});

	it("is not an error", () => {
		const { state } = replayFixture("basic-text.ndjson");
		expect(state.isError).toBe(false);
	});

	it("has stop_reason end_turn", () => {
		const { state } = replayFixture("basic-text.ndjson");
		expect(state.stopReason).toBe("end_turn");
	});

	it("captures assistant message", () => {
		const { state } = replayFixture("basic-text.ndjson");
		const assistantMsgs = state.messages.filter((m) => m.role === "assistant");
		expect(assistantMsgs.length).toBe(1);
		const textBlock = assistantMsgs[0].content.find((b: any) => b.type === "text");
		expect(textBlock).toBeDefined();
		expect((textBlock as any).text).toContain("안녕하세요");
	});

	it("has no permission denials", () => {
		const { state } = replayFixture("basic-text.ndjson");
		expect(state.permissionDenials).toHaveLength(0);
	});

	it("produces valid SingleResult via stateToSingleResult", () => {
		const { state } = replayFixture("basic-text.ndjson");
		const result = stateToSingleResult(state, "test-agent", "project", "say hello", 0, undefined, "");
		expect(result.runtime).toBe("claude");
		expect(result.claudeSessionId).toBe("9a2fd52a-0125-482b-b39d-1073cf29878d");
		expect(result.exitCode).toBe(0);
		expect(result.messages.length).toBeGreaterThan(0);
		expect(result.usage.turns).toBeGreaterThan(0);
		expect(result.usage.cost).toBeGreaterThan(0);
	});
});

describe("claude-stream-parser: tool-call fixture", () => {
	it("captures two turns (tool use + final text)", () => {
		const { state } = replayFixture("tool-call.ndjson");
		expect(state.usage.turns).toBe(2);
	});

	it("has assistant messages with tool_use content", () => {
		const { state } = replayFixture("tool-call.ndjson");
		const assistantMsgs = state.messages.filter((m) => m.role === "assistant");
		const toolCallMsg = assistantMsgs.find((m) => m.content.some((b: any) => b.type === "toolCall"));
		expect(toolCallMsg).toBeDefined();
		const toolCall = toolCallMsg?.content.find((b: any) => b.type === "toolCall") as any;
		expect(toolCall.name).toBe("Bash");
		expect(toolCall.arguments.command).toBe("printf tool-ok");
	});

	it("has user messages with tool_result", () => {
		const { state } = replayFixture("tool-call.ndjson");
		const userMsgs = state.messages.filter((m) => m.role === "user");
		expect(userMsgs.length).toBeGreaterThan(0);
	});

	it("increments liveToolCalls during streaming", () => {
		const lines = loadFixture("tool-call.ndjson");
		const state = createStreamState();
		let maxToolCalls = 0;
		for (const line of lines) {
			const event = JSON.parse(line);
			processClaudeEvent(state, event);
			if (state.liveToolCalls > maxToolCalls) maxToolCalls = state.liveToolCalls;
		}
		expect(maxToolCalls).toBeGreaterThanOrEqual(1);
	});

	it("has stop_reason end_turn", () => {
		const { state } = replayFixture("tool-call.ndjson");
		expect(state.stopReason).toBe("end_turn");
	});

	it("has session_id consistent throughout", () => {
		const { state } = replayFixture("tool-call.ndjson");
		expect(state.sessionId).toBe("27eea22a-65df-4547-9bf9-1628513b94c0");
	});
});

describe("claude-stream-parser: long-running fixture", () => {
	it("captures multi-turn result with tool use", () => {
		const { state, gotResult } = replayFixture("long-running.ndjson");
		expect(gotResult).toBe(true);
		expect(state.usage.turns).toBe(2);
	});

	it("final result text matches fixture", () => {
		const { state } = replayFixture("long-running.ndjson");
		expect(state.resultEvent.result).toContain("step-1");
	});

	it("duration is captured from result event", () => {
		const { state } = replayFixture("long-running.ndjson");
		expect(state.resultEvent.duration_ms).toBe(12450);
	});
});

describe("claude-stream-parser: error (permission denial) fixture", () => {
	it("detects permission denials", () => {
		const { state } = replayFixture("error.ndjson");
		expect(state.permissionDenials.length).toBeGreaterThan(0);
		expect(state.permissionDenials[0].tool_name).toBe("Bash");
	});

	it("is_error is false (run itself succeeded)", () => {
		const { state } = replayFixture("error.ndjson");
		expect(state.isError).toBe(false);
	});

	it("stateToSingleResult includes permission denial error message", () => {
		const { state } = replayFixture("error.ndjson");
		const result = stateToSingleResult(state, "test-agent", "project", "test", 0, undefined, "");
		expect(result.errorMessage).toContain("Permission denied");
		expect(result.errorMessage).toContain("Bash");
	});

	it("captures the user tool_result with is_error", () => {
		const { state } = replayFixture("error.ndjson");
		const userMsgs = state.messages.filter((m) => m.role === "user");
		expect(userMsgs.length).toBeGreaterThan(0);
	});
});

describe("claude-stream-parser: bare-auth-error fixture", () => {
	it("is_error is true", () => {
		const { state } = replayFixture("bare-auth-error.ndjson");
		expect(state.isError).toBe(true);
	});

	it("captures error message from result", () => {
		const { state } = replayFixture("bare-auth-error.ndjson");
		expect(state.errorMessage).toContain("Not logged in");
	});

	it("has stop_reason stop_sequence", () => {
		const { state } = replayFixture("bare-auth-error.ndjson");
		expect(state.stopReason).toBe("stop_sequence");
	});

	it("duration is very short", () => {
		const { state } = replayFixture("bare-auth-error.ndjson");
		expect(state.resultEvent.duration_ms).toBeLessThan(1000);
	});

	it("stateToSingleResult sets exitCode 1 for errors", () => {
		const { state } = replayFixture("bare-auth-error.ndjson");
		const result = stateToSingleResult(state, "test-agent", "project", "test", 1, undefined, "");
		expect(result.exitCode).toBe(1);
		expect(result.runtime).toBe("claude");
	});
});

describe("claude-stream-parser: createStreamState", () => {
	it("returns a clean initial state", () => {
		const state = createStreamState();
		expect(state.sessionId).toBeUndefined();
		expect(state.model).toBeUndefined();
		expect(state.messages).toHaveLength(0);
		expect(state.liveText).toBeUndefined();
		expect(state.liveToolCalls).toBe(0);
		expect(state.resultReceived).toBe(false);
		expect(state.isError).toBe(false);
		expect(state.permissionDenials).toHaveLength(0);
		expect(state.usage.input).toBe(0);
	});
});

describe("claude-stream-parser: processClaudeEvent edge cases", () => {
	it("handles unknown event types gracefully", () => {
		const state = createStreamState();
		const result = processClaudeEvent(state, { type: "unknown_type" });
		expect(result).toBe(false);
	});

	it("handles rate_limit_event without error", () => {
		const state = createStreamState();
		const result = processClaudeEvent(state, {
			type: "rate_limit_event",
			rate_limit_info: { status: "allowed" },
		});
		expect(result).toBe(false);
	});

	it("captures session_id from any event with session_id", () => {
		const state = createStreamState();
		processClaudeEvent(state, {
			type: "system",
			subtype: "hook_started",
			session_id: "test-session-123",
		});
		expect(state.sessionId).toBe("test-session-123");
	});

	it("does not overwrite session_id once set", () => {
		const state = createStreamState();
		processClaudeEvent(state, { type: "system", subtype: "hook_started", session_id: "first" });
		processClaudeEvent(state, { type: "system", subtype: "hook_started", session_id: "second" });
		expect(state.sessionId).toBe("first");
	});

	it("accumulates liveText from text_delta events", () => {
		const state = createStreamState();
		processClaudeEvent(state, {
			type: "stream_event",
			event: { type: "content_block_start", content_block: { type: "text", text: "" } },
		});
		processClaudeEvent(state, {
			type: "stream_event",
			event: { type: "content_block_delta", delta: { type: "text_delta", text: "Hello " } },
		});
		processClaudeEvent(state, {
			type: "stream_event",
			event: { type: "content_block_delta", delta: { type: "text_delta", text: "world" } },
		});
		expect(state.liveText).toBe("Hello world");
	});

	it("clears liveText on assistant snapshot", () => {
		const state = createStreamState();
		state.liveText = "some text";
		processClaudeEvent(state, {
			type: "assistant",
			message: {
				model: "claude-opus-4-6",
				role: "assistant",
				content: [{ type: "text", text: "final text" }],
			},
		});
		expect(state.liveText).toBeUndefined();
	});

	it("tracks tool_use content_block_start", () => {
		const state = createStreamState();
		processClaudeEvent(state, {
			type: "stream_event",
			event: {
				type: "content_block_start",
				content_block: { type: "tool_use", id: "toolu_123", name: "Bash", input: {} },
			},
		});
		expect(state.liveToolCalls).toBe(1);
		expect(state.currentToolName).toBe("Bash");
	});
});
