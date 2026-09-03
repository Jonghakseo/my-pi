import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

const STATE_FILE = join(getAgentDir(), "state", "anthropic-long-cache-sessions.json");
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
		const raw = JSON.parse(readFileSync(STATE_FILE, "utf8")) as unknown;
		if (isRecord(raw) && raw.version === 1 && isRecord(raw.enabled)) {
			const enabled: Record<string, number> = {};
			for (const [sessionId, timestamp] of Object.entries(raw.enabled)) {
				if (typeof timestamp === "number" && Number.isFinite(timestamp)) enabled[sessionId] = timestamp;
			}
			cache = { version: 1, enabled };
			return cache;
		}
	} catch {
		// Missing or malformed state falls back to disabled.
	}

	cache = { version: 1, enabled: {} };
	return cache;
}

function save(state: PersistedState): void {
	const sessionIds = Object.keys(state.enabled);
	if (sessionIds.length > MAX_ENTRIES) {
		const oldestFirst = sessionIds.sort((a, b) => state.enabled[a] - state.enabled[b]);
		for (const sessionId of oldestFirst.slice(0, sessionIds.length - PRUNE_TARGET)) delete state.enabled[sessionId];
	}

	try {
		mkdirSync(dirname(STATE_FILE), { recursive: true });
		writeFileSync(STATE_FILE, `${JSON.stringify(state, null, "\t")}\n`, "utf8");
	} catch {
		// Keep the in-memory setting when disk persistence is unavailable.
	}
	cache = state;
}

export function isAnthropicLongCacheEnabled(sessionId: string): boolean {
	return sessionId.length > 0 && Object.hasOwn(load().enabled, sessionId);
}

export function setAnthropicLongCacheEnabled(sessionId: string, enabled: boolean): void {
	if (!sessionId) return;
	const state = load();
	if (enabled) state.enabled[sessionId] = Date.now();
	else delete state.enabled[sessionId];
	save(state);
}
