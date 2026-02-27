/**
 * Shared agents-mode state.
 *
 * Each extension is loaded via a separate jiti instance (`moduleCache: false`),
 * so a plain module-level `let` variable creates isolated copies per extension.
 * One extension writes while another reads — the flag never propagates.
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
