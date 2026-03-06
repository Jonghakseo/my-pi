/**
 * Override Built-in Tools — Compact tool output rendering
 *
 * Overrides built-in tools to provide cleaner, less noisy output:
 *   - Collapsed (ctrl+o): Only the tool call summary, no output
 *   - Expanded  (ctrl+o): Full output like the default renderers
 *
 * Usage: auto-loaded from ~/.pi/agent/extensions/
 */

import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, relative, resolve } from "node:path";
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

/** Generate a unified diff string (same format as pi's built-in edit tool). */
async function makeDiffString(oldContent: string, newContent: string, contextLines = 4) {
	const Diff = await import("diff");
	const parts = Diff.diffLines(oldContent, newContent);
	const output: string[] = [];
	const maxLineNum = Math.max(oldContent.split("\n").length, newContent.split("\n").length);
	const lnw = String(maxLineNum).length;
	let oldLn = 1,
		newLn = 1,
		lastWasChange = false;
	let firstChangedLine: number | undefined;
	for (let i = 0; i < parts.length; i++) {
		const part = parts[i];
		const raw = part.value.split("\n");
		if (raw.at(-1) === "") raw.pop();
		if (part.added || part.removed) {
			if (firstChangedLine === undefined) firstChangedLine = newLn;
			for (const line of raw) {
				if (part.added) {
					output.push(`+${String(newLn).padStart(lnw)} ${line}`);
					newLn++;
				} else {
					output.push(`-${String(oldLn).padStart(lnw)} ${line}`);
					oldLn++;
				}
			}
			lastWasChange = true;
		} else {
			const nextIsChange = i < parts.length - 1 && (parts[i + 1].added || parts[i + 1].removed);
			if (lastWasChange || nextIsChange) {
				let lines = raw,
					skipStart = 0,
					skipEnd = 0;
				if (!lastWasChange) {
					skipStart = Math.max(0, raw.length - contextLines);
					lines = raw.slice(skipStart);
				}
				if (!nextIsChange && lines.length > contextLines) {
					skipEnd = lines.length - contextLines;
					lines = lines.slice(0, contextLines);
				}
				if (skipStart > 0) {
					output.push(` ${" ".repeat(lnw)} ...`);
					oldLn += skipStart;
					newLn += skipStart;
				}
				for (const line of lines) {
					output.push(` ${String(oldLn).padStart(lnw)} ${line}`);
					oldLn++;
					newLn++;
				}
				if (skipEnd > 0) {
					output.push(` ${" ".repeat(lnw)} ...`);
					oldLn += skipEnd;
					newLn += skipEnd;
				}
			} else {
				oldLn += raw.length;
				newLn += raw.length;
			}
			lastWasChange = false;
		}
	}
	return { diff: output.join("\n"), firstChangedLine };
}

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

const WriteParams = Type.Object(
	{
		path: Type.String({ description: "Path to the file to write" }),
		content: Type.String({ description: "Content to write" }),
	},
	{ additionalProperties: true },
);

