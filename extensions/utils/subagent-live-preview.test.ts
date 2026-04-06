import { describe, expect, it } from "vitest";
import { createStreamState, processClaudeEvent, stateToSingleResult } from "../subagent/claude-stream-parser.ts";
import { updateRunFromResult } from "../subagent/store.ts";
import type { CommandRunState } from "../subagent/types.ts";

function makeRunState(overrides: Partial<CommandRunState> = {}): CommandRunState {
	return {
		id: 1,
		agent: "test",
		task: "test task",
		status: "running",
		startedAt: Date.now() - 5000,
		elapsedMs: 5000,
		toolCalls: 0,
		lastLine: "",
		turnCount: 0,
		lastActivityAt: Date.now() - 5000,
		...overrides,
	};
}

describe("liveActivityPreview generation", () => {
	it("sets preview on tool_use content_block_start", () => {
		const state = createStreamState();
		processClaudeEvent(state, {
			type: "stream_event",
			event: {
				type: "content_block_start",
				index: 0,
				content_block: { type: "tool_use", id: "toolu_1", name: "Bash", input: {} },
			},
		});

		expect(state.liveActivityPreview).toBe("\u2192 Bash");
		expect(state.currentToolName).toBe("Bash");
	});

	it("updates preview with args during input_json_delta", () => {
		const state = createStreamState();
		processClaudeEvent(state, {
			type: "stream_event",
			event: {
				type: "content_block_start",
				index: 0,
				content_block: { type: "tool_use", id: "toolu_1", name: "Bash", input: {} },
			},
		});
		processClaudeEvent(state, {
			type: "stream_event",
			event: {
				type: "content_block_delta",
				index: 0,
				delta: { type: "input_json_delta", partial_json: '{"command":' },
			},
		});
		processClaudeEvent(state, {
			type: "stream_event",
			event: {
				type: "content_block_delta",
				index: 0,
				delta: { type: "input_json_delta", partial_json: ' "ls -la"}' },
			},
		});

		expect(state.liveActivityPreview).toContain("\u2192 Bash(");
		expect(state.liveActivityPreview).toContain('"command":');
	});

	it("updates preview with text during text_delta", () => {
		const state = createStreamState();
		processClaudeEvent(state, {
			type: "stream_event",
			event: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
		});
		processClaudeEvent(state, {
			type: "stream_event",
			event: {
				type: "content_block_delta",
				index: 0,
				delta: { type: "text_delta", text: "Hello world\nSecond line" },
			},
		});

		expect(state.liveActivityPreview).toBe("Second line");
	});
});

describe("stateToSingleResult transfers liveActivityPreview", () => {
	it("includes liveActivityPreview in result", () => {
		const state = createStreamState();
		state.liveActivityPreview = '\u2192 Bash({"command": "ls"})';

		const result = stateToSingleResult(state, "test", "user", "task", 0, undefined, "");
		expect(result.liveActivityPreview).toBe('\u2192 Bash({"command": "ls"})');
	});

	it("omits liveActivityPreview when undefined", () => {
		const state = createStreamState();
		const result = stateToSingleResult(state, "test", "user", "task", 0, undefined, "");
		expect(result.liveActivityPreview).toBeUndefined();
	});
});

describe("updateRunFromResult with liveActivityPreview", () => {
	it("uses liveActivityPreview for lastLine when present", () => {
		const run = makeRunState();
		updateRunFromResult(run, {
			agent: "test",
			agentSource: "user",
			task: "task",
			exitCode: 0,
			messages: [],
			stderr: "",
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
			liveActivityPreview: '\u2192 Bash({"command": "ls"})',
		});

		expect(run.lastLine).toBe('\u2192 Bash({"command": "ls"})');
	});

	it("updates lastActivityAt when liveActivityPreview is present even without display changes", () => {
		const oldTimestamp = Date.now() - 30000;
		const run = makeRunState({
			lastActivityAt: oldTimestamp,
			lastLine: "\u2192 Bash",
		});

		updateRunFromResult(run, {
			agent: "test",
			agentSource: "user",
			task: "task",
			exitCode: 0,
			messages: [],
			stderr: "",
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
			liveActivityPreview: "\u2192 Bash",
		});

		expect(run.lastActivityAt).toBeGreaterThan(oldTimestamp);
	});

	it("updates lastActivityAt when liveText is present", () => {
		const oldTimestamp = Date.now() - 30000;
		const run = makeRunState({ lastActivityAt: oldTimestamp });

		updateRunFromResult(run, {
			agent: "test",
			agentSource: "user",
			task: "task",
			exitCode: 0,
			messages: [],
			stderr: "",
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
			liveText: "streaming text",
		});

		expect(run.lastActivityAt).toBeGreaterThan(oldTimestamp);
	});

	it("updates lastActivityAt when liveThinking is present", () => {
		const oldTimestamp = Date.now() - 30000;
		const run = makeRunState({ lastActivityAt: oldTimestamp });

		updateRunFromResult(run, {
			agent: "test",
			agentSource: "user",
			task: "task",
			exitCode: 0,
			messages: [],
			stderr: "",
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
			liveThinking: "analyzing edge cases",
		});

		expect(run.lastActivityAt).toBeGreaterThan(oldTimestamp);
	});

	it("updates lastActivityAt when thoughtText changes", () => {
		const oldTimestamp = Date.now() - 30000;
		const run = makeRunState({ lastActivityAt: oldTimestamp, thoughtText: "old thought" });

		updateRunFromResult(run, {
			agent: "test",
			agentSource: "user",
			task: "task",
			exitCode: 0,
			messages: [],
			stderr: "",
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
			thoughtText: "new thought",
		});

		expect(run.lastActivityAt).toBeGreaterThan(oldTimestamp);
	});

	it("does not update lastActivityAt without any live activity or state changes", () => {
		const oldTimestamp = Date.now() - 30000;
		const run = makeRunState({ lastActivityAt: oldTimestamp });

		updateRunFromResult(run, {
			agent: "test",
			agentSource: "user",
			task: "task",
			exitCode: 0,
			messages: [],
			stderr: "",
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
		});

		expect(run.lastActivityAt).toBe(oldTimestamp);
	});
});

describe("full stream fixture replay for hang detection", () => {
	it("processes tool-call fixture without losing liveActivityPreview", async () => {
		const fs = await import("node:fs");
		const fixturePath = new URL("../subagent/fixtures/claude-stream/tool-call.ndjson", import.meta.url).pathname;
		const lines = fs
			.readFileSync(fixturePath, "utf-8")
			.split("\n")
			.filter((l: string) => l.trim());

		const state = createStreamState();
		let previewSeen = false;
		let lastActivityUpdates = 0;
		const run = makeRunState();

		for (const line of lines) {
			let event: any;
			try {
				event = JSON.parse(line);
			} catch {
				continue;
			}

			processClaudeEvent(state, event);

			if (state.liveActivityPreview) {
				previewSeen = true;
			}

			const result = stateToSingleResult(state, "test", "user", "task", 0, undefined, "");
			result.liveText = state.liveText;
			result.liveToolCalls = state.liveToolCalls;
			result.liveActivityPreview = state.liveActivityPreview;

			const prevActivity = run.lastActivityAt;
			updateRunFromResult(run, result);
			if (run.lastActivityAt > prevActivity) {
				lastActivityUpdates++;
			}
		}

		expect(previewSeen).toBe(true);
		expect(lastActivityUpdates).toBeGreaterThan(0);
	});
});
