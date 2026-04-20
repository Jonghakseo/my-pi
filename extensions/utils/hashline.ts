/** biome-ignore-all lint/style/noNonNullAssertion: vendored hashline engine preserves upstream array-bound assumptions for anchor math. */
/** biome-ignore-all lint/complexity/noExcessiveCognitiveComplexity: vendored hashline engine keeps upstream control flow for protocol parity. */
/**
 * Hashline engine — hash-anchored line editing.
 *
 * Vendored & adapted from oh-my-pi (MIT, github.com/can1357/oh-my-pi).
 */

import * as Diff from "diff";
import * as XXH from "xxhashjs";
import { throwIfAborted } from "./runtime.ts";

// ─── Types ──────────────────────────────────────────────────────────────

export type Anchor = { line: number; hash: string; textHint?: string };
export type HashlineEdit =
	| { op: "replace"; pos: Anchor; end?: Anchor; lines: string[] }
	| { op: "append"; pos?: Anchor; lines: string[] }
	| { op: "prepend"; pos?: Anchor; lines: string[] }
	| { op: "replace_text"; oldText: string; newText: string };

interface HashMismatch {
	line: number;
	expected: string;
	actual: string;
}

interface NoopEdit {
	editIndex: number;
	loc: string;
	currentContent: string;
}

// ─── Hash computation ───────────────────────────────────────────────────

/**
 * Custom 16-character hash alphabet. Deliberately excludes:
 * - Hex digits A–F (prevents confusion with hex literals in code)
 * - Visually confusable letters: D, G, I, L, O (look like digits 0, 6, 1, 1, 0)
 * - Common vowels A, E, I, O, U (prevents accidental English words)
 *
 * This makes hash references like "5#MQ" unambiguous — they can never be
 * mistaken for code content, hex literals, or natural language.
 */
const NIBBLE_STR = "ZPMQVRWSNKTXJBYH";
const HASH_ALPHABET_RE = new RegExp(`^[${NIBBLE_STR}]+$`);

const DICT = Array.from({ length: 256 }, (_, i) => {
	const h = i >>> 4;
	const l = i & 0x0f;
	return `${NIBBLE_STR[h]}${NIBBLE_STR[l]}`;
});