const EditParams = Type.Object(
	{
		path: Type.String({ description: "Target file path" }),
		edits: Type.Array(
			Type.Object(
				{
					op: Type.Union([
						Type.Literal("replace"),
						Type.Literal("append"),
						Type.Literal("prepend"),
						Type.Literal("insert"),
						Type.Literal("delete"),
					]),
					pos: Type.Optional(
						Type.Union([Type.String(), Type.Null()], {
							description: "Anchor line tag in LINE#ID format, e.g. 33#BX. Use the exact tag shown by read output.",
						}),
					),
					end: Type.Optional(
						Type.Union([Type.String(), Type.Null()], {
							description: "End line tag in LINE#ID format, e.g. 34#YS. Use the exact tag shown by read output.",
						}),
					),
					lines: Type.Optional(Type.Union([Type.Array(Type.String()), Type.String(), Type.Null()])),
				},
				{ additionalProperties: false },
			),
		),
		delete: Type.Optional(Type.Boolean()),
		move: Type.Optional(Type.String()),
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
	fg: (color: string, text: string) => string;
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
const HASH_ALPHABET = "ZPMQVRWSNKTXJBYH";
const HASH_LINE_PATTERN = /^\d+#[A-Z]{2}:/;
const RE_SIGNIFICANT = /[\p{L}\p{N}]/u;

function fnv1a32(text: string, seed = 0): number {
	let hash = (0x811c9dc5 ^ seed) >>> 0;
	for (let i = 0; i < text.length; i++) {
		hash ^= text.charCodeAt(i);
		hash = Math.imul(hash, 0x01000193) >>> 0;
	}
	return hash >>> 0;
}

function computeLineHash(lineNumber: number, line: string): string {
	const normalized = line.endsWith("\r") ? line.slice(0, -1) : line;
	const compact = normalized.replace(/\s+/g, "");
	const seed = RE_SIGNIFICANT.test(compact) ? 0 : lineNumber;
	const value = fnv1a32(compact, seed) & 0xff;
	const high = HASH_ALPHABET[(value >>> 4) & 0x0f] ?? "Z";
	const low = HASH_ALPHABET[value & 0x0f] ?? "Z";
	return `${high}${low}`;
}

function formatHashTaggedLines(text: string, startLine: number): string {
	const lines = text.split("\n");
	if (lines.every((line) => HASH_LINE_PATTERN.test(line))) return text;
	// Strip trailing phantom line from files ending with \n (matches applyStructuredEdits behavior)
	if (text.endsWith("\n") && lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
	return lines
		.map((line, index) => `${startLine + index}#${computeLineHash(startLine + index, line)}:${line}`)
		.join("\n");
}

function formatMultiReadSection(path: string, index: number, total: number, body: string, startLine: number): string {
	const header = [READ_SECTION_SEPARATOR, `[${index}/${total}] ${path}`, READ_SECTION_SEPARATOR].join("\n");
	return `${header}\n${formatHashTaggedLines(body, startLine)}`;
}

function withHashTaggedReadResult<T>(result: T, startLine: number): T {
	if (!result || typeof result !== "object") return result;
	const out = { ...(result as Record<string, unknown>) };
	const content = out.content;
	if (!Array.isArray(content)) return result;
	let changed = false;
	out.content = content.map((part) => {
		if (!part || typeof part !== "object") return part;
		if ((part as { type?: unknown }).type !== "text") return part;
		const text = (part as { text?: unknown }).text;
		if (typeof text !== "string") return part;
		changed = true;
		return { ...(part as Record<string, unknown>), text: formatHashTaggedLines(text, startLine) };
	});
	return (changed ? out : result) as T;
}

type LineTag = {
	line: number;
	hash: string;
};

type StructuredEditOp = {
	op: "replace" | "append" | "prepend";
	posTag: LineTag | null;
	endTag: LineTag | null;
	lines: string[] | null;
};

function parseLineTag(tag: unknown): LineTag | null {
	if (tag == null) return null;
	if (typeof tag !== "string") return null;
	const match = tag.trim().match(/^(\d+)#([A-Z]{2})$/);
	if (!match) return null;
	const line = Number(match[1]);
	if (!Number.isInteger(line) || line < 1) return null;
	return { line, hash: match[2] };
}

function normalizeEditLines(value: unknown): string[] | null | undefined {
	if (value == null) return null;
	if (typeof value === "string") return value.split("\n");
	if (Array.isArray(value)) {
		if (!value.every((entry) => typeof entry === "string")) return undefined;
		return value as string[];
	}
	return undefined;
}

function parseStructuredEditOps(rawOps: unknown): { ops: StructuredEditOp[] | null; error?: string } {
	if (rawOps == null) return { ops: null };
	if (!Array.isArray(rawOps)) return { ops: null, error: "edits must be an array." };

	const ops: StructuredEditOp[] = [];
	for (const raw of rawOps) {
		if (!raw || typeof raw !== "object") return { ops: null, error: "Each edit must be an object." };
		const entry = raw as Record<string, unknown>;
		const rawOp = entry.op;
		let op: StructuredEditOp["op"] | null = null;
		if (rawOp === "replace" || rawOp === "append" || rawOp === "prepend") op = rawOp;
		else if (rawOp === "insert") op = "append";
		else if (rawOp === "delete") op = "replace";
		if (!op) {
			return { ops: null, error: "edit.op must be one of replace, append, prepend, insert, delete." };
		}

		const posTag = parseLineTag(entry.pos);
		const endTag = parseLineTag(entry.end);
		const lines = normalizeEditLines(entry.lines);
		if (lines === undefined) return { ops: null, error: "edit.lines must be string[], string, or null." };

		if ((rawOp === "replace" || rawOp === "delete") && posTag == null) {
			return {
				ops: null,
				error:
					'replace/delete operations require pos in LINE#ID format (for example: "33#BX"). Use the exact tag shown by read output.',
			};
		}

		if (rawOp === "delete" && lines != null && lines.length > 0) {
			return { ops: null, error: "delete operations cannot include lines." };
		}

		if (entry.end != null && endTag == null) {
			return {
				ops: null,
				error: 'end must be a valid LINE#ID tag (for example: "34#YS"). Use the exact tag shown by read output.',
			};
		}

		if (entry.pos != null && posTag == null) {
			return {
				ops: null,
				error: 'pos must be a valid LINE#ID tag (for example: "33#BX"). Use the exact tag shown by read output.',
			};
		}

		ops.push({ op, posTag, endTag, lines: rawOp === "delete" ? [] : lines });
	}

	return { ops };
}

function validateTagAgainstLine(tag: LineTag, lines: string[]): string | undefined {
	if (tag.line < 1 || tag.line > lines.length) return `line ${tag.line} does not exist`;
	const lineText = lines[tag.line - 1] ?? "";
	const actualHash = computeLineHash(tag.line, lineText);
	if (actualHash !== tag.hash) {
		return `line ${tag.line} has changed since last read (${tag.hash} != ${actualHash})`;
	}
	return undefined;
}

function applyStructuredEdits(fileText: string, ops: StructuredEditOp[]): { text?: string; error?: string } {
	const hasTrailingNewline = fileText.endsWith("\n");
	const lines = fileText.length === 0 ? [] : fileText.split("\n");
	if (hasTrailingNewline && lines[lines.length - 1] === "") lines.pop();

	const withAnchor = ops.map((op, index) => {
		const anchor =
			op.posTag?.line ?? (op.op === "append" ? Number.MAX_SAFE_INTEGER - index : op.op === "prepend" ? 0 : -1);
		return { ...op, index, anchor };
	});
	withAnchor.sort((a, b) => (b.anchor !== a.anchor ? b.anchor - a.anchor : a.index - b.index));

	for (const op of withAnchor) {
		if (op.op === "replace") {
			const startTag = op.posTag as LineTag;
			const endTag = op.endTag ?? startTag;
			const startError = validateTagAgainstLine(startTag, lines);
			if (startError) return { error: startError };
			const endError = validateTagAgainstLine(endTag, lines);
			if (endError) return { error: endError };
			const start = startTag.line;
			const end = endTag.line;
			if (end < start) return { error: "replace end must be >= pos." };
			const replacement = op.lines ?? [];
			lines.splice(start - 1, end - start + 1, ...replacement);
			continue;
		}

		if (op.op === "prepend") {
			const insert = op.lines ?? [];
			if (insert.length === 0) continue;
			if (op.posTag) {
				const tagError = validateTagAgainstLine(op.posTag, lines);
				if (tagError) return { error: tagError };
			}
			const at = op.posTag == null ? 0 : op.posTag.line - 1;
			if (at < 0 || at > lines.length) return { error: `prepend pos out of range: ${op.posTag?.line ?? 0}` };
			lines.splice(at, 0, ...insert);
			continue;
		}

		const insert = op.lines ?? [];
		if (insert.length === 0) continue;
		if (op.posTag) {
			const tagError = validateTagAgainstLine(op.posTag, lines);
			if (tagError) return { error: tagError };
		}
		const at = op.posTag == null ? lines.length : op.posTag.line;
		if (at < 0 || at > lines.length) return { error: `append pos out of range: ${op.posTag?.line ?? 0}` };
		lines.splice(at, 0, ...insert);
	}

	const out = lines.join("\n");
	return { text: hasTrailingNewline ? `${out}\n` : out };
}

export async function executeStructuredEdit(cwd: string, params: Record<string, unknown>) {
	const relPath = typeof params.path === "string" ? params.path.trim() : "";
	if (!relPath) {
		return {
			isError: true,
			content: [{ type: "text" as const, text: "Error: path is required." }],
			details: undefined,
		};
	}

	const sourcePath = isAbsolute(relPath) ? relPath : resolve(cwd, relPath);
	const shouldDelete = params.delete === true;
	const moveTarget = typeof params.move === "string" ? params.move.trim() : "";
	const parsed = parseStructuredEditOps(params.edits);
	if (parsed.error) {
		return {
			isError: true,
			content: [{ type: "text" as const, text: `Error: ${parsed.error}` }],
			details: undefined,
		};
	}

	if (shouldDelete) {
		if (parsed.ops && parsed.ops.length > 0) {
			return {
				isError: true,
				content: [{ type: "text" as const, text: "Error: delete cannot be combined with edits." }],
				details: undefined,
			};
		}
		if (moveTarget) {
			return {
				isError: true,
				content: [{ type: "text" as const, text: "Error: delete cannot be combined with move." }],
				details: undefined,
			};
		}
		try {
			await unlink(sourcePath);
			return {
				content: [{ type: "text" as const, text: `Deleted ${relPath}` }],
				details: undefined,
			};
		} catch (error) {
			return {
				isError: true,
				content: [{ type: "text" as const, text: `Error: ${(error as Error).message}` }],
				details: undefined,
			};
		}
	}

	let original = "";
	try {
		original = await readFile(sourcePath, "utf8");
	} catch (error) {
		return {
			isError: true,
			content: [{ type: "text" as const, text: `Error: ${(error as Error).message}` }],
			details: undefined,
		};
	}

	let next = original;
	if (parsed.ops && parsed.ops.length > 0) {
		const applied = applyStructuredEdits(original, parsed.ops);
		if (applied.error || applied.text == null) {
			return {
				isError: true,
				content: [{ type: "text" as const, text: `Error: ${applied.error ?? "failed to apply edits"}` }],
				details: undefined,
			};
		}
		next = applied.text;
	}

	try {
		if (next !== original) {
			await writeFile(sourcePath, next, "utf8");
		}

		let finalPath = sourcePath;
		if (moveTarget) {
			const resolvedMove = isAbsolute(moveTarget) ? moveTarget : resolve(cwd, moveTarget);
			await mkdir(dirname(resolvedMove), { recursive: true });
			await rename(sourcePath, resolvedMove);
			finalPath = resolvedMove;
		}

		const changed = next !== original;
		const diffResult = changed ? await makeDiffString(original, next) : undefined;
		const message = [
			changed ? `Applied ${parsed.ops?.length ?? 0} edit operation(s)` : "No content changes",
			moveTarget ? `Moved to ${finalPath}` : "",
		]
			.filter(Boolean)
			.join(". ");
		return {
			content: [{ type: "text" as const, text: message }],
			details: diffResult
				? ({ diff: diffResult.diff, firstChangedLine: diffResult.firstChangedLine } as EditToolDetails)
				: undefined,
		};
	} catch (error) {
		return {
			isError: true,
			content: [{ type: "text" as const, text: `Error: ${(error as Error).message}` }],
			details: undefined,
		};
	}
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
	return output ? new Text(`\n${output}`, 0, 0) : new Text("", 0, 0);
}

/** Render first N lines as a dim preview with a "more" hint. */
function renderPreviewLines(text: string, maxLines: number, theme: RenderTheme): string {
	const lines = text.trim().split("\n");
	const preview = lines.slice(0, maxLines);
	const remaining = lines.length - maxLines;
	let output = preview.map((l) => theme.fg("dim", l)).join("\n");
	if (remaining > 0) {
		output += `\n${theme.fg("muted", `… +${remaining} lines`)}`;
	}
	return output;
}

function getObjectDetails(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) return {};
	return value as Record<string, unknown>;
}

function renderTailPreview(text: string, maxLines: number, theme: RenderTheme): string {
	const lines = text.split("\n");
	const displayLines = lines.slice(-maxLines);
	const hidden = lines.length - displayLines.length;

	let output = displayLines.map((line) => theme.fg("dim", truncateToWidth(line, 80))).join("\n");
	if (hidden > 0) {
		output = `${theme.fg("muted", `… (${hidden} earlier lines)`)}\n${output}`;
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

async function _resolveFuzzyCandidate(cwd: string, params: EditLikeParams): Promise<FuzzyCandidate | undefined> {
	const path = typeof params.path === "string" ? params.path : "";
	const oldText = typeof params.oldText === "string" ? params.oldText : "";
	if (!path || !oldText) return undefined;
	if (oldText.length < FUZZY_EDIT_MIN_OLDTEXT_LEN) return undefined;

	const absolutePath = isAbsolute(path) ? path : resolve(cwd, path);
	const fileText = await readFile(absolutePath, "utf8");
	if (fileText.length > FUZZY_EDIT_MAX_FILE_CHARS) return undefined;

	return findUniqueFuzzyCandidate(fileText, oldText);
}

function _shouldTryFuzzyEdit(params: EditLikeParams, result: unknown): boolean {
	if (typeof params.oldText !== "string" || params.oldText.length < FUZZY_EDIT_MIN_OLDTEXT_LEN) return false;
	const text = getResultText(result);
	return text.includes("Could not find the exact text") && text.includes("The old text must match exactly");
}

function _withFuzzyNote<T>(result: T, note: string): T {
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
	private theme: RenderTheme;
	private summaryFn: (t: RenderTheme) => string;
	private cachedWidth?: number;
	private cachedLines?: string[];

	constructor(diffText: string, theme: RenderTheme, summaryFn: (t: RenderTheme) => string, maxRows?: number) {
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
				const startLine = offset ?? 1;
				const tagged = withHashTaggedReadResult(single, startLine);
				const originalDetails = getObjectDetails(single.details as unknown);
				return {
					...tagged,
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

			const sharedParams = { ...readParams };
			delete sharedParams.path;

			const results = await Promise.all(
				paths.map((path) => builtInRead.execute(toolCallId, { ...sharedParams, path }, signal, onUpdate)),
			);

			const hasError = results.some((result) => Boolean((result as { isError?: boolean }).isError));
			const startLine = offset ?? 1;
			const text = results
				.map((result, index) => {
					const body = getResultText(result) || "[No text output]";
					return formatMultiReadSection(paths[index], index + 1, paths.length, body, startLine);
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
				const preview = renderPreviewLines(tc.text, 5, theme);
				return new Text(preview || "", 0, 0);
			}

			const body = renderFullOutput(tc.text, theme);
			const bodyText = (body as unknown as { text?: string }).text ?? "";
			return new Text(bodyText || "", 0, 0);
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
			let text = `${theme.fg("toolTitle", theme.bold("Write"))} ${display}`;
			if (lines > 0) text += theme.fg("muted", ` (${lines} lines)`);
			if (content) text += `\n${renderTailPreview(content, 6, theme)}`;
			return new Text(text, 0, 0);
		},

		renderResult(result, { expanded }, theme) {
			const details = getObjectDetails(result.details) as WriteRenderDetails & Record<string, unknown>;
			const path = typeof details.path === "string" ? details.path : "";
			const preview = typeof details.preview === "string" ? details.preview : "";
			const lineCount = typeof details.lineCount === "number" ? details.lineCount : preview ? countLines(preview) : 0;
			const byteCount =
				typeof details.byteCount === "number" ? details.byteCount : preview ? Buffer.byteLength(preview, "utf8") : 0;
			const header = `${theme.fg("toolTitle", theme.bold("Write"))} ${theme.fg("accent", shortenPath(path || "..."))}`;
			const meta = theme.fg("muted", `${lineCount} lines • ${byteCount} bytes`);
			const tc = result.content.find((c) => c.type === "text");
			const summary = tc?.type === "text" && tc.text ? theme.fg("toolOutput", tc.text) : "";

			if (!expanded) {
				const previewText = preview ? renderTailPreview(preview, 6, theme) : "";
				return new Text([header, meta, previewText, summary].filter(Boolean).join("\n"), 0, 0);
			}

			const fullPreview = preview ? renderFullOutput(preview, theme) : new Text("", 0, 0);
			const fullPreviewText = (fullPreview as unknown as { text?: string }).text ?? "";
			return new Text(
				[header, meta, fullPreviewText ? fullPreviewText.trimStart() : "", summary].filter(Boolean).join("\n"),
				0,
				0,
			);
		},
	});

	// ─── Edit ──────────────────────────────────────────────────────────────
	pi.registerTool({
		name: "edit",
		label: "edit",
		description:
			"Edit files via line-tag operations: path + edits[{ op, pos, end, lines }], with optional delete/move. pos/end must use the exact LINE#ID tag from read output (for example: 33#BX).",
		parameters: EditParams,

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			return executeStructuredEdit(ctx.cwd, params as Record<string, unknown>);
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

			const makeSummary = (t: RenderTheme) => {
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
