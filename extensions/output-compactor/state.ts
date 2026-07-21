import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const STATE_FILE = join(homedir(), ".pi", "agent", "state", "output-compactor-sessions.json");
const MAX_ENTRIES = 300;
const PRUNE_TARGET = 240;

interface TrackedFile {
	/** 원본 출력의 추정 토큰 수 (되돌릴 때 차감할 값) */
	original: number;
	/** 에이전트가 이 tmp 원본을 이미 다시 읽어 절감이 취소되었는지 */
	reversed: boolean;
}

interface SessionStat {
	/** 순 절감 토큰 (원본이 다시 읽히면 마이너스로 전환) */
	net: number;
	/** 압축으로 생성한 tmp 경로별 추적 정보 */
	files: Record<string, TrackedFile>;
	ts: number;
}

interface PersistedState {
	version: 1;
	sessions: Record<string, SessionStat>;
}

let cache: PersistedState | undefined;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseFiles(raw: unknown): Record<string, TrackedFile> {
	const files: Record<string, TrackedFile> = {};
	if (!isRecord(raw)) return files;
	for (const [p, f] of Object.entries(raw)) {
		if (isRecord(f) && typeof f.original === "number") {
			files[p] = { original: f.original, reversed: f.reversed === true };
		}
	}
	return files;
}

function parseSession(raw: unknown): SessionStat | undefined {
	if (!isRecord(raw) || typeof raw.net !== "number") return undefined;
	return {
		net: raw.net,
		files: parseFiles(raw.files),
		ts: typeof raw.ts === "number" ? raw.ts : Date.now(),
	};
}

function load(): PersistedState {
	if (cache) return cache;
	try {
		const raw = JSON.parse(readFileSync(STATE_FILE, "utf-8")) as unknown;
		if (isRecord(raw) && raw.version === 1 && isRecord(raw.sessions)) {
			const sessions: Record<string, SessionStat> = {};
			for (const [id, s] of Object.entries(raw.sessions)) {
				const parsed = parseSession(s);
				if (parsed) sessions[id] = parsed;
			}
			cache = { version: 1, sessions };
			return cache;
		}
	} catch {
		// missing/corrupt — fall through to default
	}
	cache = { version: 1, sessions: {} };
	return cache;
}

function save(state: PersistedState): void {
	const ids = Object.keys(state.sessions);
	if (ids.length > MAX_ENTRIES) {
		const sorted = ids.sort((a, b) => state.sessions[a].ts - state.sessions[b].ts);
		for (const id of sorted.slice(0, ids.length - PRUNE_TARGET)) delete state.sessions[id];
	}
	try {
		mkdirSync(dirname(STATE_FILE), { recursive: true });
		writeFileSync(STATE_FILE, `${JSON.stringify(state, null, "\t")}\n`, "utf-8");
	} catch {
		// disk write 실패는 무시 — 메모리 캐시만 유지
	}
	cache = state;
}

function ensureSession(state: PersistedState, sessionId: string): SessionStat {
	let s = state.sessions[sessionId];
	if (!s) {
		s = { net: 0, files: {}, ts: Date.now() };
		state.sessions[sessionId] = s;
	}
	return s;
}

/** 세션의 현재 순 절감 토큰. */
export function getNetSaved(sessionId: string): number {
	if (!sessionId) return 0;
	return load().sessions[sessionId]?.net ?? 0;
}

/** 압축 1건 기록: net += saved, tmp 경로 추적 시작. */
export function recordCompaction(
	sessionId: string,
	tmpPath: string,
	originalTokens: number,
	savedTokens: number,
): void {
	if (!sessionId) return;
	const state = load();
	const s = ensureSession(state, sessionId);
	s.net += savedTokens;
	s.files[tmpPath] = { original: originalTokens, reversed: false };
	s.ts = Date.now();
	save(state);
}

/**
 * 추적 중인 tmp 원본을 에이전트가 다시 읽으면 절감을 취소한다.
 * net -= original 이므로 해당 건은 결과적으로 마이너스(주입한 요약분 오버헤드)로 전환된다.
 * 이미 되돌린 파일이면 아무 것도 하지 않는다. 실제로 되돌렸을 때만 true.
 */
export function reverseIfTracked(sessionId: string, readPath: string): boolean {
	if (!sessionId || !readPath) return false;
	const state = load();
	const s = state.sessions[sessionId];
	const tracked = s?.files[readPath];
	if (!s || !tracked || tracked.reversed) return false;
	s.net -= tracked.original;
	tracked.reversed = true;
	s.ts = Date.now();
	save(state);
	return true;
}
