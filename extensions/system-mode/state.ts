/**
 * Shared agents-mode state.
 *
 * Each extension is loaded via a separate jiti instance (`moduleCache: false`),
 * so a plain module-level `let` variable creates isolated copies per extension.
 * `system-mode/index.ts` writes to one copy while `progress-widget-enforcer.ts`
 * reads from another — the badge never sees `true`.
 *
 * Fix: store the flag on `globalThis` behind a `Symbol.for()` key so every
 * module evaluation (regardless of jiti instance) shares the same object.
 */

const STATE_KEY = Symbol.for("pi-ext-agents-mode");

interface AgentsModeState {
	enabled: boolean;
}

function getSharedState(): AgentsModeState {
	let state = (globalThis as Record<symbol, AgentsModeState | undefined>)[STATE_KEY];
	if (!state) {
		state = { enabled: false };
		(globalThis as Record<symbol, AgentsModeState>)[STATE_KEY] = state;
	}
	return state;
}

export function setAgentsModeEnabled(enabled: boolean): void {
	getSharedState().enabled = enabled;
}

export function isAgentsModeEnabled(): boolean {
	return getSharedState().enabled;
}
