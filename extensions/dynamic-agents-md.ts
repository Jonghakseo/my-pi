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
 *   2. On tool_result(read/edit/write), discover missing scoped AGENTS/CLAUDE
 *      files. Append a preview (first 20 lines) to the result and mark as injected.
 *   3. On tool_result(grep/find/ls), same discovery and injection.
 *   4. Track injected paths to avoid duplicate injection.
 */

import type { ImageContent, TextContent } from "@mariozechner/pi-ai";
import type { ExtensionAPI, ToolResultEvent } from "@mariozechner/pi-coding-agent";

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
export const DYNAMIC_SCOPE_SENTINEL_START = "<!--PI_DYNAMIC_SCOPE_START-->";
export const DYNAMIC_SCOPE_SENTINEL_END = "<!--PI_DYNAMIC_SCOPE_END-->";

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

const PREVIEW_LINES = 20;

/** Format dynamic context blocks for LLM consumption. */
function formatInjection(files: ContextFile[]): string {
	const parts = files.map((f) => {
		const lines = f.content.split("\n");
		const preview = lines.slice(0, PREVIEW_LINES).join("\n");
		const truncated = lines.length > PREVIEW_LINES;
		const body = truncated
			? `${preview}\n\n⚠️ Showing first ${PREVIEW_LINES} of ${lines.length} lines. Read the full file before modifying code in this scope:\n  → read path: ${f.path}`
			: f.content;
		return `\n\n${DYNAMIC_SCOPE_SENTINEL_START}\n📋 [Dynamic scope context: ${f.path}]\n\n${body}\n${DYNAMIC_SCOPE_SENTINEL_END}`;
	});
	return parts.join("");
}

function collectNewContextFiles(
	rawPaths: string[],
	cwd: string,
	injectedPaths: Set<string>,
	staticDirs: Set<string>,
): { allNewFiles: ContextFile[]; readAbsPaths: Set<string> } {
	const allNewFiles: ContextFile[] = [];
	const readAbsPaths = new Set<string>();

	for (const rawPath of rawPaths) {
		const absPath = toAbsolute(rawPath, cwd);
		readAbsPaths.add(resolve(absPath));
		const newFiles = discoverNewAgentsMd(dirname(absPath), injectedPaths, staticDirs);
		for (const file of newFiles) {
			if (!injectedPaths.has(file.path)) {
				injectedPaths.add(file.path);
				allNewFiles.push(file);
			}
		}
	}

	return { allNewFiles, readAbsPaths };
}

function appendInjectedContext(event: ToolResultEvent, toInject: ContextFile[]): ToolResultEventResult | undefined {
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
}

// --- Extension ---
export default function (pi: ExtensionAPI) {
	/** Directories already covered by pi's static loading. */
	let staticDirs = new Set<string>();

	/** Absolute paths of AGENTS.md files already loaded/injected this session. */
	const injectedPaths = new Set<string>();

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

	// ── Inject scope context on exploratory tool results ──
	// When grep/find/ls access files in new directories, discover and
	// inject AGENTS.md content so the LLM sees the rules before any edit.
	pi.on("tool_result", async (event, ctx): Promise<ToolResultEventResult | undefined> => {
		const exploratoryTools = new Set(["grep", "find", "ls"]);
		if (!exploratoryTools.has(event.toolName)) return;
		if (event.isError) return;

		const input = event.input as Record<string, unknown> | undefined;
		const rawPath = typeof input?.path === "string" ? input.path : undefined;
		if (!rawPath) return;

		const absPath = toAbsolute(rawPath, ctx.cwd);
		const newFiles = discoverNewAgentsMd(absPath, injectedPaths, staticDirs);
		if (newFiles.length === 0) return;

		for (const file of newFiles) {
			injectedPaths.add(file.path);
		}
		return appendInjectedContext(event, newFiles);
	});

	// ── Inject scope context on file tool results (read/edit/write) ──
	pi.on("tool_result", async (event, ctx): Promise<ToolResultEventResult | undefined> => {
		const fileTools = new Set(["read", "edit", "write"]);
		if (!fileTools.has(event.toolName) || event.isError) return;

		const rawPaths = extractPaths(event);
		if (rawPaths.length === 0) return;

		const { allNewFiles, readAbsPaths } = collectNewContextFiles(rawPaths, ctx.cwd, injectedPaths, staticDirs);
		if (allNewFiles.length === 0) return;

		const toInject =
			event.toolName === "read" ? allNewFiles.filter((file) => !readAbsPaths.has(resolve(file.path))) : allNewFiles;
		return appendInjectedContext(event, toInject);
	});
}
