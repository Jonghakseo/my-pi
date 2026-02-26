/**
 * Minimal Mode — Compact tool output rendering
 *
 * Overrides built-in tools to provide cleaner, less noisy output:
 *   - Collapsed (ctrl+o): Only the tool call summary, no output
 *   - Expanded  (ctrl+o): Full output like the default renderers
 *
 * Usage: auto-loaded from ~/.pi/agent/extensions/
 */

import { homedir } from "node:os";
import { isAbsolute, relative } from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import {
	createBashTool,
	createEditTool,
	createFindTool,
	createGrepTool,
	createLsTool,
	createReadTool,
	createWriteTool,
} from "@mariozechner/pi-coding-agent";
import { matchesKey, Text } from "@mariozechner/pi-tui";

// ── Helpers ────────────────────────────────────────────────────────────────

/** Current working directory — updated on session events. */
let currentCwd = process.cwd();

/**
 * Auto-collapse thinking blocks.
 *
 * The extension API exposes setToolsExpanded() but NOT setHideThinkingBlock().
 * Workaround: inject Ctrl+T (the toggleThinking keybinding) into process.stdin
 * so the InteractiveMode's own handler fires.
 *
 * State: settings.json has hideThinkingBlock: true (default collapsed).
 *   agent_start → inject Ctrl+T → show thinking while streaming
 *   agent_end   → inject Ctrl+T → collapse thinking when done
 */
const CTRL_T = "\x14";
let thinkingHidden = true; // mirrors settings.json hideThinkingBlock: true
let hasUI = false;

function injectToggleThinking() {
	if (!hasUI) return;
	process.stdin.emit("data", CTRL_T);
}

function showThinking() {
	if (thinkingHidden) {
		injectToggleThinking();
		thinkingHidden = false;
	}
}

function hideThinking() {
	if (!thinkingHidden) {
		injectToggleThinking();
		thinkingHidden = true;
	}
}

/**
 * Shorten a path for display:
 *   1. If under CWD → relative path  (e.g. "src/foo.ts")
 *   2. Else if under HOME → ~/...     (e.g. "~/other/bar.ts")
 *   3. Otherwise → as-is
 */
function shortenPath(path: string): string {
	if (!path) return path;

	// Try CWD-relative first
	if (isAbsolute(path)) {
		const rel = relative(currentCwd, path);
		// Only use if it doesn't escape upward too much (no leading ../..)
		if (!rel.startsWith("../..")) return rel.startsWith("../") ? rel : rel || ".";
	}

	// Fallback: home-relative
	const home = homedir();
	if (path.startsWith(home)) return `~${path.slice(home.length)}`;

	return path;
}

const toolCache = new Map<string, ReturnType<typeof createBuiltInTools>>();

function createBuiltInTools(cwd: string) {
	return {
		read: createReadTool(cwd),
		bash: createBashTool(cwd),
		edit: createEditTool(cwd),
		write: createWriteTool(cwd),
		find: createFindTool(cwd),
		grep: createGrepTool(cwd),
		ls: createLsTool(cwd),
	};
}

function getBuiltInTools(cwd: string) {
	let tools = toolCache.get(cwd);
	if (!tools) {
		tools = createBuiltInTools(cwd);
		toolCache.set(cwd, tools);
	}
	return tools;
}

function countLines(text: string): number {
	return text.trim().split("\n").filter(Boolean).length;
}

function renderFullOutput(text: string, theme: any): Text {
	const output = text
		.trim()
		.split("\n")
		.map((line) => theme.fg("toolOutput", line))
		.join("\n");
	return output ? new Text(`\n${output}`, 0, 0) : new Text("", 0, 0);
}

