import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const STATE_FILE = join(homedir(), ".pi", "agent", "state", "notify-sessions.json");
const MAX_ENTRIES = 500;
const PRUNE_TARGET = 400;

interface PersistedState {
	version: 1;
	enabled: Record<string, number>;
}

let cache: PersistedState | undefined;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function load(): PersistedState {
	if (cache) return cache;

	try {
		const raw = JSON.parse(readFileSync(STATE_FILE, "utf-8")) as unknown;
		if (isRecord(raw) && raw.version === 1 && isRecord(raw.enabled)) {
			const enabled: Record<string, number> = {};
			for (const [id, ts] of Object.entries(raw.enabled)) {
				if (typeof ts === "number" && Number.isFinite(ts)) {
					enabled[id] = ts;
				}
			}
			cache = { version: 1, enabled };
			return cache;
		}
	} catch {
		// missing/corrupt — fall through to default
	}

	cache = { version: 1, enabled: {} };
	return cache;
}

function save(state: PersistedState): void {
	const ids = Object.keys(state.enabled);
	if (ids.length > MAX_ENTRIES) {
		const sorted = ids.sort((a, b) => state.enabled[a] - state.enabled[b]);
		const drop = sorted.slice(0, ids.length - PRUNE_TARGET);
		for (const id of drop) delete state.enabled[id];
	}

	try {
		mkdirSync(dirname(STATE_FILE), { recursive: true });
		writeFileSync(STATE_FILE, `${JSON.stringify(state, null, "\t")}\n`, "utf-8");
		cache = state;
	} catch {
		// disk write 실패는 조용히 무시 — 메모리 캐시만 유지
		cache = state;
	}
}

export function isNotifyEnabled(sessionId: string): boolean {
	if (!sessionId) return false;
	return Object.hasOwn(load().enabled, sessionId);
}

export function setNotifyEnabled(sessionId: string, enabled: boolean): void {
	if (!sessionId) return;
	const state = load();
	if (enabled) {
		state.enabled[sessionId] = Date.now();
	} else {
		delete state.enabled[sessionId];
	}
	save(state);
}
