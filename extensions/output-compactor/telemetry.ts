import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const LOG_FILE = join(homedir(), ".pi", "agent", "state", "output-compactor-log.jsonl");

export type CompactionSkipReason =
	| "model_unavailable"
	| "original_save_failed"
	| "compression_failed_or_timed_out"
	| "no_benefit";

export interface CompactionEvent {
	event: "compaction";
	schemaVersion: 2;
	ts: number;
	sessionId: string;
	command: string;
	outputPath: string;
	thresholdBytes: number;
	originalBytes: number;
	summaryBytes: number;
	replacementBytes: number;
	reductionPct: number;
	effectiveReductionPct: number;
	originalTokens: number;
	summaryTokens: number;
	replacementTokens: number;
	savedTokens: number;
	modelDurationMs: number;
}

export interface CompactionSkipEvent {
	event: "skipped";
	schemaVersion: 2;
	ts: number;
	sessionId: string;
	command: string;
	thresholdBytes: number;
	originalBytes: number;
	reason: CompactionSkipReason;
	summaryBytes?: number;
	modelDurationMs?: number;
}

export interface CompactionReversalEvent {
	event: "reversal";
	schemaVersion: 2;
	ts: number;
	sessionId: string;
	outputPath: string;
	originalTokens: number;
}

interface LegacyCompactionEvent {
	event?: undefined;
	ts: number;
	sessionId: string;
	command: string;
	originalBytes: number;
	summaryBytes: number;
	reductionPct: number;
	savedTokens: number;
}

type CompactionLogEvent = CompactionEvent | CompactionSkipEvent | CompactionReversalEvent | LegacyCompactionEvent;

export interface SessionSummary {
	/** Footer-compatible net token saving. A re-read subtracts the original token count. */
	netSavedTokens: number;
	/** Number of successful compactions. */
	count: number;
	grossSavedTokens: number;
	reversedCount: number;
	reversalPenaltyTokens: number;
}

export interface MonitoringSummary {
	attemptedCount: number;
	compactionCount: number;
	skippedCount: number;
	skippedByReason: Partial<Record<CompactionSkipReason, number>>;
	grossSavedTokens: number;
	netSavedTokens: number;
	reversedCount: number;
	reversalPenaltyTokens: number;
	originalBytes: number;
	replacementBytes: number;
	effectiveReductionPct: number;
	averageModelDurationMs: number | undefined;
}

export interface CompactionTelemetry {
	getSessionStats(sessionId: string): SessionSummary;
	getMonitoringSummary(): MonitoringSummary;
	recordCompaction(entry: Omit<CompactionEvent, "event" | "schemaVersion">): boolean;
	recordSkip(entry: Omit<CompactionSkipEvent, "event" | "schemaVersion">): boolean;
	reverseIfTracked(sessionId: string, outputPath: string, ts?: number): boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNumber(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value);
}

function isString(value: unknown): value is string {
	return typeof value === "string";
}

function isSkipReason(value: unknown): value is CompactionSkipReason {
	return (
		value === "model_unavailable" ||
		value === "original_save_failed" ||
		value === "compression_failed_or_timed_out" ||
		value === "no_benefit"
	);
}

