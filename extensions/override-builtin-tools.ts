/**
 * Override Built-in Tools — Compact tool output rendering
 *
 * Overrides built-in tools to provide cleaner, less noisy output:
 *   - Collapsed (ctrl+o): Only the tool call summary, no output
 *   - Expanded  (ctrl+o): Full output like the default renderers
 *
 * Usage: auto-loaded from ~/.pi/agent/extensions/
 */

import { homedir } from "node:os";
import { extname, isAbsolute, relative } from "node:path";
import type { ExtensionAPI, ThemeColor } from "@mariozechner/pi-coding-agent";
import {
	createBashTool,
	createFindTool,
	createGrepTool,
	createLsTool,
	createReadTool,
	createWriteTool,
} from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";

// ── Helpers ────────────────────────────────────────────────────────────────

/** Current working directory — updated on session events. */
let currentCwd = process.cwd();

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

const ReadParams = Type.Object(
	{
		path: Type.Union([Type.String(), Type.Array(Type.String(), { minItems: 1 })], {
			description: "Path to read, or multiple non-image paths to read in parallel",
		}),
		offset: Type.Optional(Type.Integer({ description: "Line number to start reading from (1-indexed)" })),
		limit: Type.Optional(Type.Integer({ description: "Maximum number of lines to read" })),
	},
	{ additionalProperties: true },
);

const WriteParams = Type.Object(
	{
		path: Type.String({ description: "Path to the file to write" }),
		content: Type.String({ description: "Content to write" }),
	},
	{ additionalProperties: true },
);

// NOTE: Each schema MUST be a new Type.Object() — not a reference to the built-in's.
// pi's tool-execution.js uses `definition.parameters === builtInToolDefinition.parameters`
// (reference equality) to detect "is this the built-in?". If true, the custom renderers
// defined here are silently skipped and the built-in renderers are used instead.

const BashParams = Type.Object(
	{
		command: Type.String({ description: "Bash command to execute" }),
		timeout: Type.Optional(Type.Number({ description: "Timeout in seconds (optional, no default timeout)" })),
	},
	{ additionalProperties: true },
);

const FindParams = Type.Object(
	{
		pattern: Type.String({
			description: "Glob pattern to match files, e.g. '*.ts', '**/*.json', or 'src/**/*.spec.ts'",
		}),
		path: Type.Optional(Type.String({ description: "Directory to search in (default: current directory)" })),
		limit: Type.Optional(Type.Number({ description: "Maximum number of results (default: 1000)" })),
	},
	{ additionalProperties: true },
);

const GrepParams = Type.Object(
	{
		pattern: Type.String({ description: "Search pattern (regex or literal string)" }),
		path: Type.Optional(Type.String({ description: "Directory or file to search (default: current directory)" })),
		glob: Type.Optional(Type.String({ description: "Filter files by glob pattern, e.g. '*.ts' or '**/*.spec.ts'" })),
		ignoreCase: Type.Optional(Type.Boolean({ description: "Case-insensitive search (default: false)" })),
		literal: Type.Optional(
			Type.Boolean({ description: "Treat pattern as literal string instead of regex (default: false)" }),
		),
		context: Type.Optional(
			Type.Number({ description: "Number of lines to show before and after each match (default: 0)" }),
		),
		limit: Type.Optional(Type.Number({ description: "Maximum number of matches to return (default: 100)" })),
	},
	{ additionalProperties: true },
);

const LsParams = Type.Object(
	{
		path: Type.Optional(Type.String({ description: "Directory to list (default: current directory)" })),
		limit: Type.Optional(Type.Number({ description: "Maximum number of entries to return (default: 500)" })),
	},
	{ additionalProperties: true },
);

type ReadRenderDetails = {
	mode: "single-read" | "multi-read";
	paths: string[];
	count: number;
	offset?: number;
	limit?: number;
};

type WriteRenderDetails = {
	path: string;
	lineCount: number;
	byteCount: number;
	preview: string;
};

type RenderTheme = {
	fg: (color: ThemeColor, text: string) => string;
	bold: (text: string) => string;
};

