/**
 * Dynamic AGENTS.md Loader
 *
 * Pi core loads AGENTS.md files only from CWD→root at session start.
 * This extension adds runtime scope enforcement for edit/write operations
 * and dynamic context injection on read.
 *
 * How it works:
 *   1. On session_start, record static AGENTS coverage
 *      (CWD→root + global agent dir) and mark those as already injected.
 *   2. On message_update(toolcall streaming), detect edit/write targeting
 *      uncovered directories and abort early — before the LLM wastes tokens
 *      generating the full tool call content.
 *   3. On tool_call(edit/write), discover missing scoped AGENTS/CLAUDE files.
 *      If any are missing, block the tool call before modification.
 *      (Fallback for cases the streaming abort didn't catch.)
 *   4. On tool_result(read), discover missing scoped AGENTS/CLAUDE files,
 *      append their content to the read result, and mark them as injected.
 *   5. Track injected paths to avoid duplicate injection.
 */

import type { AssistantMessageEvent, ImageContent, TextContent, ToolCall } from "@mariozechner/pi-ai";
import {
	type ExtensionAPI,
	type ExtensionContext,
	isToolCallEventType,
	type ToolCallEventResult,
	type ToolResultEvent,
} from "@mariozechner/pi-coding-agent";

// MessageUpdateEvent is not re-exported from the top-level package.
interface MessageUpdateEvent {
	type: "message_update";
	message: unknown;
	assistantMessageEvent: AssistantMessageEvent;
}

/** Matches pi core's ToolResultEventResult shape (not exported from top-level package). */
interface ToolResultEventResult {
	content?: (TextContent | ImageContent)[];
	details?: unknown;
	isError?: boolean;
}

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { extractPathsFromInput } from "./utils/path-utils.js";

// --- Configuration ---
const CANDIDATES = ["AGENTS.md", "CLAUDE.md"] as const;

// --- Types ---
interface ContextFile {
	path: string;
	content: string;
}

// --- Helpers ---

/** Find the first AGENTS.md or CLAUDE.md in a directory. */
function findAgentsMdInDir(dir: string): ContextFile | null {
	for (const filename of CANDIDATES) {
		const filePath = join(dir, filename);
		if (existsSync(filePath)) {
			try {
				return { path: filePath, content: readFileSync(filePath, "utf-8") };
			} catch {
				// Unreadable — skip
			}
		}
	}
	return null;
}

/**
 * Compute the set of directories that are already covered by pi's
 * static AGENTS.md loading (CWD → root + global agent dir).
 */
function computeStaticCoveredDirs(cwd: string): Set<string> {
	const covered = new Set<string>();
	const root = resolve("/");
	let current = resolve(cwd);

	while (true) {
		covered.add(current);
		if (current === root) break;
		const parent = resolve(current, "..");
		if (parent === current) break;
		current = parent;
	}

	// Global agent dir (~/.pi/agent/)
	const globalAgentDir = join(homedir(), ".pi", "agent");
	covered.add(resolve(globalAgentDir));

	return covered;
}

/**
 * Walk up from `startDir`, collecting AGENTS.md files that haven't been
 * injected yet. Stop at the first directory already covered by static
 * loading or at filesystem root.
 */
function discoverNewAgentsMd(startDir: string, injectedPaths: Set<string>, staticDirs: Set<string>): ContextFile[] {
	const found: ContextFile[] = [];
	const root = resolve("/");
	let current = resolve(startDir);

	while (true) {
		if (staticDirs.has(current)) break;

		const ctx = findAgentsMdInDir(current);
		if (ctx && !injectedPaths.has(ctx.path)) {
			found.push(ctx);
		}

		if (current === root) break;
		const parent = resolve(current, "..");
		if (parent === current) break;
		current = parent;
	}

	// Ancestor-first order for deterministic prompt structure.
	return found.reverse();
}

/** Resolve a tool path parameter to an absolute path. */
function toAbsolute(filePath: string, cwd: string): string {
	if (isAbsolute(filePath)) return resolve(filePath);
	if (filePath === "~") return homedir();
	if (filePath.startsWith("~/")) return resolve(join(homedir(), filePath.slice(2)));
	return resolve(cwd, filePath);
}

/** Extract file path(s) from a tool_result event's input. Handles both single string and array paths (parallel read). */
function extractPaths(event: ToolResultEvent): string[] {
	const input = event.input as Record<string, unknown> | undefined;
	return extractPathsFromInput(input?.path);
}

/** Format dynamic context blocks for LLM consumption. */
function formatInjection(files: ContextFile[]): string {
	const parts = files.map((f) => `\n\n---\n📋 [Dynamic scope context: ${f.path}]\n\n${f.content}\n---`);
	return parts.join("");
}

