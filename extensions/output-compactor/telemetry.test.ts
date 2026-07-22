import { appendFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createCompactionTelemetry } from "./telemetry.ts";

const tempDirs: string[] = [];

function createStore() {
	const dir = mkdtempSync(join(tmpdir(), "output-compactor-test-"));
	tempDirs.push(dir);
	return { logFile: join(dir, "events.jsonl"), telemetry: createCompactionTelemetry(join(dir, "events.jsonl")) };
}

function recordCompaction(
	telemetry: ReturnType<typeof createCompactionTelemetry>,
	overrides: Partial<Parameters<typeof telemetry.recordCompaction>[0]> = {},
) {
	return telemetry.recordCompaction({
		ts: 1,
		sessionId: "session-a",
		command: "xcodebuild test",
		outputPath: "/tmp/output-a.txt",
		thresholdBytes: 24 * 1024,
		originalBytes: 400,
		summaryBytes: 100,
		replacementBytes: 120,
		reductionPct: 75,
		effectiveReductionPct: 70,
		originalTokens: 100,
		summaryTokens: 25,
		replacementTokens: 30,
		savedTokens: 70,
		modelDurationMs: 200,
		...overrides,
	});
}

afterEach(() => {
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("output-compactor telemetry", () => {
	it("aggregates append-only events written by separate processes", () => {
		const { logFile, telemetry } = createStore();
		const anotherProcess = createCompactionTelemetry(logFile);

		expect(recordCompaction(telemetry)).toBe(true);
		expect(
			recordCompaction(anotherProcess, {
				ts: 2,
				outputPath: "/tmp/output-b.txt",
				savedTokens: 50,
				originalTokens: 80,
				replacementTokens: 30,
			}),
		).toBe(true);

		expect(telemetry.getSessionStats("session-a")).toMatchObject({
			count: 2,
			grossSavedTokens: 120,
			netSavedTokens: 120,
			reversedCount: 0,
		});
	});

	it("records a single reversal and charges the original re-read tokens", () => {
		const { telemetry } = createStore();
		recordCompaction(telemetry);

		expect(telemetry.reverseIfTracked("session-a", "/tmp/output-a.txt", 2)).toBe(true);
		expect(telemetry.reverseIfTracked("session-a", "/tmp/output-a.txt", 3)).toBe(false);
		expect(telemetry.getSessionStats("session-a")).toMatchObject({
			count: 1,
			grossSavedTokens: 70,
			netSavedTokens: -30,
			reversedCount: 1,
			reversalPenaltyTokens: 100,
		});
	});

	it("summarizes success, skipped outcomes, latency, and effective savings", () => {
		const { telemetry } = createStore();
		recordCompaction(telemetry);
		telemetry.recordSkip({
			ts: 2,
			sessionId: "session-a",
			command: "rg large-output",
			thresholdBytes: 24 * 1024,
			originalBytes: 300,
			reason: "no_benefit",
			summaryBytes: 320,
			modelDurationMs: 150,
		});
		telemetry.recordSkip({
			ts: 3,
			sessionId: "session-b",
			command: "pnpm test",
			thresholdBytes: 24 * 1024,
			originalBytes: 500,
			reason: "model_unavailable",
		});

		expect(telemetry.getMonitoringSummary()).toMatchObject({
			attemptedCount: 3,
			compactionCount: 1,
			skippedCount: 2,
			skippedByReason: { no_benefit: 1, model_unavailable: 1 },
			grossSavedTokens: 70,
			averageModelDurationMs: 175,
		});
	});

	it("includes legacy compaction records without requiring migration", () => {
		const { logFile, telemetry } = createStore();
		appendFileSync(
			logFile,
			`${JSON.stringify({
				ts: 1,
				sessionId: "legacy-session",
				command: "git push",
				originalBytes: 400,
				summaryBytes: 100,
				reductionPct: 75,
				savedTokens: 70,
			})}\nnot-json\n`,
		);

		expect(telemetry.getSessionStats("legacy-session")).toMatchObject({
			count: 1,
			grossSavedTokens: 70,
			netSavedTokens: 70,
		});
	});
});
