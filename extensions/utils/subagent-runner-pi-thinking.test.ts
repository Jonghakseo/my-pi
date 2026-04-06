import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const spawnMock = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", () => ({
	spawn: (...args: unknown[]) => spawnMock(...args),
}));

type MockProc = EventEmitter & {
	stdout: EventEmitter;
	stderr: EventEmitter;
	exitCode: number | null;
	kill: ReturnType<typeof vi.fn>;
};

function makePiAgent() {
	return {
		name: "pi-worker",
		description: "PI worker",
		systemPrompt: "Test prompt",
		source: "user" as const,
		filePath: "/tmp/pi-worker.md",
		runtime: "pi" as const,
	};
}

function makeDetails(results: any[]) {
	return {
		mode: "single" as const,
		inheritMainContext: false,
		projectAgentsDir: null,
		results,
	};
}

function makeHangingProcess(lines: string[]): MockProc {
	const proc = new EventEmitter() as MockProc;
	proc.stdout = new EventEmitter();
	proc.stderr = new EventEmitter();
	proc.exitCode = null;
	proc.kill = vi.fn((signal?: string) => {
		proc.exitCode = signal === "SIGKILL" ? 137 : 0;
		return true;
	});

	queueMicrotask(() => {
		proc.stdout.emit("data", Buffer.from(`${lines.join("\n")}\n`, "utf8"));
	});

	return proc;
}

describe("runSingleAgent pi terminal message fallback", () => {
	beforeEach(() => {
		spawnMock.mockReset();
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.clearAllMocks();
	});

	it("force-resolves after a terminal assistant message even if the pi child never exits", async () => {
		vi.useFakeTimers();
		const { runSingleAgent } = await import("../subagent/runner.ts");
		spawnMock.mockImplementationOnce(() =>
			makeHangingProcess([
				JSON.stringify({ type: "agent_start" }),
				JSON.stringify({
					type: "message_end",
					message: {
						role: "assistant",
						model: "test-model",
						content: [{ type: "text", text: "Final answer" }],
						stopReason: "stop",
					},
				}),
			]),
		);

		const resultPromise = runSingleAgent(
			"/tmp/project",
			[makePiAgent()],
			"pi-worker",
			"review task",
			undefined,
			undefined,
			undefined,
			makeDetails,
		);

		await vi.runAllTicks();
		await vi.advanceTimersByTimeAsync(3000);
		const result = await resultPromise;
		await vi.runOnlyPendingTimersAsync();

		expect(result.exitCode).toBe(0);
		expect(result.messages).toHaveLength(1);
		expect(result.messages[0]?.role).toBe("assistant");
		expect(spawnMock).toHaveBeenCalledTimes(1);
		const proc = spawnMock.mock.results[0]?.value as MockProc;
		expect(proc.kill).toHaveBeenCalledWith("SIGTERM");
	});
});