/** Build tool_call block reason for edit/write gate. */
function formatBlockReason(targetPath: string, files: ContextFile[]): string {
	const list = files.map((f) => `- read path: ${f.path}`).join("\n");
	return [
		"Blocked: scoped AGENTS context must be loaded before edit/write.",
		`Target: ${targetPath}`,
		"",
		"Read these context files first:",
		list,
		"",
		"Then retry the same edit/write.",
	].join("\n");
}

// --- Streaming abort helpers ---
const GATED_TOOLS = new Set(["edit", "write"]);

/**
 * Per-tool-call streaming state for partial JSON argument accumulation.
 * We watch `toolcall_delta` events to extract the `path` field as early as
 * possible — typically within the first few hundred bytes, long before the
 * large `content` / `edits` payload is generated.
 */
interface StreamingToolCallState {
	/** Index into `partial.content[]` for this tool call. */
	contentIndex: number;
	/** Accumulated raw JSON argument string so far. */
	accumulatedArgs: string;
	/** Once we've resolved the `path` we stop checking deltas. */
	resolved: boolean;
}

/**
 * Try to extract the `"path"` value from a (possibly incomplete) JSON string.
 * Returns the path string if found, or null.
 *
 * We use a lightweight regex rather than JSON.parse() because the JSON is
 * incomplete during streaming. The `path` key appears early in tool calls
 * (edit and write both have it as the first parameter).
 */
function extractPathFromPartialJson(json: string): string | null {
	// Match "path":"<value>" or "path": "<value>" with possible escapes
	const match = json.match(/"path"\s*:\s*"((?:[^"\\]|\\.)*)"/);
	return match ? match[1].replace(/\\(.)/g, "$1") : null;
}