/** Pattern matching hashline display format prefixes: `LINE#ID:CONTENT` and `#ID:CONTENT` */
const HASHLINE_PREFIX_RE = /^\s*(?:>>>|>>)?\s*(?:\d+\s*#\s*|#\s*)[ZPMQVRWSNKTXJBYH]{2}:/;
const HASHLINE_PREFIX_PLUS_RE = /^\+\s*(?:\d+\s*#\s*|#\s*)[ZPMQVRWSNKTXJBYH]{2}:/;
const DIFF_PLUS_RE = /^\+(?!\+)/;
const DIFF_MINUS_RE = /^-\s*\d+\s{4}/;

function stripDiffPreviewPrefix(line: string): string | null {
	if (DIFF_MINUS_RE.test(line)) {
		return null;
	}
	if (HASHLINE_PREFIX_PLUS_RE.test(line)) {
		return line.replace(HASHLINE_PREFIX_PLUS_RE, "");
	}
	if (HASHLINE_PREFIX_RE.test(line)) {
		return line.replace(HASHLINE_PREFIX_RE, "");
	}
	return line.replace(DIFF_PLUS_RE, "");
}

/** Lines containing no alphanumeric characters (only punctuation/symbols/whitespace). */
const RE_SIGNIFICANT = /[\p{L}\p{N}]/u;

function xxh32(input: string, seed = 0): number {
	return XXH.h32(seed).update(input).digest().toNumber() >>> 0;
}

export function computeLineHash(idx: number, line: string): string {
	const normalizedLine = line.replace(/\r/g, "").trimEnd();
	let seed = 0;
	if (!RE_SIGNIFICANT.test(normalizedLine)) {
		seed = idx;
	}
	return DICT[xxh32(normalizedLine, seed) & 0xff];
}

/** Shared fuzzy-match Unicode replacement regexes (also used by edit-diff.ts). */
export const FUZZY_SINGLE_QUOTES_RE = /[\u2018\u2019\u201A\u201B]/g;
export const FUZZY_DOUBLE_QUOTES_RE = /[\u201C\u201D\u201E\u201F]/g;
export const FUZZY_HYPHENS_RE = /[\u2010\u2011\u2012\u2013\u2014\u2015\u2212]/g;
export const FUZZY_UNICODE_SPACES_RE = /[\u00A0\u2002-\u200A\u202F\u205F\u3000]/g;

function normalizeFuzzyLine(text: string): string {
	return text
		.trimEnd()
		.replace(FUZZY_SINGLE_QUOTES_RE, "'")
		.replace(FUZZY_DOUBLE_QUOTES_RE, '"')
		.replace(FUZZY_HYPHENS_RE, "-")
		.replace(FUZZY_UNICODE_SPACES_RE, " ");
}

function isFuzzyEquivalentLine(expected: string, actual: string): boolean {
	return normalizeFuzzyLine(expected) === normalizeFuzzyLine(actual);
}

// ─── Parsing ────────────────────────────────────────────────────────────

function diagnoseLineRef(ref: string): string {
	const trimmed = ref.trim();
	const core = ref.replace(/^\s*[>+-]*\s*/, "").trim();

	if (!core.length) {
		return `Invalid line reference "${ref}". Expected "LINE#HASH" (e.g. "5#MQ").`;
	}
	if (/^\d+\s*$/.test(core)) {
		return `Invalid line reference "${ref}": missing hash, use "LINE#HASH" from read output (e.g. "5#MQ").`;
	}
	if (/^\d+\s*:/.test(core)) {
		return `Invalid line reference "${ref}": wrong separator, use "LINE#HASH" instead of "LINE:...".`;
	}

	const hashMatch = core.match(/^(\d+)\s*#\s*([^\s:]+)(?:\s*:.*)?$/);
	if (hashMatch) {
		const line = Number.parseInt(hashMatch[1]!, 10);
		const hash = hashMatch[2]!;
		if (line < 1) {
			return `Line number must be >= 1, got ${line} in "${ref}".`;
		}
		if (hash.length !== 2) {
			return `Invalid line reference "${ref}": hash must be exactly 2 characters from ${NIBBLE_STR}.`;
		}
		if (!HASH_ALPHABET_RE.test(hash)) {
			return `Invalid line reference "${ref}": hash uses invalid characters, hashes use alphabet ${NIBBLE_STR} only.`;
		}
	}

	const missingHashMatch = core.match(/^(\d+)\s*#\s*$/);
	if (missingHashMatch) {
		return `Invalid line reference "${ref}": missing hash after "#", use "LINE#HASH" from read output.`;
	}

	if (/^0+\s*#/.test(core)) {
		return `Line number must be >= 1, got 0 in "${ref}".`;
	}

	return `Invalid line reference "${trimmed || ref}". Expected "LINE#HASH" (e.g. "5#MQ").`;
}

export function parseLineRef(ref: string): { line: number; hash: string } {
	// Match LINE#HASH format, tolerating:
	//  - leading ">+" and whitespace (from mismatch/diff display)
	//  - optional trailing display suffix (":..." content)
	const parsed = parseAnchorRef(ref);
	return { line: parsed.line, hash: parsed.hash };
}

function parseAnchorRef(ref: string): Anchor {
	const core = ref.replace(/^\s*[>+-]*\s*/, "").trimEnd();
	const match = core.match(/^([0-9]+)\s*#\s*([^\s:]+)(?:\s*:(.*))?$/s);
	if (!match) {
		throw new Error(diagnoseLineRef(ref));
	}

	const line = Number.parseInt(match[1]!, 10);
	if (line < 1) {
		throw new Error(`Line number must be >= 1, got ${line} in "${ref}".`);
	}

	const hash = match[2]!;
	if (hash.length !== 2) {
		throw new Error(`Invalid line reference "${ref}": hash must be exactly 2 characters from ${NIBBLE_STR}.`);
	}

	if (!HASH_ALPHABET_RE.test(hash)) {
		throw new Error(
			`Invalid line reference "${ref}": hash uses invalid characters, hashes use alphabet ${NIBBLE_STR} only.`,
		);
	}

	const textHint = match[3];
	return {
		line,
		hash,
		...(textHint !== undefined ? { textHint } : {}),
	};
}

// ─── Mismatch formatting ────────────────────────────────────────────────

function formatMismatchError(
	mismatches: HashMismatch[],
	fileLines: string[],
	retryLines: ReadonlySet<number> = new Set<number>(),
): string {
	const retryLineSet = new Set<number>(retryLines);
	for (const m of mismatches) {
		retryLineSet.add(m.line);
	}

	const displayLines = new Set<number>();
	for (const m of mismatches) {
		for (let i = Math.max(1, m.line - 2); i <= Math.min(fileLines.length, m.line + 2); i++) {
			displayLines.add(i);
		}
	}
	for (const line of retryLineSet) {
		displayLines.add(line);
	}

	const sorted = [...displayLines].sort((a, b) => a - b);
	const out: string[] = [
		`${mismatches.length} stale anchor${mismatches.length > 1 ? "s" : ""}. Retry with the >>> LINE#HASH lines below; keep both endpoints for range replaces.`,
		"",
	];

	let prev = -1;
	for (const num of sorted) {
		if (prev !== -1 && num > prev + 1) out.push("    ...");
		prev = num;
		const content = fileLines[num - 1];
		const hash = computeLineHash(num, content);
		const prefix = `${num}#${hash}`;
		out.push(retryLineSet.has(num) ? `>>> ${prefix}:${content}` : `    ${prefix}:${content}`);
	}

	return out.join("\n");
}

// ─── Content preprocessing ─────────────────────────────────────────────────────

export function stripNewLinePrefixes(lines: string[]): string[] {
	let hashCount = 0;
	let hashPlusCount = 0;
	let minusCount = 0;
	let diffPreviewCount = 0;
	let nonEmpty = 0;

	for (const line of lines) {
		if (!line.length) continue;
		nonEmpty++;

		const isHashLine = HASHLINE_PREFIX_RE.test(line);
		const isHashPlusLine = HASHLINE_PREFIX_PLUS_RE.test(line);
		const isMinusLine = DIFF_MINUS_RE.test(line);

		if (isHashLine) hashCount++;
		if (isHashPlusLine) hashPlusCount++;
		if (isHashLine || isHashPlusLine || isMinusLine) diffPreviewCount++;
		if (isMinusLine) minusCount++;
	}

	if (!nonEmpty) return lines;
	const stripHash = hashCount > 0 && hashCount === nonEmpty;
	const stripDiffPreview = !stripHash && (hashPlusCount > 0 || minusCount > 0) && diffPreviewCount === nonEmpty;
	if (!stripHash && !stripDiffPreview) return lines;

	if (stripDiffPreview) {
		const stripped: string[] = [];
		for (const line of lines) {
			const normalized = stripDiffPreviewPrefix(line);
			if (normalized !== null) stripped.push(normalized);
		}
		return stripped;
	}

	return lines.map((line) => line.replace(HASHLINE_PREFIX_RE, ""));
}

/**
 * Parse replacement text into lines with prefix stripping.
 *
 * String input is normalized to LF and drops exactly one trailing newline,
 * matching read-preview style content. Array input is preserved verbatim after
 * prefix stripping so explicitly provided blank lines remain intact.
 */
export function hashlineParseText(edit: string[] | string | null): string[] {
	if (edit === null) return [];
	if (typeof edit === "string") {
		const normalized = edit.endsWith("\n") ? edit.slice(0, -1) : edit;
		return stripNewLinePrefixes(normalized.replaceAll("\r", "").split("\n"));
	}

	return stripNewLinePrefixes(edit);
}

/**
 * Map flat tool-schema edits into typed internal representations.
 *
 * Strict: provided anchors must parse successfully. Missing anchors are
 * fine for append (→ EOF) and prepend (→ BOF), but a malformed anchor
 * that was explicitly supplied is always an error.
 *
 * - replace + pos only → single-line replace
 * - replace + pos + end → range replace
 * - append + pos → append after that anchor
 * - prepend + pos → prepend before that anchor
 * - replace_text + oldText/newText → exact unique text replace
 * - no anchors → file-level append/prepend (only for those ops)
 *
 * Unknown or missing ops are rejected explicitly.
 */
export function resolveEditAnchors(edits: HashlineToolEdit[]): HashlineEdit[] {
	const result: HashlineEdit[] = [];
	for (const edit of edits) {
		const op = edit.op;
		if (op !== "replace" && op !== "append" && op !== "prepend" && op !== "replace_text") {
			throw new Error(`Unknown edit op "${op}". Expected "replace", "append", "prepend", or "replace_text".`);
		}

		switch (op) {
			case "replace": {
				if (!edit.pos) {
					throw new Error('Replace requires a "pos" anchor.');
				}

				result.push({
					op: "replace",
					pos: parseAnchorRef(edit.pos),
					...(edit.end ? { end: parseAnchorRef(edit.end) } : {}),
					lines: hashlineParseText(edit.lines ?? null),
				});
				break;
			}
			case "append": {
				if (edit.end !== undefined) {
					throw new Error('Append does not support "end". Use "pos" or omit it for EOF.');
				}

				result.push({
					op: "append",
					...(edit.pos ? { pos: parseAnchorRef(edit.pos) } : {}),
					lines: hashlineParseText(edit.lines ?? null),
				});
				break;
			}
			case "prepend": {
				if (edit.end !== undefined) {
					throw new Error('Prepend does not support "end". Use "pos" or omit it for BOF.');
				}

				result.push({
					op: "prepend",
					...(edit.pos ? { pos: parseAnchorRef(edit.pos) } : {}),
					lines: hashlineParseText(edit.lines ?? null),
				});
				break;
			}
			case "replace_text": {
				const oldText = normalizeExactText(edit.oldText);
				const newText = normalizeExactText(edit.newText);
				if (oldText === undefined || newText === undefined) {
					throw new Error('replace_text requires string "oldText" and "newText" fields.');
				}

				result.push({
					op: "replace_text",
					oldText,
					newText,
				});
				break;
			}
		}
	}
	return result;
}

// ─── Main edit engine ───────────────────────────────────────────────────

/** Schema-level edit as received from the tool layer (pos/end are tag strings, lines may be string|null). */
export type HashlineToolEdit = {
	op: string;
	pos?: string;
	end?: string;
	lines?: string[] | string | null;
	oldText?: string;
	newText?: string;
};

function normalizeExactText(text: string | undefined): string | undefined {
	if (typeof text !== "string") {
		return undefined;
	}

	return text.replaceAll("\r\n", "\n").replaceAll("\r", "\n");
}

function maybeWarnSuspiciousUnicodeEscapePlaceholder(edits: HashlineEdit[], warnings: string[]): void {
	for (const edit of edits) {
		if (edit.op === "replace_text") {
			continue;
		}
		if (edit.lines.some((line) => /\\uDDDD/i.test(line))) {
			warnings.push(
				"Detected literal \\uDDDD in edit content; no autocorrection applied. Verify whether this should be a real Unicode escape or plain text.",
			);
		}
	}
}

type ResolvedEditSpan = {
	kind: "replace" | "insert";
	index: number;
	label: string;
	start: number;
	end: number;
	replacement: string;
	boundary?: number;
	insertMode?: "append-empty-origin" | "prepend-empty-origin";
};

type LineIndex = {
	fileLines: string[];
	lineStarts: number[];
	hasTerminalNewline: boolean;
};

function buildLineIndex(content: string): LineIndex {
	const fileLines = content.split("\n");
	const lineStarts: number[] = [];
	let offset = 0;

	for (let index = 0; index < fileLines.length; index++) {
		lineStarts.push(offset);
		offset += fileLines[index]?.length;
		if (index < fileLines.length - 1) {
			offset += 1;
		}
	}

	return {
		fileLines,
		lineStarts,
		hasTerminalNewline: content.endsWith("\n"),
	};
}

function previewText(text: string): string {
	const compact = text.replaceAll("\n", "\\n");
	return compact.length > 32 ? `${compact.slice(0, 29)}...` : compact;
}

function describeEdit(edit: HashlineEdit): string {
	switch (edit.op) {
		case "replace":
			return edit.end
				? `replace ${edit.pos.line}#${edit.pos.hash}-${edit.end.line}#${edit.end.hash}`
				: `replace ${edit.pos.line}#${edit.pos.hash}`;
		case "append":
			return edit.pos ? `append after ${edit.pos.line}#${edit.pos.hash}` : "append at EOF";
		case "prepend":
			return edit.pos ? `prepend before ${edit.pos.line}#${edit.pos.hash}` : "prepend at BOF";
		case "replace_text":
			return `replace_text "${previewText(edit.oldText)}"`;
	}
}

function throwEditConflict(
	left: { index: number; label: string },
	right: { index: number; label: string },
	reason: string,
): never {
	throw new Error(
		`Conflicting edits in a single request: edit ${left.index} (${left.label}) and edit ${right.index} (${right.label}) ${reason}. Merge them into one non-overlapping change or split the request.`,
	);
}

function cloneHashlineEdit(edit: HashlineEdit): HashlineEdit {
	switch (edit.op) {
		case "replace":
			return {
				op: "replace",
				pos: { ...edit.pos },
				...(edit.end ? { end: { ...edit.end } } : {}),
				lines: [...edit.lines],
			};
		case "append":
			return {
				op: "append",
				...(edit.pos ? { pos: { ...edit.pos } } : {}),
				lines: [...edit.lines],
			};
		case "prepend":
			return {
				op: "prepend",
				...(edit.pos ? { pos: { ...edit.pos } } : {}),
				lines: [...edit.lines],
			};
		case "replace_text":
			return {
				op: "replace_text",
				oldText: edit.oldText,
				newText: edit.newText,
			};
	}
}

function computeInsertionBoundary(
	edit: Extract<HashlineEdit, { op: "append" | "prepend" }>,
	lineIndex: LineIndex,
): number {
	switch (edit.op) {
		case "append": {
			const fileLineCount = lineIndex.fileLines.length;
			const eofBoundary = lineIndex.hasTerminalNewline && fileLineCount > 0 ? fileLineCount - 1 : fileLineCount;
			return edit.pos
				? lineIndex.hasTerminalNewline && edit.pos.line === fileLineCount
					? eofBoundary
					: edit.pos.line
				: eofBoundary;
		}
		case "prepend":
			return edit.pos ? edit.pos.line - 1 : 0;
	}
}

function findExactUniqueTextMatch(content: string, oldText: string): { start: number; end: number } {
	if (oldText.length === 0) {
		throw new Error("replace_text requires non-empty oldText.");
	}

	const matches: number[] = [];
	let from = 0;
	while (from <= content.length - oldText.length) {
		const index = content.indexOf(oldText, from);
		if (index === -1) {
			break;
		}
		matches.push(index);
		from = index + 1;
	}

	for (let index = 1; index < matches.length; index++) {
		if (matches[index]! - matches[index - 1]! < oldText.length) {
			throw new Error("replace_text found overlapping exact matches; re-read and use hashline edits.");
		}
	}

	if (matches.length === 0) {
		throw new Error("replace_text found no exact unique match in the current file.");
	}

	if (matches.length > 1) {
		throw new Error("replace_text found multiple exact matches in the current file. Re-read and use hashline edits.");
	}

	const start = matches[0]!;
	return {
		start,
		end: start + oldText.length,
	};
}

function resolveEditToSpan(
	edit: HashlineEdit,
	index: number,
	content: string,
	lineIndex: LineIndex,
	noopEdits: NoopEdit[],
): ResolvedEditSpan | null {
	const { fileLines, lineStarts, hasTerminalNewline } = lineIndex;

	switch (edit.op) {
		case "replace": {
			const startLine = edit.pos.line;
			const endLine = edit.end?.line ?? edit.pos.line;
			const originalLines = fileLines.slice(startLine - 1, endLine);
			if (
				originalLines.length === edit.lines.length &&
				originalLines.every((line, lineIndex) => line === edit.lines[lineIndex])
			) {
				noopEdits.push({
					editIndex: index,
					loc: `${edit.pos.line}#${edit.pos.hash}`,
					currentContent: originalLines.join("\n"),
				});
				return null;
			}

			if (edit.lines.length > 0) {
				return {
					kind: "replace",
					index,
					label: describeEdit(edit),
					start: lineStarts[startLine - 1]!,
					end: lineStarts[endLine - 1]! + fileLines[endLine - 1]?.length,
					replacement: edit.lines.join("\n"),
				};
			}

			if (startLine === 1 && endLine === fileLines.length) {
				return {
					kind: "replace",
					index,
					label: describeEdit(edit),
					start: 0,
					end: content.length,
					replacement: "",
				};
			}

			if (endLine < fileLines.length) {
				return {
					kind: "replace",
					index,
					label: describeEdit(edit),
					start: lineStarts[startLine - 1]!,
					end: lineStarts[endLine]!,
					replacement: "",
				};
			}

			return {
				kind: "replace",
				index,
				label: describeEdit(edit),
				start: Math.max(0, lineStarts[startLine - 1]! - 1),
				end: lineStarts[endLine - 1]! + fileLines[endLine - 1]?.length,
				replacement: "",
			};
		}
		case "append": {
			if (edit.lines.length === 0) {
				noopEdits.push({
					editIndex: index,
					loc: edit.pos ? `${edit.pos.line}#${edit.pos.hash}` : "EOF",
					currentContent: edit.pos ? (fileLines[edit.pos.line - 1] ?? "") : "",
				});
				return null;
			}

			const insertedText = edit.lines.join("\n");
			if (content.length === 0) {
				return {
					kind: "insert",
					index,
					label: describeEdit(edit),
					start: 0,
					end: 0,
					replacement: insertedText,
					boundary: computeInsertionBoundary(edit, lineIndex),
					insertMode: "append-empty-origin",
				};
			}

			if (!edit.pos) {
				return {
					kind: "insert",
					index,
					label: describeEdit(edit),
					start: content.length,
					end: content.length,
					replacement: hasTerminalNewline ? `${insertedText}\n` : `\n${insertedText}`,
					boundary: computeInsertionBoundary(edit, lineIndex),
				};
			}

			const isSentinelAppend = hasTerminalNewline && edit.pos.line === fileLines.length;
			return {
				kind: "insert",
				index,
				label: describeEdit(edit),
				start: isSentinelAppend
					? content.length
					: lineStarts[edit.pos.line - 1]! + fileLines[edit.pos.line - 1]?.length,
				end: isSentinelAppend ? content.length : lineStarts[edit.pos.line - 1]! + fileLines[edit.pos.line - 1]?.length,
				replacement: isSentinelAppend ? `${insertedText}\n` : `\n${insertedText}`,
				boundary: computeInsertionBoundary(edit, lineIndex),
			};
		}
		case "prepend": {
			if (edit.lines.length === 0) {
				noopEdits.push({
					editIndex: index,
					loc: edit.pos ? `${edit.pos.line}#${edit.pos.hash}` : "BOF",
					currentContent: edit.pos ? (fileLines[edit.pos.line - 1] ?? "") : "",
				});
				return null;
			}

			const insertedText = edit.lines.join("\n");
			const start = edit.pos ? lineStarts[edit.pos.line - 1]! : 0;
			return {
				kind: "insert",
				index,
				label: describeEdit(edit),
				start,
				end: start,
				replacement: content.length === 0 ? insertedText : `${insertedText}\n`,
				boundary: computeInsertionBoundary(edit, lineIndex),
				...(content.length === 0 ? { insertMode: "prepend-empty-origin" as const } : {}),
			};
		}
		case "replace_text": {
			const match = findExactUniqueTextMatch(content, edit.oldText);
			if (edit.oldText === edit.newText) {
				noopEdits.push({
					editIndex: index,
					loc: `replace_text "${previewText(edit.oldText)}"`,
					currentContent: edit.oldText,
				});
				return null;
			}

			return {
				kind: "replace",
				index,
				label: describeEdit(edit),
				start: match.start,
				end: match.end,
				replacement: edit.newText,
			};
		}
	}
}

function assertNoConflictingSpans(spans: ResolvedEditSpan[]): void {
	for (let leftIndex = 0; leftIndex < spans.length; leftIndex++) {
		const left = spans[leftIndex]!;
		for (let rightIndex = leftIndex + 1; rightIndex < spans.length; rightIndex++) {
			const right = spans[rightIndex]!;

			if (left.kind === "insert" && right.kind === "insert") {
				if (left.boundary === right.boundary) {
					throwEditConflict(left, right, "target the same insertion boundary");
				}
				continue;
			}

			if (left.kind === "replace" && right.kind === "replace") {
				if (left.start < right.end && right.start < left.end) {
					throwEditConflict(left, right, "overlap on the same original line range");
				}
				continue;
			}

			const replaceSpan = left.kind === "replace" ? left : right;
			const insertSpan = left.kind === "insert" ? left : right;
			if (insertSpan.start >= replaceSpan.start && insertSpan.start < replaceSpan.end) {
				throwEditConflict(
					left,
					right,
					"cannot be applied together because one inserts inside a replaced original range",
				);
			}
		}
	}
}

export function applyHashlineEdits(
	content: string,
	edits: HashlineEdit[],
	signal?: AbortSignal,
): {
	content: string;
	firstChangedLine: number | undefined;
	lastChangedLine: number | undefined;
	warnings?: string[];
	noopEdits?: NoopEdit[];
} {
	throwIfAborted(signal);
	if (!edits.length) return { content, firstChangedLine: undefined, lastChangedLine: undefined };

	const workingEdits = edits.map(cloneHashlineEdit);
	const lineIndex = buildLineIndex(content);
	const noopEdits: NoopEdit[] = [];
	const warnings: string[] = [];

	const mismatches: HashMismatch[] = [];
	const retryLines = new Set<number>();
	const acceptedFuzzyRefs = new Set<string>();
	function validate(ref: Anchor): boolean {
		if (ref.line < 1 || ref.line > lineIndex.fileLines.length) {
			throw new Error(`Line ${ref.line} does not exist (file has ${lineIndex.fileLines.length} lines)`);
		}
		const line = lineIndex.fileLines[ref.line - 1]!;
		const actual = computeLineHash(ref.line, line);
		if (actual === ref.hash) return true;
		if (ref.textHint !== undefined) {
			const hintedHash = computeLineHash(ref.line, ref.textHint);
			if (hintedHash === ref.hash && isFuzzyEquivalentLine(ref.textHint, line)) {
				const key = `${ref.line}:${ref.hash}:${ref.textHint}`;
				if (!acceptedFuzzyRefs.has(key)) {
					acceptedFuzzyRefs.add(key);
					warnings.push(
						`Accepted fuzzy anchor validation at line ${ref.line}: exact hash mismatched, but the copied line content still matched after whitespace/Unicode normalization.`,
					);
				}
				return true;
			}
		}
		mismatches.push({ line: ref.line, expected: ref.hash, actual });
		retryLines.add(ref.line);
		return false;
	}

	for (const edit of workingEdits) {
		throwIfAborted(signal);
		switch (edit.op) {
			case "replace": {
				if (edit.end) {
					if (edit.pos.line > edit.end.line) {
						throw new Error(`Range start line ${edit.pos.line} must be <= end line ${edit.end.line}`);
					}
					const startOk = validate(edit.pos);
					const endOk = validate(edit.end);
					if (!startOk && endOk) {
						retryLines.add(edit.end.line);
					}
					if (startOk && !endOk) {
						retryLines.add(edit.pos.line);
					}
					if (!startOk || !endOk) continue;
				} else if (!validate(edit.pos)) {
					continue;
				}
				const endLine = edit.end?.line ?? edit.pos.line;
				const nextLine = lineIndex.fileLines[endLine];
				const replacementLastLine = edit.lines.at(-1)?.trim();
				if (
					nextLine !== undefined &&
					replacementLastLine &&
					RE_SIGNIFICANT.test(replacementLastLine) &&
					replacementLastLine === nextLine.trim()
				) {
					warnings.push(
						`Potential boundary duplication after ${describeEdit(edit)}: the replacement ends with a line that matches the next surviving line after trim.`,
					);
				}
				break;
			}
			case "append": {
				if (edit.pos && !validate(edit.pos)) continue;
				if (edit.lines.length === 0) {
					throw new Error("Append with empty lines payload. Provide content to insert or remove the edit.");
				}
				break;
			}
			case "prepend": {
				if (edit.pos && !validate(edit.pos)) continue;
				if (edit.lines.length === 0) {
					throw new Error("Prepend with empty lines payload. Provide content to insert or remove the edit.");
				}
				break;
			}
			case "replace_text":
				break;
		}
	}
	if (mismatches.length) {
		throw new Error(formatMismatchError(mismatches, lineIndex.fileLines, retryLines));
	}

	maybeWarnSuspiciousUnicodeEscapePlaceholder(workingEdits, warnings);

	const seenSpanKeys = new Set<string>();
	const resolvedSpans: ResolvedEditSpan[] = [];
	for (const [index, edit] of workingEdits.entries()) {
		throwIfAborted(signal);
		const span = resolveEditToSpan(edit, index, content, lineIndex, noopEdits);
		if (!span) {
			continue;
		}

		const spanKey =
			span.kind === "insert"
				? `insert:${span.boundary}:${span.replacement}`
				: `replace:${span.start}:${span.end}:${span.replacement}`;
		if (seenSpanKeys.has(spanKey)) {
			continue;
		}
		seenSpanKeys.add(spanKey);
		resolvedSpans.push(span);
	}

	assertNoConflictingSpans(resolvedSpans);

	const orderedSpans = [...resolvedSpans].sort((left, right) => {
		if (right.end !== left.end) {
			return right.end - left.end;
		}
		if (left.kind !== right.kind) {
			return left.kind === "replace" ? -1 : 1;
		}
		if (left.kind === "insert" && right.kind === "insert") {
			return (right.boundary ?? -1) - (left.boundary ?? -1) || left.index - right.index;
		}
		return left.index - right.index;
	});

	let result = content;
	for (const span of orderedSpans) {
		throwIfAborted(signal);
		const replacement =
			span.insertMode === "append-empty-origin"
				? result.length === 0
					? span.replacement
					: `\n${span.replacement}`
				: span.insertMode === "prepend-empty-origin"
					? result.length === 0
						? span.replacement
						: `${span.replacement}\n`
					: span.replacement;
		result = result.slice(0, span.start) + replacement + result.slice(span.end);
	}

	const changedRange = computeLegacyEditLineRange(content, result);
	return {
		content: result,
		firstChangedLine: changedRange?.firstChangedLine,
		lastChangedLine: changedRange?.lastChangedLine,
		...(warnings.length ? { warnings } : {}),
		...(noopEdits.length ? { noopEdits } : {}),
	};
}

// ─── Affected-line computation (for returning anchors after edit) ───────

const ANCHOR_CONTEXT_LINES = 2;
const ANCHOR_MAX_OUTPUT_LINES = 12;

function getVisibleDiffLines(text: string): string[] {
	const lines = text.split("\n");
	if (lines[lines.length - 1] === "") lines.pop();
	return lines;
}

function countVisibleLines(text: string): number {
	if (text.length === 0) {
		return 0;
	}
	const lines = text.split("\n");
	return text.endsWith("\n") ? lines.length - 1 : lines.length;
}

/**
 * Compute one or more post-edit anchor ranges covering changed hunks plus context.
 *
 * Nearby hunks merge after context expansion. Returns null if the combined output
 * would exceed the anchor output budget, signalling that the LLM should re-read
 * instead of receiving oversized anchor blocks.
 */
export function computeAffectedLineRanges(params: {
	originalContent: string;
	resultContent: string;
	contextLines?: number;
	maxOutputLines?: number;
}): Array<{ start: number; end: number }> | null {
	const {
		originalContent,
		resultContent,
		contextLines = ANCHOR_CONTEXT_LINES,
		maxOutputLines = ANCHOR_MAX_OUTPUT_LINES,
	} = params;

	const resultLineCount = countVisibleLines(resultContent);
	if (resultLineCount === 0 || originalContent === resultContent) {
		return null;
	}

	const parts = Diff.diffLines(originalContent, resultContent);
	const expandedRanges: Array<{ start: number; end: number }> = [];
	let newLineNum = 1;

	for (let index = 0; index < parts.length; ) {
		const part = parts[index]!;
		const lines = getVisibleDiffLines(part.value);

		if (!part.added && !part.removed) {
			newLineNum += lines.length;
			index++;
			continue;
		}

		const hunkStartNewLine = newLineNum;
		let addedLines = 0;

		while (index < parts.length && (parts[index]!.added || parts[index]!.removed)) {
			const hunkPart = parts[index]!;
			const hunkLines = getVisibleDiffLines(hunkPart.value);
			if (hunkPart.added) {
				addedLines += hunkLines.length;
				newLineNum += hunkLines.length;
			}
			index++;
		}

		const firstChangedLine =
			addedLines > 0 ? hunkStartNewLine : Math.min(Math.max(1, hunkStartNewLine), resultLineCount);
		const lastChangedLine = addedLines > 0 ? newLineNum - 1 : firstChangedLine;
		const start = Math.max(1, firstChangedLine - contextLines);
		const end = Math.min(resultLineCount, lastChangedLine + contextLines);

		if (end < start) {
			return null;
		}

		expandedRanges.push({ start, end });
	}

	if (expandedRanges.length === 0) {
		return null;
	}

	const mergedRanges: Array<{ start: number; end: number }> = [];
	for (const range of expandedRanges) {
		const previous = mergedRanges.at(-1);
		if (previous && range.start <= previous.end + 1) {
			previous.end = Math.max(previous.end, range.end);
			continue;
		}
		mergedRanges.push({ ...range });
	}

	const totalOutputLines = mergedRanges.reduce((sum, range) => sum + (range.end - range.start + 1), 0);
	if (totalOutputLines > maxOutputLines) {
		return null;
	}

	return mergedRanges;
}

export function formatHashlineRegion(lines: string[], startLine: number): string {
	return lines
		.map((line, index) => {
			const lineNumber = startLine + index;
			return `${lineNumber}#${computeLineHash(lineNumber, line)}:${line}`;
		})
		.join("\n");
}

// ─── Legacy edit line range computation ─────────────────────────────

/**
 * Compute first/last changed line numbers for legacy (oldText/newText) edits.
 * Uses character-level diff to locate the changed span, then maps to line
 * numbers in the result document so downstream anchor chaining works.
 */
export function computeLegacyEditLineRange(
	original: string,
	result: string,
): { firstChangedLine: number; lastChangedLine: number } | null {
	if (original === result) return null;

	function countVisibleLines(text: string): number {
		if (text.length === 0) {
			return 0;
		}
		const lines = text.split("\n");
		return text.endsWith("\n") ? lines.length - 1 : lines.length;
	}

	if (original.length === 0) {
		return {
			firstChangedLine: 1,
			lastChangedLine: countVisibleLines(result),
		};
	}

	if (result.startsWith(original) && original.endsWith("\n")) {
		return {
			firstChangedLine: countVisibleLines(original) + 1,
			lastChangedLine: countVisibleLines(result),
		};
	}

	let firstDiff = 0;
	const minLen = Math.min(original.length, result.length);
	while (firstDiff < minLen && original[firstDiff] === result[firstDiff]) {
		firstDiff++;
	}
	if (firstDiff === minLen && original.length === result.length) return null;

	let lastOrig = original.length - 1;
	let lastRes = result.length - 1;
	while (lastOrig >= firstDiff && lastRes >= firstDiff && original[lastOrig] === result[lastRes]) {
		lastOrig--;
		lastRes--;
	}

	function indexToLine(charIdx: number, text: string): number {
		let line = 1;
		for (let i = 0; i < charIdx && i < text.length; i++) {
			if (text[i] === "\n") line++;
		}
		return line;
	}

	const firstChangedLine = indexToLine(firstDiff + 1, result);
	let lastChangedLine: number;
	if (lastRes < firstDiff) {
		lastChangedLine = result.length === 0 ? 1 : countVisibleLines(result);
	} else if (firstDiff === 0 && original.length > 0 && result.endsWith(original)) {
		lastChangedLine = firstChangedLine;
	} else {
		lastChangedLine = indexToLine(lastRes + 1, result);
	}

	return { firstChangedLine, lastChangedLine };
}
