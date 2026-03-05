/**
 * Override Built-in Tools — Compact tool output rendering
 *
 * Overrides built-in tools to provide cleaner, less noisy output:
 *   - Collapsed (ctrl+o): Only the tool call summary, no output
 *   - Expanded  (ctrl+o): Full output like the default renderers
 *
 * Usage: auto-loaded from ~/.pi/agent/extensions/
 */

import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, relative, resolve } from "node:path";
import type { EditToolDetails, ExtensionAPI } from "@mariozechner/pi-coding-agent";
import {
	createBashTool,
	createEditTool,
	createFindTool,
	createGrepTool,
	createLsTool,
	createReadTool,
	createWriteTool,
} from "@mariozechner/pi-coding-agent";
import { Text, truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";
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

const ReadParams = Type.Object(
	{
		path: Type.Union([Type.String(), Type.Array(Type.String(), { minItems: 1 })], {
			description: "Path to read, or multiple paths to read in parallel",
		}),
		offset: Type.Optional(Type.Integer({ description: "Line number to start reading from (1-indexed)" })),
		limit: Type.Optional(Type.Integer({ description: "Maximum number of lines to read" })),
	},
	{ additionalProperties: true },
);

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

function formatReadRange(args: Record<string, unknown>, theme: any): string {
	if (args.offset === undefined && args.limit === undefined) return "";
	const start = typeof args.offset === "number" ? args.offset : 1;
	const end = typeof args.limit === "number" ? start + args.limit - 1 : "";
	return theme.fg("warning", `:${start}${end ? `-${end}` : ""}`);
}

const READ_SECTION_SEPARATOR = "=".repeat(72);

function stripReadLinePrefix(line: string): string {
	const match = line.match(/^\d+#[A-Z0-9]+:(.*)$/);
	return match ? match[1] : line;
}

function numberReadLines(text: string, startLine: number): string {
	const lines = text.split("\n");
	const width = String(startLine + Math.max(0, lines.length - 1)).length;
	return lines
		.map((line, index) => `${String(startLine + index).padStart(width, " ")} | ${stripReadLinePrefix(line)}`)
		.join("\n");
}

function formatMultiReadSection(path: string, index: number, total: number, body: string, startLine: number): string {
	const header = [READ_SECTION_SEPARATOR, `[${index}/${total}] ${path}`, READ_SECTION_SEPARATOR].join("\n");
	return `${header}\n${numberReadLines(body, startLine)}`;
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

function renderFullOutput(text: string, theme: any): Text {
	const output = text
		.trim()
		.split("\n")
		.map((line) => theme.fg("toolOutput", line))
		.join("\n");
	return output ? new Text(`\n${output}`, 0, 0) : new Text("", 0, 0);
}

/** Render first N lines as a dim preview with a "more" hint. */
function renderPreviewLines(text: string, maxLines: number, theme: any): string {
	const lines = text.trim().split("\n");
	const preview = lines.slice(0, maxLines);
	const remaining = lines.length - maxLines;
	let output = preview.map((l) => theme.fg("dim", l)).join("\n");
	if (remaining > 0) {
		output += "\n" + theme.fg("muted", `… +${remaining} lines`);
	}
	return output;
}

// ── Edit Fuzzy Fallback (Levenshtein=1, unique candidate) ─────────────────

const FUZZY_EDIT_MIN_OLDTEXT_LEN = 5;
const FUZZY_EDIT_MAX_FILE_CHARS = 400_000;

interface EditLikeParams {
	path?: unknown;
	oldText?: unknown;
	newText?: unknown;
	[key: string]: unknown;
}

interface FuzzyCandidate {
	text: string;
	index: number;
	distance: 1;
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

function distanceAtMostOne(a: string, b: string): 0 | 1 | 2 {
	const la = a.length;
	const lb = b.length;
	if (Math.abs(la - lb) > 1) return 2;

	let i = 0;
	let j = 0;
	let edits = 0;

	while (i < la && j < lb) {
		if (a[i] === b[j]) {
			i++;
			j++;
			continue;
		}

		edits++;
		if (edits > 1) return 2;

		if (la > lb) i++;
		else if (lb > la) j++;
		else {
			i++;
			j++;
		}
	}

	if (i < la || j < lb) edits++;
	if (edits > 1) return 2;
	return edits === 0 ? 0 : 1;
}

function findUniqueFuzzyCandidate(fileText: string, oldText: string): FuzzyCandidate | undefined {
	const targetLen = oldText.length;
	const lengths = [targetLen - 1, targetLen, targetLen + 1].filter((len) => len > 0);
	let found: FuzzyCandidate | undefined;

	for (const windowLen of lengths) {
		if (windowLen > fileText.length) continue;
		for (let i = 0; i <= fileText.length - windowLen; i++) {
			const candidate = fileText.slice(i, i + windowLen);
			const distance = distanceAtMostOne(oldText, candidate);
			if (distance !== 1) continue;

			if (found) {
				return undefined;
			}
			found = { text: candidate, index: i, distance };
		}
	}

	return found;
}

async function resolveFuzzyCandidate(cwd: string, params: EditLikeParams): Promise<FuzzyCandidate | undefined> {
	const path = typeof params.path === "string" ? params.path : "";
	const oldText = typeof params.oldText === "string" ? params.oldText : "";
	if (!path || !oldText) return undefined;
	if (oldText.length < FUZZY_EDIT_MIN_OLDTEXT_LEN) return undefined;

	const absolutePath = isAbsolute(path) ? path : resolve(cwd, path);
	const fileText = await readFile(absolutePath, "utf8");
	if (fileText.length > FUZZY_EDIT_MAX_FILE_CHARS) return undefined;

	return findUniqueFuzzyCandidate(fileText, oldText);
}

function shouldTryFuzzyEdit(params: EditLikeParams, result: unknown): boolean {
	if (typeof params.oldText !== "string" || params.oldText.length < FUZZY_EDIT_MIN_OLDTEXT_LEN) return false;
	const text = getResultText(result);
	return text.includes("Could not find the exact text") && text.includes("The old text must match exactly");
}

function withFuzzyNote<T>(result: T, note: string): T {
	if (!result || typeof result !== "object") return result;
	const out = { ...(result as Record<string, unknown>) };
	const content = out.content;
	if (!Array.isArray(content)) return result;

	let replaced = false;
	out.content = content.map((part) => {
		if (replaced) return part;
		if (part && typeof part === "object" && (part as { type?: unknown }).type === "text") {
			const text = (part as { text?: unknown }).text;
			if (typeof text === "string") {
				replaced = true;
				return { ...(part as Record<string, unknown>), text: `${note}\n${text}` };
			}
		}
		return part;
	});

	return out as T;
}

// ── Side-by-Side Diff ──────────────────────────────────────────────────────

interface DiffLine {
	type: "added" | "removed" | "context" | "ellipsis";
	lineNum: string;
	content: string;
}

interface RowSide {
	type: "added" | "removed" | "context" | "ellipsis" | "empty";
	lineNum: string;
	content: string;
}

interface DiffRow {
	left: RowSide;
	right: RowSide;
}

const REMOVED_STYLE = "\x1b[48;2;55;15;15m\x1b[38;2;235;120;120m";
const ADDED_STYLE = "\x1b[48;2;15;42;15m\x1b[38;2;120;235;120m";
const ANSI_RESET = "\x1b[0m";

function parseDiffLines(diffText: string): DiffLine[] {
	const lines = diffText.split("\n");
	const result: DiffLine[] = [];
	for (const line of lines) {
		const match = line.match(/^([+-\s])(\s*\d*)\s(.*)$/);
		if (!match) {
			if (line.includes("...")) {
				result.push({ type: "ellipsis", lineNum: "", content: "···" });
			}
			continue;
		}
		const [, prefix, lineNum, content] = match;
		if (prefix === "+") result.push({ type: "added", lineNum: lineNum.trim(), content });
		else if (prefix === "-") result.push({ type: "removed", lineNum: lineNum.trim(), content });
		else result.push({ type: "context", lineNum: lineNum.trim(), content });
	}
	return result;
}

function buildDiffRows(parsed: DiffLine[]): DiffRow[] {
	const rows: DiffRow[] = [];
	let i = 0;
	let offset = 0;

	while (i < parsed.length) {
		const line = parsed[i];
		if (line.type === "context") {
			const oldNum = line.lineNum;
			const newNum = oldNum ? String(parseInt(oldNum, 10) + offset) : "";
			rows.push({
				left: { type: "context", lineNum: oldNum, content: line.content },
				right: { type: "context", lineNum: newNum, content: line.content },
			});
			i++;
		} else if (line.type === "ellipsis") {
			rows.push({
				left: { type: "ellipsis", lineNum: "", content: line.content },
				right: { type: "ellipsis", lineNum: "", content: line.content },
			});
			i++;
		} else if (line.type === "removed") {
			const removed: DiffLine[] = [];
			while (i < parsed.length && parsed[i].type === "removed") {
				removed.push(parsed[i]);
				i++;
			}
			const added: DiffLine[] = [];
			while (i < parsed.length && parsed[i].type === "added") {
				added.push(parsed[i]);
				i++;
			}
			offset += added.length - removed.length;
			const maxLen = Math.max(removed.length, added.length);
			for (let j = 0; j < maxLen; j++) {
				const r = removed[j];
				const a = added[j];
				rows.push({
					left: r
						? { type: "removed", lineNum: r.lineNum, content: r.content }
						: { type: "empty", lineNum: "", content: "" },
					right: a
						? { type: "added", lineNum: a.lineNum, content: a.content }
						: { type: "empty", lineNum: "", content: "" },
				});
			}
		} else if (line.type === "added") {
			offset += 1;
			rows.push({
				left: { type: "empty", lineNum: "", content: "" },
				right: { type: "added", lineNum: line.lineNum, content: line.content },
			});
			i++;
		}
	}
	return rows;
}

class SideBySideDiffView {
	private rows: DiffRow[];
	private maxRows?: number;
	private lineNumWidth: number;
	private theme: any;
	private summaryFn: (t: any) => string;
	private cachedWidth?: number;
	private cachedLines?: string[];

	constructor(diffText: string, theme: any, summaryFn: (t: any) => string, maxRows?: number) {
		const parsed = parseDiffLines(diffText);
		this.rows = buildDiffRows(parsed);
		this.maxRows = maxRows;
		this.theme = theme;
		this.summaryFn = summaryFn;
		let maxNum = 0;
		for (const row of this.rows) {
			if (row.left.lineNum) maxNum = Math.max(maxNum, parseInt(row.left.lineNum, 10));
			if (row.right.lineNum) maxNum = Math.max(maxNum, parseInt(row.right.lineNum, 10));
		}
		this.lineNumWidth = Math.max(String(maxNum).length, 3);
	}

	render(width: number): string[] {
		if (this.cachedLines && this.cachedWidth === width) return this.cachedLines;
		const t = this.theme;
		const lines: string[] = [this.summaryFn(t)];
		const halfWidth = Math.floor((width - 1) / 2);
		const rightWidth = width - halfWidth - 1;

		let rowsToShow: DiffRow[];
		let hasMore = false;

		if (this.maxRows != null) {
			// Skip leading context — start from first actual change
			const firstChangeIdx = this.rows.findIndex((r) => r.left.type === "removed" || r.right.type === "added");
			const startIdx = firstChangeIdx >= 1 ? firstChangeIdx - 1 : 0;
			rowsToShow = this.rows.slice(startIdx, startIdx + this.maxRows);
			hasMore = startIdx + this.maxRows < this.rows.length;
		} else {
			rowsToShow = this.rows;
		}

		if (halfWidth < 20) {
			for (const row of rowsToShow) {
				if (row.left.type === "removed")
					lines.push(truncateToWidth(t.fg("toolDiffRemoved", `- ${row.left.content}`), width));
				if (row.right.type === "added")
					lines.push(truncateToWidth(t.fg("toolDiffAdded", `+ ${row.right.content}`), width));
				if (row.left.type === "context")
					lines.push(truncateToWidth(t.fg("toolDiffContext", `  ${row.left.content}`), width));
				if (row.left.type === "ellipsis")
					lines.push(truncateToWidth(t.fg("toolDiffContext", `  ${row.left.content}`), width));
			}
		} else {
			for (const row of rowsToShow) {
				lines.push(this.formatSide(row.left, halfWidth) + t.fg("dim", "│") + this.formatSide(row.right, rightWidth));
			}
		}

		if (hasMore && this.maxRows != null) {
			const remaining = this.rows.length - this.maxRows;
			lines.push(t.fg("muted", `… +${remaining} rows`));
		}

		this.cachedWidth = width;
		this.cachedLines = lines;
		return lines;
	}

	private formatSide(side: RowSide, width: number): string {
		if (side.type === "empty") return " ".repeat(width);
		const lnw = this.lineNumWidth;
		const num = side.lineNum ? side.lineNum.padStart(lnw) : " ".repeat(lnw);
		const content = side.content.replace(/\t/g, "   ");
		const rawLine = `${num}  ${content}`;
		const truncated = truncateToWidth(rawLine, width, "");
		const vw = visibleWidth(truncated);
		const padded = truncated + " ".repeat(Math.max(0, width - vw));

		switch (side.type) {
			case "removed":
				return REMOVED_STYLE + padded + ANSI_RESET;
			case "added":
				return ADDED_STYLE + padded + ANSI_RESET;
			default:
				return this.theme.fg("toolDiffContext", padded);
		}
	}

	invalidate(): void {
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
	}
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
			"Read the contents of one or more files. Supports text files and images (jpg, png, gif, webp). For text files, output is truncated to 2000 lines or 50KB (whichever is hit first). Use offset/limit for large files. When path is an array, files are read in parallel and returned with per-file separators and line numbers.",
		parameters: ReadParams,

		async execute(toolCallId, params, signal, onUpdate, ctx) {
			const builtInRead = getBuiltInTools(ctx.cwd).read;
			const readParams = params as Record<string, unknown>;
			const paths = normalizeReadPaths(readParams.path);

			if (paths.length === 0) {
				return {
					isError: true,
					content: [{ type: "text" as const, text: "read requires a non-empty path (string or string[])." }],
					details: { mode: "multi-read", paths: [] as string[] },
				};
			}

			if (paths.length === 1) {
				return builtInRead.execute(toolCallId, { ...readParams, path: paths[0] }, signal, onUpdate);
			}

			const sharedParams = { ...readParams };
			delete sharedParams.path;

			const results = await Promise.all(
				paths.map((path) => builtInRead.execute(toolCallId, { ...sharedParams, path }, signal, onUpdate)),
			);

			const hasError = results.some((result) => Boolean((result as { isError?: boolean }).isError));
			const startLine = typeof readParams.offset === "number" ? readParams.offset : 1;
			const text = results
				.map((result, index) => {
					const body = getResultText(result) || "[No text output]";
					return formatMultiReadSection(paths[index], index + 1, paths.length, body, startLine);
				})
				.join("\n\n");

			return {
				isError: hasError,
				content: [{ type: "text" as const, text }],
				details: { mode: "multi-read", paths, count: paths.length },
			};
		},

		renderCall(args, theme) {
			const argObj = args as Record<string, unknown>;
			const paths = normalizeReadPaths(argObj.path);
			let display = theme.fg("toolOutput", "...");

			if (paths.length === 1) {
				display = theme.fg("accent", shortenPath(paths[0]));
			} else if (paths.length > 1) {
				const first = shortenPath(paths[0]);
				display = theme.fg("accent", `${first} +${paths.length - 1} files`);
			}

			display += formatReadRange(argObj, theme);
			return new Text(`${theme.fg("toolTitle", theme.bold("read"))} ${display}`, 0, 0);
		},

		renderResult(result, { expanded }, theme) {
			const tc = result.content.find((c) => c.type === "text");
			if (!tc || tc.type !== "text") return new Text("", 0, 0);
			if (!expanded) return new Text(renderPreviewLines(tc.text, 5, theme), 0, 0);
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
			const cmd = truncateLines(String(args.command ?? "..."), 2);
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
			const tc = result.content.find((c) => c.type === "text");
			if (!tc || tc.type !== "text" || !tc.text) return new Text("", 0, 0);
			if (!expanded) return new Text(renderPreviewLines(tc.text, 5, theme), 0, 0);
			return renderFullOutput(tc.text, theme);
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
			const builtInEdit = getBuiltInTools(ctx.cwd).edit;
			const first = await builtInEdit.execute(toolCallId, params, signal, onUpdate);
			if (!shouldTryFuzzyEdit(params as EditLikeParams, first)) return first;

			try {
				const candidate = await resolveFuzzyCandidate(ctx.cwd, params as EditLikeParams);
				if (!candidate) return first;

				const retryParams = { ...(params as Record<string, unknown>), oldText: candidate.text };
				const retried = await builtInEdit.execute(toolCallId, retryParams as any, signal, onUpdate);
				if ((retried as { isError?: boolean }).isError) return first;

				const fuzzyNote = `[fuzzy-edit] exact-match failed; applied unique candidate (levenshtein=${candidate.distance}, index=${candidate.index}).`;
				return withFuzzyNote(retried, fuzzyNote);
			} catch {
				return first;
			}
		},

		renderCall(args, theme) {
			const path = shortenPath(args.path || "");
			const display = path ? theme.fg("accent", path) : theme.fg("toolOutput", "...");
			return new Text(`${theme.fg("toolTitle", theme.bold("edit"))} ${display}`, 0, 0);
		},

		renderResult(result, { expanded, isPartial }, theme) {
			const details = result.details as EditToolDetails | undefined;
			const tc = result.content.find((c) => c.type === "text");

			// Error
			if (!isPartial && tc?.type === "text" && (tc.text.includes("Error") || tc.text.includes("error"))) {
				return new Text(theme.fg("error", tc.text.split("\n")[0]), 0, 0);
			}

			// No diff available yet
			if (!details?.diff) {
				return new Text(isPartial ? theme.fg("warning", "Editing...") : theme.fg("success", "Applied"), 0, 0);
			}

			// Stats
			const diffLines = details.diff.split("\n");
			let additions = 0;
			let removals = 0;
			for (const line of diffLines) {
				if (line.startsWith("+")) additions++;
				if (line.startsWith("-")) removals++;
			}

			const makeSummary = (t: any) => {
				let s = t.fg("success", `+${additions}`);
				s += t.fg("dim", " / ");
				s += t.fg("error", `-${removals}`);
				if (isPartial) s += t.fg("warning", " (preview)");
				return s;
			};

			// Collapsed → summary + first 5 rows
			if (!expanded) {
				const diffView = new SideBySideDiffView(details.diff, theme, makeSummary, 5);
				return diffView as SideBySideDiffView & Text;
			}

			// Expanded → full side-by-side diff
			const diffView = new SideBySideDiffView(details.diff, theme, makeSummary);
			return diffView as SideBySideDiffView & Text;
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