// --- Extension ---
export default function (pi: ExtensionAPI) {
	/** Directories already covered by pi's static loading. */
	let staticDirs = new Set<string>();

	/** Absolute paths of AGENTS.md files already loaded/injected this session. */
	const injectedPaths = new Set<string>();

	/** Active streaming tool call states, keyed by contentIndex. */
	let streamingStates = new Map<number, StreamingToolCallState>();

	/** Whether we've already aborted for the current assistant turn. */
	let abortedThisTurn = false;

	const resetState = (_event: unknown, ctx: { cwd: string }) => {
		staticDirs = computeStaticCoveredDirs(ctx.cwd);
		injectedPaths.clear();

		// Pre-populate with statically loaded context so we don't re-inject it.
		const root = resolve("/");
		let current = resolve(ctx.cwd);
		while (true) {
			const found = findAgentsMdInDir(current);
			if (found) injectedPaths.add(found.path);
			if (current === root) break;
			const parent = resolve(current, "..");
			if (parent === current) break;
			current = parent;
		}

		const globalDir = join(homedir(), ".pi", "agent");
		const globalFound = findAgentsMdInDir(globalDir);
		if (globalFound) injectedPaths.add(globalFound.path);
	};

	pi.on("session_start", async (_event, ctx) => {
		resetState(_event, ctx);
	});

	// Reset streaming state at each turn start.
	pi.on("turn_start", async () => {
		streamingStates = new Map();
		abortedThisTurn = false;
	});

	// ── Streaming early-abort: detect edit/write targeting uncovered dirs ──
	// This fires on every streaming token. We watch for toolcall_start/delta
	// to extract the `path` argument before the LLM generates the expensive
	// content/edits payload. If the target directory has an unloaded AGENTS.md,
	// we abort immediately — saving potentially thousands of tokens.
	pi.on("message_update", async (event: MessageUpdateEvent, ctx: ExtensionContext) => {
		if (abortedThisTurn) return;

		const streamEvent = event.assistantMessageEvent as AssistantMessageEvent;

		if (streamEvent.type === "toolcall_start") {
			// Check the partial message to get the tool name at this content index.
			const partial = streamEvent.partial;
			const contentItem = partial.content[streamEvent.contentIndex];
			if (!contentItem || contentItem.type !== "toolCall") return;

			const toolCall = contentItem as ToolCall;
			if (!GATED_TOOLS.has(toolCall.name)) return;

			// Start tracking this tool call's argument stream.
			streamingStates.set(streamEvent.contentIndex, {
				contentIndex: streamEvent.contentIndex,
				accumulatedArgs: "",
				resolved: false,
			});
			return;
		}

		if (streamEvent.type === "toolcall_delta") {
			const state = streamingStates.get(streamEvent.contentIndex);
			if (!state || state.resolved) return;

			state.accumulatedArgs += streamEvent.delta;

			// Try to extract `path` from accumulated JSON.
			const rawPath = extractPathFromPartialJson(state.accumulatedArgs);
			if (!rawPath) {
				// If we've accumulated a lot without finding path, stop trying.
				if (state.accumulatedArgs.length > 500) state.resolved = true;
				return;
			}

			// Found path — mark resolved so we don't re-check.
			state.resolved = true;

			const absPath = toAbsolute(rawPath, ctx.cwd);
			const missing = discoverNewAgentsMd(dirname(absPath), injectedPaths, staticDirs);
			if (missing.length === 0) return;

			// Missing AGENTS.md detected! Abort the stream immediately.
			abortedThisTurn = true;
			ctx.abort();

			// Inject a follow-up user message explaining what happened.
			// Use sendUserMessage to trigger a new turn after the abort.
			const list = missing.map((f) => `- ${f.path}`).join("\n");
			pi.sendUserMessage(
				[
					"[Auto-aborted] edit/write to an uncovered directory scope was detected during streaming.",
					`Target: ${absPath}`,
					"",
					"Unloaded AGENTS context files:",
					list,
					"",
					"Read the above file(s) first, then retry the original edit/write.",
				].join("\n"),
				{ deliverAs: "followUp" },
			);
			return;
		}
	});

	// ── Fallback gate: block edit/write if streaming abort didn't fire ──
	// This catches edge cases where the path wasn't detected during streaming
	// (e.g. path appeared late in JSON, or tool call was not streamed).
	pi.on("tool_call", async (event, ctx): Promise<ToolCallEventResult | undefined> => {
		if (!(isToolCallEventType("edit", event) || isToolCallEventType("write", event))) return;

		const rawPath = event.input.path;
		if (typeof rawPath !== "string" || rawPath.length === 0) return;

		const absPath = toAbsolute(rawPath, ctx.cwd);
		const missing = discoverNewAgentsMd(dirname(absPath), injectedPaths, staticDirs);
		if (missing.length === 0) return;

		return {
			block: true,
			reason: formatBlockReason(absPath, missing),
		};
	});

	// ── Pre-emptive injection on broader tool results ──
	// When grep/find/ls access files in new directories, eagerly load
	// AGENTS.md so that subsequent edit/write calls pass without blocking.
	pi.on("tool_result", async (event, ctx): Promise<ToolResultEventResult | undefined> => {
		// Only handle exploratory tools (not read — that's handled separately below).
		const exploratoryTools = new Set(["grep", "find", "ls"]);
		if (!exploratoryTools.has(event.toolName)) return;
		if (event.isError) return;

		const input = event.input as Record<string, unknown> | undefined;
		const rawPath = typeof input?.path === "string" ? input.path : undefined;
		if (!rawPath) return;

		const absPath = toAbsolute(rawPath, ctx.cwd);
		const newFiles = discoverNewAgentsMd(absPath, injectedPaths, staticDirs);
		for (const f of newFiles) {
			if (!injectedPaths.has(f.path)) {
				injectedPaths.add(f.path);
			}
		}

		// Don't modify the tool result — just mark paths as injected.
		// The content will be injected naturally when the LLM reads them,
		// or the edit/write will pass since we've registered the paths.
		return;
	});

	// Inject dynamic scope context when reading files in uncovered directories.
	pi.on("tool_result", async (event, ctx): Promise<ToolResultEventResult | undefined> => {
		if (event.toolName !== "read") return;
		if (event.isError) return;

		const rawPaths = extractPaths(event);
		if (rawPaths.length === 0) return;

		// Collect all new AGENTS.md files across all read paths (handles parallel reads).
		const allNewFiles: ContextFile[] = [];
		const readAbsPaths = new Set<string>();

		for (const rawPath of rawPaths) {
			const absPath = toAbsolute(rawPath, ctx.cwd);
			readAbsPaths.add(resolve(absPath));
			const newFiles = discoverNewAgentsMd(dirname(absPath), injectedPaths, staticDirs);
			for (const f of newFiles) {
				if (!injectedPaths.has(f.path)) {
					injectedPaths.add(f.path);
					allNewFiles.push(f);
				}
			}
		}

		if (allNewFiles.length === 0) return;

		// If user explicitly read AGENTS/CLAUDE itself, don't duplicate same content.
		const toInject = allNewFiles.filter((f) => !readAbsPaths.has(resolve(f.path)));
		if (toInject.length === 0) return;

		const suffix = formatInjection(toInject);
		const existingContent = [...event.content];

		let lastTextIdx = -1;
		for (let i = existingContent.length - 1; i >= 0; i--) {
			if (existingContent[i]?.type === "text") {
				lastTextIdx = i;
				break;
			}
		}

		if (lastTextIdx >= 0) {
			const last = existingContent[lastTextIdx] as TextContent;
			existingContent[lastTextIdx] = { type: "text" as const, text: last.text + suffix };
		} else {
			existingContent.push({ type: "text" as const, text: suffix });
		}

		return { content: existingContent };
	});
}