// ── Extension ──────────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
	// ─── Track CWD & UI state ──────────────────────────────────────────────
	let inputUnsub: (() => void) | undefined;

	pi.on("session_start", async (_e, ctx) => {
		currentCwd = ctx.sessionManager.getCwd();
		hasUI = ctx.hasUI;
		inputUnsub?.();
		if (ctx.hasUI) {
			inputUnsub = ctx.ui.onTerminalInput((data: string) => {
				if (matchesKey(data, "ctrl+t")) thinkingHidden = !thinkingHidden;
				return undefined;
			});
		}
	});
	pi.on("session_switch", async (_e, ctx) => {
		currentCwd = ctx.sessionManager.getCwd();
		hasUI = ctx.hasUI;
	});
	pi.on("session_fork", async (_e, ctx) => {
		currentCwd = ctx.sessionManager.getCwd();
		hasUI = ctx.hasUI;
	});
	pi.on("session_tree", async (_e, ctx) => {
		currentCwd = ctx.sessionManager.getCwd();
		hasUI = ctx.hasUI;
	});

	// ─── Auto show/hide thinking ───────────────────────────────────────────
	pi.on("agent_start", async () => {
		showThinking();
	});
	pi.on("agent_end", async () => {
		hideThinking();
	});

	// ─── Read ──────────────────────────────────────────────────────────────
	pi.registerTool({
		name: "read",
		label: "read",
		description:
			"Read the contents of a file. Supports text files and images (jpg, png, gif, webp). Images are sent as attachments. For text files, output is truncated to 2000 lines or 50KB (whichever is hit first). Use offset/limit for large files. When you need the full file, continue with offset until complete.",
		parameters: getBuiltInTools(process.cwd()).read.parameters,

		async execute(toolCallId, params, signal, onUpdate, ctx) {
			return getBuiltInTools(ctx.cwd).read.execute(toolCallId, params, signal, onUpdate);
		},

		renderCall(args, theme) {
			const path = shortenPath(args.path || "");
			let display = path ? theme.fg("accent", path) : theme.fg("toolOutput", "...");
			if (args.offset !== undefined || args.limit !== undefined) {
				const start = args.offset ?? 1;
				const end = args.limit !== undefined ? start + args.limit - 1 : "";
				display += theme.fg("warning", `:${start}${end ? `-${end}` : ""}`);
			}
			return new Text(`${theme.fg("toolTitle", theme.bold("read"))} ${display}`, 0, 0);
		},

		renderResult(result, { expanded }, theme) {
			if (!expanded) return new Text("", 0, 0);
			const tc = result.content.find((c) => c.type === "text");
			if (!tc || tc.type !== "text") return new Text("", 0, 0);
			return renderFullOutput(tc.text, theme);
		},
	});

	// ─── Bash ──────────────────────────────────────────────────────────────
	pi.registerTool({
		name: "bash",
		label: "bash",
		description:
			"Execute a bash command in the current working directory. Returns stdout and stderr. Output is truncated to last 2000 lines or 50KB (whichever is hit first). If truncated, full output is saved to a temp file. Optionally provide a timeout in seconds.",
		parameters: getBuiltInTools(process.cwd()).bash.parameters,

		async execute(toolCallId, params, signal, onUpdate, ctx) {
			return getBuiltInTools(ctx.cwd).bash.execute(toolCallId, params, signal, onUpdate);
		},

		renderCall(args, theme) {
			const cmd = args.command || "...";
			const timeout = args.timeout as number | undefined;
			const suffix = timeout ? theme.fg("muted", ` (${timeout}s)`) : "";
			return new Text(theme.fg("toolTitle", theme.bold(`$ ${cmd}`)) + suffix, 0, 0);
		},

		renderResult(result, { expanded }, theme) {
			if (!expanded) return new Text("", 0, 0);
			const tc = result.content.find((c) => c.type === "text");
			if (!tc || tc.type !== "text") return new Text("", 0, 0);
			return renderFullOutput(tc.text, theme);
		},
	});

	// ─── Write ─────────────────────────────────────────────────────────────
	pi.registerTool({
		name: "write",
		label: "write",
		description:
			"Write content to a file. Creates the file if it doesn't exist, overwrites if it does. Automatically creates parent directories.",
		parameters: getBuiltInTools(process.cwd()).write.parameters,

		async execute(toolCallId, params, signal, onUpdate, ctx) {
			return getBuiltInTools(ctx.cwd).write.execute(toolCallId, params, signal, onUpdate);
		},

		renderCall(args, theme) {
			const path = shortenPath(args.path || "");
			const display = path ? theme.fg("accent", path) : theme.fg("toolOutput", "...");
			const lines = args.content ? args.content.split("\n").length : 0;
			const info = lines > 0 ? theme.fg("muted", ` (${lines} lines)`) : "";
			return new Text(`${theme.fg("toolTitle", theme.bold("write"))} ${display}${info}`, 0, 0);
		},

		renderResult(result, { expanded }, theme) {
			if (!expanded) return new Text("", 0, 0);
			const tc = result.content.find((c) => c.type === "text");
			if (tc?.type === "text" && tc.text) {
				return new Text(`\n${theme.fg("error", tc.text)}`, 0, 0);
			}
			return new Text("", 0, 0);
		},
	});

	// ─── Edit ──────────────────────────────────────────────────────────────
	pi.registerTool({
		name: "edit",
		label: "edit",
		description:
			"Edit a file by replacing exact text. The oldText must match exactly (including whitespace). Use this for precise, surgical edits.",
		parameters: getBuiltInTools(process.cwd()).edit.parameters,

		async execute(toolCallId, params, signal, onUpdate, ctx) {
			return getBuiltInTools(ctx.cwd).edit.execute(toolCallId, params, signal, onUpdate);
		},

		renderCall(args, theme) {
			const path = shortenPath(args.path || "");
			const display = path ? theme.fg("accent", path) : theme.fg("toolOutput", "...");
			return new Text(`${theme.fg("toolTitle", theme.bold("edit"))} ${display}`, 0, 0);
		},

		renderResult(result, { expanded }, theme) {
			if (!expanded) return new Text("", 0, 0);
			const tc = result.content.find((c) => c.type === "text");
			if (!tc || tc.type !== "text") return new Text("", 0, 0);
			const text = tc.text;
			if (text.includes("Error") || text.includes("error")) {
				return new Text(`\n${theme.fg("error", text)}`, 0, 0);
			}
			return new Text(`\n${theme.fg("toolOutput", text)}`, 0, 0);
		},
	});

	// ─── Find ──────────────────────────────────────────────────────────────
	pi.registerTool({
		name: "find",
		label: "find",
		description:
			"Find files by name pattern (glob). Searches recursively from the specified path. Output limited to 200 results.",
		parameters: getBuiltInTools(process.cwd()).find.parameters,

		async execute(toolCallId, params, signal, onUpdate, ctx) {
			return getBuiltInTools(ctx.cwd).find.execute(toolCallId, params, signal, onUpdate);
		},

		renderCall(args, theme) {
			const pattern = args.pattern || "";
			const path = shortenPath(args.path || ".");
			let text = `${theme.fg("toolTitle", theme.bold("find"))} ${theme.fg("accent", pattern)}`;
			text += theme.fg("toolOutput", ` in ${path}`);
			if (args.limit !== undefined) text += theme.fg("toolOutput", ` (limit ${args.limit})`);
			return new Text(text, 0, 0);
		},

		renderResult(result, { expanded }, theme) {
			const tc = result.content.find((c) => c.type === "text");
			if (!expanded) {
				if (tc?.type === "text") {
					const count = countLines(tc.text);
					if (count > 0) return new Text(theme.fg("muted", ` → ${count} files`), 0, 0);
				}
				return new Text("", 0, 0);
			}
			if (!tc || tc.type !== "text") return new Text("", 0, 0);
			return renderFullOutput(tc.text, theme);
		},
	});

	// ─── Grep ──────────────────────────────────────────────────────────────
	pi.registerTool({
		name: "grep",
		label: "grep",
		description:
			"Search file contents by regex pattern. Uses ripgrep for fast searching. Output limited to 200 matches.",
		parameters: getBuiltInTools(process.cwd()).grep.parameters,

		async execute(toolCallId, params, signal, onUpdate, ctx) {
			return getBuiltInTools(ctx.cwd).grep.execute(toolCallId, params, signal, onUpdate);
		},

		renderCall(args, theme) {
			const pattern = args.pattern || "";
			const path = shortenPath(args.path || ".");
			let text = `${theme.fg("toolTitle", theme.bold("grep"))} ${theme.fg("accent", `/${pattern}/`)}`;
			text += theme.fg("toolOutput", ` in ${path}`);
			if (args.glob) text += theme.fg("toolOutput", ` (${args.glob})`);
			if (args.limit !== undefined) text += theme.fg("toolOutput", ` limit ${args.limit}`);
			return new Text(text, 0, 0);
		},

		renderResult(result, { expanded }, theme) {
			const tc = result.content.find((c) => c.type === "text");
			if (!expanded) {
				if (tc?.type === "text") {
					const count = countLines(tc.text);
					if (count > 0) return new Text(theme.fg("muted", ` → ${count} matches`), 0, 0);
				}
				return new Text("", 0, 0);
			}
			if (!tc || tc.type !== "text") return new Text("", 0, 0);
			return renderFullOutput(tc.text, theme);
		},
	});

	// ─── Ls ────────────────────────────────────────────────────────────────
	pi.registerTool({
		name: "ls",
		label: "ls",
		description:
			"List directory contents with file sizes. Shows files and directories with their sizes. Output limited to 500 entries.",
		parameters: getBuiltInTools(process.cwd()).ls.parameters,

		async execute(toolCallId, params, signal, onUpdate, ctx) {
			return getBuiltInTools(ctx.cwd).ls.execute(toolCallId, params, signal, onUpdate);
		},

		renderCall(args, theme) {
			const path = shortenPath(args.path || ".");
			let text = `${theme.fg("toolTitle", theme.bold("ls"))} ${theme.fg("accent", path)}`;
			if (args.limit !== undefined) text += theme.fg("toolOutput", ` (limit ${args.limit})`);
			return new Text(text, 0, 0);
		},

		renderResult(result, { expanded }, theme) {
			const tc = result.content.find((c) => c.type === "text");
			if (!expanded) {
				if (tc?.type === "text") {
					const count = countLines(tc.text);
					if (count > 0) return new Text(theme.fg("muted", ` → ${count} entries`), 0, 0);
				}
				return new Text("", 0, 0);
			}
			if (!tc || tc.type !== "text") return new Text("", 0, 0);
			return renderFullOutput(tc.text, theme);
		},
	});
}
