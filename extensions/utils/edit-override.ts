import * as Diff from "diff";

export interface EditOverrideEdit {
	oldText: string;
	newText: string;
	replaceAll?: boolean;
}

export type EditMatchStage = "exact" | "trim-trailing-whitespace" | "normalize-special-characters";
export type LineEnding = "\n" | "\r\n" | "\r";

export interface TextFormattingInfo {
	bom: string;
	lineEnding: LineEnding;
}

export interface MatchedEdit {
	editIndex: number;
	matchIndex: number;
	matchLength: number;
	matchedText: string;
	newText: string;
	stage: EditMatchStage;
	replaceAll: boolean;
}

export interface AppliedEditOverrideResult {
	newContent: string;
	diff: string;
	firstChangedLine?: number;
	matchedEdits: MatchedEdit[];
}

interface CanonicalizedText {
	text: string;
	indexMap: number[];
	trimTrailingWhitespace: boolean;
}

const SPECIAL_SINGLE_QUOTES_RE = /[\u2018\u2019\u201A\u201B]/g;
const SPECIAL_SINGLE_QUOTES_PRESENCE_RE = /[\u2018\u2019\u201A\u201B]/;
const SPECIAL_DOUBLE_QUOTES_RE = /[\u201C\u201D\u201E\u201F]/g;
const SPECIAL_DOUBLE_QUOTES_PRESENCE_RE = /[\u201C\u201D\u201E\u201F]/;
const SPECIAL_DASHES_RE = /[\u2010\u2011\u2012\u2013\u2014\u2015\u2212]/g;
const SPECIAL_SPACES_RE = /[\u00A0\u2002-\u200A\u202F\u205F\u3000]/g;
const WORDISH_RE = /[\p{L}\p{N}]/u;
const OPENING_QUOTE_PREVIOUS_CHARS = "([{<-–—=:+,;";

export function detectLineEnding(content: string): LineEnding {
	const firstNewlineMatch = content.match(/\r\n|\n|\r/);
	if (firstNewlineMatch?.[0] === "\r\n") return "\r\n";
	if (firstNewlineMatch?.[0] === "\r") return "\r";
	return "\n";
}