function normalizeReadPaths(pathValue: unknown): string[] {
	if (typeof pathValue === "string") {
		const path = pathValue.trim();
		return path ? [path] : [];
	}

	if (!Array.isArray(pathValue)) return [];

	const paths: string[] = [];
	for (const value of pathValue) {
		if (typeof value !== "string") continue;
		const path = value.trim();
		if (path) paths.push(path);
	}
	return paths;
}

const READ_IMAGE_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".gif", ".webp"]);

function isImageReadPath(path: string): boolean {
	return READ_IMAGE_EXTENSIONS.has(extname(path).toLowerCase());
}

function formatReadRange(args: Record<string, unknown>, theme: RenderTheme): string {
	if (args.offset === undefined && args.limit === undefined) return "";
	const start = typeof args.offset === "number" ? args.offset : 1;
	const end = typeof args.limit === "number" ? start + args.limit - 1 : "";
	return theme.fg("warning", `:${start}${end ? `-${end}` : ""}`);
}

function formatReadRangePlain(args: Record<string, unknown>): string {
	if (args.offset === undefined && args.limit === undefined) return "";
	const start = typeof args.offset === "number" ? args.offset : 1;
	const end = typeof args.limit === "number" ? start + args.limit - 1 : undefined;
	return end ? `${start}~${end}` : `${start}~`;
}

const READ_SECTION_SEPARATOR = "=".repeat(72);

function formatMultiReadSection(path: string, index: number, total: number, body: string): string {
	const header = [READ_SECTION_SEPARATOR, `[${index}/${total}] ${path}`, READ_SECTION_SEPARATOR].join("\n");
	return `${header}\n${body}`;
}

function countLines(text: string): number {
	return text.trim().split("\n").filter(Boolean).length;
}

function truncateLines(text: string, maxLines: number): string {
	const lines = text.split("\n");
	if (lines.length <= maxLines) return text;
	const visible = lines.slice(0, maxLines).join("\n");
	return `${visible}\n… (+${lines.length - maxLines} lines)`;
}

function renderFullOutput(text: string, theme: RenderTheme): Text {
	const output = text
		.trim()
		.split("\n")
		.map((line) => theme.fg("toolOutput", line))
		.join("\n");
	return new Text(output ? `\n${output}` : "", 0, 0);
}

/** Render first N lines as a dim preview with a "more" hint. */
function renderPreviewLines(text: string, maxLines: number, theme: RenderTheme): Text {
	const lines = text.trim().split("\n");
	const preview = lines.slice(0, maxLines);
	const remaining = lines.length - maxLines;
	let output = preview.map((l) => theme.fg("dim", l)).join("\n");
	if (remaining > 0) {
		output += `\n${theme.fg("muted", `… +${remaining} lines`)}`;
	}
	return new Text(output, 0, 0);
}

function getObjectDetails(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) return {};
	return value as Record<string, unknown>;
}

function renderTailPreview(text: string, maxLines: number, theme: RenderTheme): string {
	const lines = text.split("\n");
	const displayLines = lines.slice(-maxLines);
	const hidden = lines.length - displayLines.length;

	let output = displayLines.map((line) => theme.fg("dim", line.replace(/\t/g, "    "))).join("\n");
	if (hidden > 0) {
		output = `${theme.fg("muted", `… (${hidden} earlier lines)`)}\n${output}`;
	}
	return output;
}

function getResultText(result: unknown): string {
	if (!result || typeof result !== "object") return "";
	const content = (result as { content?: unknown }).content;
	if (!Array.isArray(content)) return "";
	for (const part of content) {
		if (part && typeof part === "object" && (part as { type?: unknown }).type === "text") {
			const text = (part as { text?: unknown }).text;
			if (typeof text === "string") return text;
		}
	}
	return "";
}