function parseEvent(value: unknown): CompactionLogEvent | undefined {
	if (!isRecord(value) || !isNumber(value.ts) || !isString(value.sessionId)) return undefined;

	if (value.event === "compaction") {
		if (
			!isString(value.command) ||
			!isString(value.outputPath) ||
			!isNumber(value.thresholdBytes) ||
			!isNumber(value.originalBytes) ||
			!isNumber(value.summaryBytes) ||
			!isNumber(value.replacementBytes) ||
			!isNumber(value.reductionPct) ||
			!isNumber(value.effectiveReductionPct) ||
			!isNumber(value.originalTokens) ||
			!isNumber(value.summaryTokens) ||
			!isNumber(value.replacementTokens) ||
			!isNumber(value.savedTokens) ||
			!isNumber(value.modelDurationMs)
		) {
			return undefined;
		}
		return {
			event: "compaction",
			schemaVersion: 2,
			ts: value.ts,
			sessionId: value.sessionId,
			command: value.command,
			outputPath: value.outputPath,
			thresholdBytes: value.thresholdBytes,
			originalBytes: value.originalBytes,
			summaryBytes: value.summaryBytes,
			replacementBytes: value.replacementBytes,
			reductionPct: value.reductionPct,
			effectiveReductionPct: value.effectiveReductionPct,
			originalTokens: value.originalTokens,
			summaryTokens: value.summaryTokens,
			replacementTokens: value.replacementTokens,
			savedTokens: value.savedTokens,
			modelDurationMs: value.modelDurationMs,
		};
	}

	if (value.event === "skipped") {
		if (
			!isString(value.command) ||
			!isNumber(value.thresholdBytes) ||
			!isNumber(value.originalBytes) ||
			!isSkipReason(value.reason) ||
			(value.summaryBytes !== undefined && !isNumber(value.summaryBytes)) ||
			(value.modelDurationMs !== undefined && !isNumber(value.modelDurationMs))
		) {
			return undefined;
		}
		return {
			event: "skipped",
			schemaVersion: 2,
			ts: value.ts,
			sessionId: value.sessionId,
			command: value.command,
			thresholdBytes: value.thresholdBytes,
			originalBytes: value.originalBytes,
			reason: value.reason,
			summaryBytes: value.summaryBytes,
			modelDurationMs: value.modelDurationMs,
		};
	}

	if (value.event === "reversal") {
		if (!isString(value.outputPath) || !isNumber(value.originalTokens)) return undefined;
		return {
			event: "reversal",
			schemaVersion: 2,
			ts: value.ts,
			sessionId: value.sessionId,
			outputPath: value.outputPath,
			originalTokens: value.originalTokens,
		};
	}

	// v1 telemetry only recorded successful compactions. Retain it for historical gross-saving reports.
	if (
		isString(value.command) &&
		isNumber(value.originalBytes) &&
		isNumber(value.summaryBytes) &&
		isNumber(value.reductionPct) &&
		isNumber(value.savedTokens)
	) {
		return {
			ts: value.ts,
			sessionId: value.sessionId,
			command: value.command,
			originalBytes: value.originalBytes,
			summaryBytes: value.summaryBytes,
			reductionPct: value.reductionPct,
			savedTokens: value.savedTokens,
		};
	}
	return undefined;
}

function readEvents(logFile: string): CompactionLogEvent[] {
	try {
		return readFileSync(logFile, "utf-8")
			.split("\n")
			.filter(Boolean)
			.flatMap((line) => {
				try {
					const event = parseEvent(JSON.parse(line) as unknown);
					return event ? [event] : [];
				} catch {
					return [];
				}
			});
	} catch {
		return [];
	}
}

function appendEvent(logFile: string, event: CompactionLogEvent): boolean {
	try {
		mkdirSync(dirname(logFile), { recursive: true });
		appendFileSync(logFile, `${JSON.stringify(event)}\n`, "utf-8");
		return true;
	} catch {
		// Telemetry must never block compaction itself.
		return false;
	}
}

function isCompaction(event: CompactionLogEvent): event is CompactionEvent | LegacyCompactionEvent {
	return event.event === undefined || event.event === "compaction";
}

function outputKey(sessionId: string, outputPath: string): string {
	return `${sessionId}\u0000${outputPath}`;
}

function summarize(events: CompactionLogEvent[], sessionId?: string): SessionSummary {
	const result: SessionSummary = {
		netSavedTokens: 0,
		count: 0,
		grossSavedTokens: 0,
		reversedCount: 0,
		reversalPenaltyTokens: 0,
	};
	const compactionsByPath = new Map<string, CompactionEvent>();
	const reversedPaths = new Set<string>();

	for (const event of events) {
		if (sessionId !== undefined && event.sessionId !== sessionId) continue;
		if (isCompaction(event)) {
			result.count += 1;
			result.grossSavedTokens += event.savedTokens;
			result.netSavedTokens += event.savedTokens;
			if (event.event === "compaction") compactionsByPath.set(outputKey(event.sessionId, event.outputPath), event);
			continue;
		}
		if (event.event !== "reversal") continue;
		const key = outputKey(event.sessionId, event.outputPath);
		if (reversedPaths.has(key)) continue;
		const compaction = compactionsByPath.get(key);
		if (!compaction) continue;
		reversedPaths.add(key);
		result.reversedCount += 1;
		result.reversalPenaltyTokens += compaction.originalTokens;
		result.netSavedTokens -= compaction.originalTokens;
	}
	return result;
}

