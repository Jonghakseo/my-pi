import { appendFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const LOG_FILE = join(homedir(), ".pi", "agent", "state", "output-compactor-log.jsonl");

export interface CompactionLogEntry {
	ts: number;
	sessionId: string;
	command: string;
	originalBytes: number;
	summaryBytes: number;
	reductionPct: number;
	savedTokens: number;
}

/** 압축 1건을 JSONL로 append. 실패는 조용히 무시(핵심 경로를 막지 않음). */
export function appendCompactionLog(entry: CompactionLogEntry): void {
	try {
		mkdirSync(dirname(LOG_FILE), { recursive: true });
		appendFileSync(LOG_FILE, `${JSON.stringify(entry)}\n`, "utf-8");
	} catch {
		// 로그 실패는 무시
	}
}