// ── Extension ──────────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
	// ─── Track CWD ─────────────────────────────────────────────────────────
	pi.on("session_start", async (_e, ctx) => {
		currentCwd = ctx.sessionManager.getCwd();
	});
	pi.on("session_switch", async (_e, ctx) => {
		currentCwd = ctx.sessionManager.getCwd();
	});
	pi.on("session_fork", async (_e, ctx) => {
		currentCwd = ctx.sessionManager.getCwd();
	});
	pi.on("session_tree", async (_e, ctx) => {
		currentCwd = ctx.sessionManager.getCwd();
	});

	// ─── Read ──────────────────────────────────────────────────────────────
	pi.registerTool({
		name: "read",
		label: "read",
		description:
			"Read the contents of one or more files. Supports text files and images (jpg, png, gif, webp). For text files, output is truncated to 2000 lines or 50KB (whichever is hit first). Use offset/limit for large files. When path is an array, non-image files are read in parallel and returned with per-file separators.",
		parameters: ReadParams,

		async execute(toolCallId, params, signal, onUpdate, ctx) {
			const builtInRead = getBuiltInTools(ctx.cwd).read;
			const readParams = params as Record<string, unknown>;
			const paths = normalizeReadPaths(readParams.path);
			const offset = typeof readParams.offset === "number" ? readParams.offset : undefined;
			const limit = typeof readParams.limit === "number" ? readParams.limit : undefined;

			if (paths.length === 0) {
				return {
					isError: true,
					content: [{ type: "text" as const, text: "read requires a non-empty path (string or string[])." }],
					details: { mode: "multi-read", paths: [] as string[], count: 0, offset, limit } satisfies ReadRenderDetails,
				};
			}

			if (paths.length === 1) {
				const single = await builtInRead.execute(toolCallId, { ...readParams, path: paths[0] }, signal, onUpdate);
				const originalDetails = getObjectDetails(single.details as unknown);
				return {
					...single,
					details: {
						...originalDetails,
						mode: "single-read",
						paths,
						count: 1,
						offset,
						limit,
					} satisfies ReadRenderDetails & Record<string, unknown>,
				};
			}

			if (paths.some(isImageReadPath)) {
				return {
					isError: true,
					content: [
						{
							type: "text" as const,
							text: "Image files must be read one at a time to be understood.",
						},
					],
					details: { mode: "multi-read", paths, count: paths.length, offset, limit } satisfies ReadRenderDetails,
				};
			}

			const sharedParams = { ...readParams };
			delete sharedParams.path;

			const results = await Promise.all(
				paths.map((path) => builtInRead.execute(toolCallId, { ...sharedParams, path }, signal, onUpdate)),
			);

			const hasError = results.some((result) => Boolean((result as { isError?: boolean }).isError));
			const text = results
				.map((result, index) => {
					const body = getResultText(result) || "[No text output]";
					return formatMultiReadSection(paths[index], index + 1, paths.length, body);
				})
				.join("\n\n");

			return {
				isError: hasError,
				content: [{ type: "text" as const, text }],
				details: { mode: "multi-read", paths, count: paths.length, offset, limit } satisfies ReadRenderDetails,
			};
		},

		renderCall(args, theme) {
			const argObj = args as Record<string, unknown>;
			const paths = normalizeReadPaths(argObj.path);
			const rangePlain = formatReadRangePlain(argObj);
			const rangeStyled = formatReadRange(argObj, theme);

			if (paths.length > 1) {
				const lines = [theme.fg("toolTitle", theme.bold("Read"))];
				for (const [index, path] of paths.entries()) {
					const suffix = rangePlain ? `:${rangePlain}` : "";
					lines.push(
						`└ ${theme.fg("muted", `파일 ${index + 1}: `)}${theme.fg("accent", shortenPath(path))}${theme.fg("warning", suffix)}`,
					);
				}
				return new Text(lines.join("\n"), 0, 0);
			}

			let display = theme.fg("toolOutput", "...");
			if (paths.length === 1) {
				display = theme.fg("accent", shortenPath(paths[0]));
			}

			display += rangeStyled;
			return new Text(`${theme.fg("toolTitle", theme.bold("Read"))} ${display}`, 0, 0);
		},

		renderResult(result, { expanded }, theme) {
			const tc = result.content.find((c) => c.type === "text");
			if (!tc || tc.type !== "text") return new Text("", 0, 0);

			if (!expanded) {
				return renderPreviewLines(tc.text, 5, theme);
			}

			return renderFullOutput(tc.text, theme);
		},
	});

	// ─── Bash ──────────────────────────────────────────────────────────────
	pi.registerTool({
		name: "bash",
		label: "bash",
		description:
			"Execute a bash command in the current working directory. Returns stdout and stderr. Output is truncated to last 2000 lines or 50KB (whichever is hit first). If truncated, full output is saved to a temp file. Optionally provide a timeout in seconds.",
		parameters: BashParams,

		async execute(toolCallId, params, signal, onUpdate, ctx) {
			return getBuiltInTools(ctx.cwd).bash.execute(toolCallId, params, signal, onUpdate);
		},

		renderCall(args, theme) {
			const cmd = truncateLines(String(args.command ?? "..."), 2);
			const timeout = args.timeout as number | undefined;
			const suffix = timeout ? theme.fg("muted", ` (${timeout}s)`) : "";
			return new Text(theme.fg("toolTitle", theme.bold(`$ ${cmd}`)) + suffix, 0, 0);
		},

		renderResult(result, { expanded }, theme) {
			const tc = result.content.find((c) => c.type === "text");
			if (!tc || tc.type !== "text") return new Text("", 0, 0);

			if (!expanded) {
				return renderPreviewLines(tc.text, 5, theme);
			}

			return renderFullOutput(tc.text, theme);
		},
	});

	// ─── Write ─────────────────────────────────────────────────────────────
	pi.registerTool({
		name: "write",
		label: "write",
		description:
			"Write content to a file. Creates the file if it doesn't exist, overwrites if it does. Automatically creates parent directories.",
		parameters: WriteParams,

		async execute(toolCallId, params, signal, onUpdate, ctx) {
			const writeParams = params as Record<string, unknown>;
			const path = typeof writeParams.path === "string" ? writeParams.path.trim() : "";
			if (!path) {
				return {
					isError: true,
					content: [{ type: "text" as const, text: "write requires a non-empty path." }],
					details: undefined,
				};
			}
			if (typeof writeParams.content !== "string") {
				return {
					isError: true,
					content: [{ type: "text" as const, text: "write requires string content." }],
					details: undefined,
				};
			}

			const builtInResult = await getBuiltInTools(ctx.cwd).write.execute(
				toolCallId,
				{ path, content: writeParams.content },
				signal,
				onUpdate,
			);
			const originalDetails = getObjectDetails(builtInResult.details as unknown);
			return {
				...builtInResult,
				details: {
					...originalDetails,
					path,
					lineCount: countLines(writeParams.content),
					byteCount: Buffer.byteLength(writeParams.content, "utf8"),
					preview: writeParams.content,
				} satisfies WriteRenderDetails & Record<string, unknown>,
			};
		},

		renderCall(args, theme) {
			const path = shortenPath(args.path || "");
			const display = path ? theme.fg("accent", path) : theme.fg("toolOutput", "...");
			const content = typeof args.content === "string" ? args.content : "";
			const lines = content ? countLines(content) : 0;
			const bytes = content ? Buffer.byteLength(content, "utf8") : 0;
			let text = `${theme.fg("toolTitle", theme.bold("Write"))} ${display}`;
			if (content) text += theme.fg("muted", ` (${lines} lines • ${bytes} bytes)`);
			if (content) text += `\n${renderTailPreview(content, 6, theme)}`;
			return new Text(text, 0, 0);
		},

		renderResult(result, { expanded }, theme) {
			const details = getObjectDetails(result.details) as WriteRenderDetails & Record<string, unknown>;
			const preview = typeof details.preview === "string" ? details.preview : "";
			const tc = result.content.find((c) => c.type === "text");
			const summary = tc?.type === "text" && tc.text ? theme.fg("toolOutput", tc.text) : "";

			if (!expanded) {
				return new Text(summary, 0, 0);
			}

			const previewText = preview
				? preview
						.trim()
						.split("\n")
						.map((l) => theme.fg("toolOutput", l))
						.join("\n")
				: "";
			const combined = [previewText ? `\n${previewText}` : "", summary].filter(Boolean).join("\n");
			return new Text(combined, 0, 0);
		},
	});

	// ─── Find ──────────────────────────────────────────────────────────────
	pi.registerTool({
		name: "find",
		label: "find",
		description:
			"Find files by name pattern (glob). Searches recursively from the specified path. Output limited to 200 results.",
		parameters: FindParams,

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
		parameters: GrepParams,

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
		parameters: LsParams,

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