function summarizeMonitoring(events: CompactionLogEvent[]): MonitoringSummary {
	const sessionStats = summarize(events);
	const skippedByReason: Partial<Record<CompactionSkipReason, number>> = {};
	let originalBytes = 0;
	let replacementBytes = 0;
	let compactionCount = 0;
	let skippedCount = 0;
	let totalDurationMs = 0;
	let durationCount = 0;

	for (const event of events) {
		if (isCompaction(event)) {
			compactionCount += 1;
			originalBytes += event.originalBytes;
			replacementBytes += event.event === "compaction" ? event.replacementBytes : event.summaryBytes;
			if (event.event === "compaction") {
				totalDurationMs += event.modelDurationMs;
				durationCount += 1;
			}
			continue;
		}
		if (event.event !== "skipped") continue;
		skippedCount += 1;
		skippedByReason[event.reason] = (skippedByReason[event.reason] ?? 0) + 1;
		if (event.modelDurationMs !== undefined) {
			totalDurationMs += event.modelDurationMs;
			durationCount += 1;
		}
	}

	return {
		attemptedCount: compactionCount + skippedCount,
		compactionCount,
		skippedCount,
		skippedByReason,
		grossSavedTokens: sessionStats.grossSavedTokens,
		netSavedTokens: sessionStats.netSavedTokens,
		reversedCount: sessionStats.reversedCount,
		reversalPenaltyTokens: sessionStats.reversalPenaltyTokens,
		originalBytes,
		replacementBytes,
		effectiveReductionPct: originalBytes > 0 ? Math.round((1 - replacementBytes / originalBytes) * 100) : 0,
		averageModelDurationMs: durationCount > 0 ? Math.round(totalDurationMs / durationCount) : undefined,
	};
}

/**
 * Creates a JSONL-backed telemetry store. Every mutation is a single appended event; reads re-aggregate
 * the file, so concurrent Pi processes cannot overwrite one another's session statistics.
 */
export function createCompactionTelemetry(logFile = LOG_FILE): CompactionTelemetry {
	return {
		getSessionStats(sessionId) {
			if (!sessionId) return summarize([]);
			return summarize(readEvents(logFile), sessionId);
		},
		getMonitoringSummary() {
			return summarizeMonitoring(readEvents(logFile));
		},
		recordCompaction(entry) {
			return appendEvent(logFile, { event: "compaction", schemaVersion: 2, ...entry });
		},
		recordSkip(entry) {
			return appendEvent(logFile, { event: "skipped", schemaVersion: 2, ...entry });
		},
		reverseIfTracked(sessionId, outputPath, ts = Date.now()) {
			if (!sessionId || !outputPath) return false;
			const events = readEvents(logFile);
			const compaction = [...events]
				.reverse()
				.find(
					(event): event is CompactionEvent =>
						event.event === "compaction" && event.sessionId === sessionId && event.outputPath === outputPath,
				);
			const alreadyReversed = events.some(
				(event) => event.event === "reversal" && event.sessionId === sessionId && event.outputPath === outputPath,
			);
			if (!compaction || alreadyReversed) return false;
			return appendEvent(logFile, {
				event: "reversal",
				schemaVersion: 2,
				ts,
				sessionId,
				outputPath,
				originalTokens: compaction.originalTokens,
			});
		},
	};
}

const telemetry = createCompactionTelemetry();

export const getStats = telemetry.getSessionStats;
export const getMonitoringSummary = telemetry.getMonitoringSummary;
export const recordCompaction = telemetry.recordCompaction;
export const recordSkip = telemetry.recordSkip;
export const reverseIfTracked = telemetry.reverseIfTracked;