export function normalizeToLF(text: string): string {
	return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

export function restoreLineEndings(text: string, lineEnding: LineEnding): string {
	if (lineEnding === "\r\n") return text.replace(/\n/g, "\r\n");
	if (lineEnding === "\r") return text.replace(/\n/g, "\r");
	return text;
}

export function stripBom(content: string): { bom: string; text: string } {
	return content.startsWith("\uFEFF") ? { bom: "\uFEFF", text: content.slice(1) } : { bom: "", text: content };
}

export function inspectTextFormatting(rawContent: string): TextFormattingInfo & { text: string } {
	const { bom, text } = stripBom(rawContent);
	return {
		bom,
		lineEnding: detectLineEnding(text),
		text,
	};
}

export function restoreTextFormatting(text: string, formatting: TextFormattingInfo): string {
	return formatting.bom + restoreLineEndings(text, formatting.lineEnding);
}

export function normalizeSpecialCharacters(text: string): string {
	return text
		.replace(SPECIAL_SINGLE_QUOTES_RE, "'")
		.replace(SPECIAL_DOUBLE_QUOTES_RE, '"')
		.replace(SPECIAL_DASHES_RE, "-")
		.replace(SPECIAL_SPACES_RE, " ");
}

function isTrailingWhitespace(char: string): boolean {
	return char !== "\n" && /\s/u.test(char);
}

function canonicalizeForStage(text: string, stage: EditMatchStage): CanonicalizedText {
	if (stage === "exact") {
		return {
			text,
			indexMap: Array.from({ length: text.length }, (_unused, index) => index),
			trimTrailingWhitespace: false,
		};
	}

	let canonical = "";
	const indexMap: number[] = [];
	let lineStart = 0;

	while (lineStart <= text.length) {
		const newlineIndex = text.indexOf("\n", lineStart);
		const lineEnd = newlineIndex === -1 ? text.length : newlineIndex;
		let trimmedEnd = lineEnd;
		while (trimmedEnd > lineStart && isTrailingWhitespace(text[trimmedEnd - 1])) {
			trimmedEnd--;
		}

		for (let index = lineStart; index < trimmedEnd; index++) {
			canonical += text[index];
			indexMap.push(index);
		}

		if (newlineIndex !== -1) {
			canonical += "\n";
			indexMap.push(newlineIndex);
			lineStart = newlineIndex + 1;
			continue;
		}

		break;
	}

	if (stage === "normalize-special-characters") {
		canonical = normalizeSpecialCharacters(canonical);
	}

	return {
		text: canonical,
		indexMap,
		trimTrailingWhitespace: true,
	};
}

function findAllOccurrences(haystack: string, needle: string): number[] {
	const indices: number[] = [];
	let fromIndex = 0;

	while (fromIndex <= haystack.length - needle.length) {
		const matchIndex = haystack.indexOf(needle, fromIndex);
		if (matchIndex === -1) break;
		indices.push(matchIndex);
		fromIndex = matchIndex + 1;
	}

	return indices;
}

function expandMatchEndToTrailingWhitespace(content: string, endIndex: number): number {
	let expandedEnd = endIndex;
	while (expandedEnd < content.length && content[expandedEnd] !== "\n" && isTrailingWhitespace(content[expandedEnd])) {
		expandedEnd++;
	}
	return expandedEnd;
}

function getEmptyOldTextError(path: string, editIndex: number, totalEdits: number): Error {
	if (totalEdits === 1) {
		return new Error(`oldText must not be empty in ${path}.`);
	}
	return new Error(`edits[${editIndex}].oldText must not be empty in ${path}.`);
}

function getNotFoundError(path: string, editIndex: number, totalEdits: number): Error {
	if (totalEdits === 1) {
		return new Error(
			`Could not find the exact text in ${path}. The old text must match exactly including all whitespace and newlines.`,
		);
	}
	return new Error(
		`Could not find edits[${editIndex}] in ${path}. The oldText must match exactly including all whitespace and newlines.`,
	);
}

function getDuplicateError(path: string, editIndex: number, totalEdits: number, occurrences: number): Error {
	if (totalEdits === 1) {
		return new Error(
			`Found ${occurrences} occurrences of the text in ${path}. The text must be unique. Please provide more context to make it unique, or set replaceAll: true to replace every occurrence intentionally.`,
		);
	}
	return new Error(
		`Found ${occurrences} occurrences of edits[${editIndex}] in ${path}. Each oldText must be unique. Please provide more context to make it unique, or set replaceAll: true for that edit to replace every occurrence intentionally.`,
	);
}

function getNoChangeError(path: string, totalEdits: number): Error {
	if (totalEdits === 1) {
		return new Error(
			`No changes made to ${path}. The replacement produced identical content. This might indicate an issue with special characters or the text not existing as expected.`,
		);
	}
	return new Error(`No changes made to ${path}. The replacements produced identical content.`);
}

function getReplaceAllCombinationError(path: string): Error {
	return new Error(
		`replaceAll is only supported when exactly one edit is provided in ${path}. Split bulk replacements into a dedicated edit call.`,
	);
}

function isWordish(char: string | undefined): boolean {
	if (!char) return false;
	return WORDISH_RE.test(char);
}

function getPreviousNonWhitespace(text: string, index: number): string | undefined {
	for (let current = index - 1; current >= 0; current--) {
		const char = text[current];
		if (!/\s/u.test(char)) return char;
	}
	return undefined;
}

function shouldUseOpeningQuote(previous: string | undefined): boolean {
	if (previous === undefined) return true;
	if (/\s/u.test(previous)) return true;
	return OPENING_QUOTE_PREVIOUS_CHARS.includes(previous);
}

function convertStraightQuotesToCurly(text: string, options: { single: boolean; double: boolean }): string {
	let result = "";

	for (let index = 0; index < text.length; index++) {
		const char = text[index];
		if (char === '"' && options.double) {
			const previous = getPreviousNonWhitespace(text, index);
			result += shouldUseOpeningQuote(previous) ? "“" : "”";
			continue;
		}

		if (char === "'" && options.single) {
			const previous = text[index - 1];
			const next = text[index + 1];
			if (isWordish(previous) && isWordish(next)) {
				result += "’";
				continue;
			}

			const previousNonWhitespace = getPreviousNonWhitespace(text, index);
			result += shouldUseOpeningQuote(previousNonWhitespace) ? "‘" : "’";
			continue;
		}

		result += char;
	}

	return result;
}

export function preserveQuoteStyle(newText: string, oldText: string, matchedText: string): string {
	const preserveSingle = oldText.includes("'") && SPECIAL_SINGLE_QUOTES_PRESENCE_RE.test(matchedText);
	const preserveDouble = oldText.includes('"') && SPECIAL_DOUBLE_QUOTES_PRESENCE_RE.test(matchedText);
	if (!preserveSingle && !preserveDouble) return newText;
	return convertStraightQuotesToCurly(newText, { single: preserveSingle, double: preserveDouble });
}

function buildMatchedEdit(
	content: string,
	canonicalContent: CanonicalizedText,
	canonicalNeedleLength: number,
	matchIndex: number,
	editIndex: number,
	normalizedOldText: string,
	normalizedNewText: string,
	stage: EditMatchStage,
	replaceAll: boolean,
): MatchedEdit {
	const originalStart = canonicalContent.indexMap[matchIndex] ?? 0;
	const originalLastIndex = canonicalContent.indexMap[matchIndex + canonicalNeedleLength - 1];
	let originalEnd = originalLastIndex + 1;
	if (canonicalContent.trimTrailingWhitespace) {
		originalEnd = expandMatchEndToTrailingWhitespace(content, originalEnd);
	}

	const matchedText = content.slice(originalStart, originalEnd);
	const newText =
		stage === "normalize-special-characters"
			? preserveQuoteStyle(normalizedNewText, normalizedOldText, matchedText)
			: normalizedNewText;

	return {
		editIndex,
		matchIndex: originalStart,
		matchLength: originalEnd - originalStart,
		matchedText,
		newText,
		stage,
		replaceAll,
	};
}

function matchEditAgainstOriginal(
	content: string,
	edit: EditOverrideEdit,
	editIndex: number,
	totalEdits: number,
	path: string,
): MatchedEdit[] {
	const normalizedOldText = normalizeToLF(edit.oldText);
	const normalizedNewText = normalizeToLF(edit.newText);
	const replaceAll = edit.replaceAll === true;

	if (normalizedOldText.length === 0) {
		throw getEmptyOldTextError(path, editIndex, totalEdits);
	}

	const stages: EditMatchStage[] = ["exact", "trim-trailing-whitespace", "normalize-special-characters"];

	for (const stage of stages) {
		const canonicalContent = canonicalizeForStage(content, stage);
		const canonicalNeedle = canonicalizeForStage(normalizedOldText, stage).text;
		if (canonicalNeedle.length === 0) {
			continue;
		}
		const occurrences = findAllOccurrences(canonicalContent.text, canonicalNeedle);

		if (occurrences.length === 0) {
			continue;
		}

		if (!replaceAll && occurrences.length > 1) {
			throw getDuplicateError(path, editIndex, totalEdits, occurrences.length);
		}

		return occurrences.map((occurrence) =>
			buildMatchedEdit(
				content,
				canonicalContent,
				canonicalNeedle.length,
				occurrence,
				editIndex,
				normalizedOldText,
				normalizedNewText,
				stage,
				replaceAll,
			),
		);
	}

	throw getNotFoundError(path, editIndex, totalEdits);
}

export function applyEditOverrideToContent(
	content: string,
	edits: EditOverrideEdit[],
	path = "<content>",
): AppliedEditOverrideResult {
	if (edits.length > 1 && edits.some((edit) => edit.replaceAll === true)) {
		throw getReplaceAllCombinationError(path);
	}

	const normalizedContent = normalizeToLF(content);
	const matchedEdits = edits.flatMap((edit, editIndex) =>
		matchEditAgainstOriginal(normalizedContent, edit, editIndex, edits.length, path),
	);

	const sortedMatches = [...matchedEdits].sort((a, b) => a.matchIndex - b.matchIndex);
	for (let index = 1; index < sortedMatches.length; index++) {
		const previous = sortedMatches[index - 1];
		const current = sortedMatches[index];
		if (previous.matchIndex + previous.matchLength > current.matchIndex) {
			throw new Error(
				`edits[${previous.editIndex}] and edits[${current.editIndex}] overlap in ${path}. Merge them into one edit or target disjoint regions.`,
			);
		}
	}

	let newContent = normalizedContent;
	for (let index = sortedMatches.length - 1; index >= 0; index--) {
		const match = sortedMatches[index];
		newContent =
			newContent.slice(0, match.matchIndex) + match.newText + newContent.slice(match.matchIndex + match.matchLength);
	}

	if (newContent === normalizedContent) {
		throw getNoChangeError(path, edits.length);
	}

	const { diff, firstChangedLine } = generateUnifiedDiff(normalizedContent, newContent);
	return {
		newContent,
		diff,
		firstChangedLine,
		matchedEdits,
	};
}

export function applyEditOverrideToRawContent(
	rawContent: string,
	edits: EditOverrideEdit[],
	path = "<content>",
): AppliedEditOverrideResult & { rawNewContent: string; formatting: TextFormattingInfo } {
	const formatting = inspectTextFormatting(rawContent);
	const result = applyEditOverrideToContent(formatting.text, edits, path);
	return {
		...result,
		rawNewContent: restoreTextFormatting(result.newContent, formatting),
		formatting,
	};
}

interface DiffCursor {
	oldLineNum: number;
	newLineNum: number;
}

function toDiffLines(value: string): string[] {
	const lines = value.split("\n");
	if (lines[lines.length - 1] === "") {
		lines.pop();
	}
	return lines;
}

function pushChangeLines(
	output: string[],
	rawLines: string[],
	cursor: DiffCursor,
	lineNumWidth: number,
	kind: "added" | "removed",
): void {
	for (const line of rawLines) {
		if (kind === "added") {
			output.push(`+${String(cursor.newLineNum).padStart(lineNumWidth, " ")} ${line}`);
			cursor.newLineNum++;
		} else {
			output.push(`-${String(cursor.oldLineNum).padStart(lineNumWidth, " ")} ${line}`);
			cursor.oldLineNum++;
		}
	}
}

function pushContextLine(output: string[], line: string, cursor: DiffCursor, lineNumWidth: number): void {
	output.push(` ${String(cursor.oldLineNum).padStart(lineNumWidth, " ")} ${line}`);
	cursor.oldLineNum++;
	cursor.newLineNum++;
}

function pushEllipsis(output: string[], cursor: DiffCursor, lineNumWidth: number, skippedLines: number): void {
	if (skippedLines <= 0) return;
	output.push(` ${"".padStart(lineNumWidth, " ")} ...`);
	cursor.oldLineNum += skippedLines;
	cursor.newLineNum += skippedLines;
}

function renderBetweenChangesContext(
	output: string[],
	rawLines: string[],
	cursor: DiffCursor,
	lineNumWidth: number,
	contextLines: number,
): void {
	if (rawLines.length <= contextLines * 2) {
		for (const line of rawLines) {
			pushContextLine(output, line, cursor, lineNumWidth);
		}
		return;
	}

	const leadingLines = rawLines.slice(0, contextLines);
	const trailingLines = rawLines.slice(rawLines.length - contextLines);
	const skippedLines = rawLines.length - leadingLines.length - trailingLines.length;

	for (const line of leadingLines) {
		pushContextLine(output, line, cursor, lineNumWidth);
	}
	pushEllipsis(output, cursor, lineNumWidth, skippedLines);
	for (const line of trailingLines) {
		pushContextLine(output, line, cursor, lineNumWidth);
	}
}

function renderLeadingContext(
	output: string[],
	rawLines: string[],
	cursor: DiffCursor,
	lineNumWidth: number,
	contextLines: number,
): void {
	const shownLines = rawLines.slice(0, contextLines);
	for (const line of shownLines) {
		pushContextLine(output, line, cursor, lineNumWidth);
	}
	pushEllipsis(output, cursor, lineNumWidth, rawLines.length - shownLines.length);
}

function renderTrailingContext(
	output: string[],
	rawLines: string[],
	cursor: DiffCursor,
	lineNumWidth: number,
	contextLines: number,
): void {
	const skippedLines = Math.max(0, rawLines.length - contextLines);
	pushEllipsis(output, cursor, lineNumWidth, skippedLines);
	for (const line of rawLines.slice(skippedLines)) {
		pushContextLine(output, line, cursor, lineNumWidth);
	}
}

function renderContextBlock(
	output: string[],
	rawLines: string[],
	cursor: DiffCursor,
	lineNumWidth: number,
	contextLines: number,
	hasLeadingChange: boolean,
	hasTrailingChange: boolean,
): void {
	if (hasLeadingChange && hasTrailingChange) {
		renderBetweenChangesContext(output, rawLines, cursor, lineNumWidth, contextLines);
		return;
	}
	if (hasLeadingChange) {
		renderLeadingContext(output, rawLines, cursor, lineNumWidth, contextLines);
		return;
	}
	if (hasTrailingChange) {
		renderTrailingContext(output, rawLines, cursor, lineNumWidth, contextLines);
		return;
	}
	cursor.oldLineNum += rawLines.length;
	cursor.newLineNum += rawLines.length;
}

export function generateUnifiedDiff(
	oldContent: string,
	newContent: string,
	contextLines = 4,
): { diff: string; firstChangedLine?: number } {
	const parts = Diff.diffLines(oldContent, newContent);
	const output: string[] = [];
	const lineNumWidth = String(Math.max(oldContent.split("\n").length, newContent.split("\n").length)).length;
	const cursor: DiffCursor = { oldLineNum: 1, newLineNum: 1 };
	let lastWasChange = false;
	let firstChangedLine: number | undefined;

	for (const [index, part] of parts.entries()) {
		const rawLines = toDiffLines(part.value);
		if (part.added || part.removed) {
			firstChangedLine ??= cursor.newLineNum;
			pushChangeLines(output, rawLines, cursor, lineNumWidth, part.added ? "added" : "removed");
			lastWasChange = true;
			continue;
		}

		const nextPart = parts[index + 1];
		renderContextBlock(
			output,
			rawLines,
			cursor,
			lineNumWidth,
			contextLines,
			lastWasChange,
			Boolean(nextPart?.added || nextPart?.removed),
		);
		lastWasChange = false;
	}

	return { diff: output.join("\n"), firstChangedLine };
}
