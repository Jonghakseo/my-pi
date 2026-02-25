/**
 * Subagent Tool - Delegate tasks to specialized agents
 *
 * Spawns a separate `pi` process for each subagent invocation,
 * giving it an isolated context window.
 *
 * Supports three modes:
 *   - Single: { agent: "name", task: "..." }
 *   - Parallel: { tasks: [{ agent: "name", task: "..." }, ...] }
 *   - Chain: { chain: [{ agent: "name", task: "... {previous} ..." }, ...] }
 *
 * Uses JSON mode to capture structured output from subagents.
 *
 * Architecture:
 *   types.ts    — Type definitions, interfaces, Typebox schemas
 *   store.ts    — Shared state (SubagentStore) and state-mutation helpers
 *   format.ts   — Token/usage/tool-call formatting utilities
 *   session.ts  — Session file management and context helpers
 *   runner.ts   — Subagent process execution, agent matching, concurrency
 *   replay.ts   — Session replay viewer (TUI overlay)
 *   widget.ts   — Run status widget (below-editor display)
 *   commands.ts — Tool handler, slash-commands, event handlers
 *   index.ts    — Orchestrator (this file)
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { registerAll } from "./commands.js";
import { createStore } from "./store.js";

export default function (pi: ExtensionAPI) {
	const store = createStore();
	registerAll(pi, store);
}
