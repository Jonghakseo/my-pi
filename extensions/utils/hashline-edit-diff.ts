/** biome-ignore-all lint/style/noNonNullAssertion: vendored hashline diff logic preserves upstream index assumptions. */
/** biome-ignore-all lint/complexity/noExcessiveCognitiveComplexity: vendored hashline diff logic keeps upstream control flow for protocol parity. */
import * as Diff from "diff";
import {
	computeLineHash,
	FUZZY_DOUBLE_QUOTES_RE,
	FUZZY_HYPHENS_RE,
	FUZZY_SINGLE_QUOTES_RE,
	FUZZY_UNICODE_SPACES_RE,
} from "./hashline.ts";

// ─── Line ending normalization ──────────────────────────────────────────

export function detectLineEnding(content: string): "\r\n" | "\n" {
	const crlfIdx = content.indexOf("\r\n");
	const lfIdx = content.indexOf("\n");
	if (lfIdx === -1 || crlfIdx === -1) return "\n";
	return crlfIdx < lfIdx ? "\r\n" : "\n";
}

export function normalizeToLF(text: string): string {
	return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

export function restoreLineEndings(text: string, ending: "\r\n" | "\n"): string {
	return ending === "\r\n" ? text.replace(/\n/g, "\r\n") : text;
}

export function stripBom(content: string): { bom: string; text: string } {
	return content.startsWith("\uFEFF") ? { bom: "\uFEFF", text: content.slice(1) } : { bom: "", text: content };
}

// ─── Fuzzy text matching ────────────────────────────────────────────────

function normalizeFuzzyChar(ch: string): string {
	return ch
		.replace(FUZZY_SINGLE_QUOTES_RE, "'")
		.replace(FUZZY_DOUBLE_QUOTES_RE, '"')
		.replace(FUZZY_HYPHENS_RE, "-")
		.replace(FUZZY_UNICODE_SPACES_RE, " ");
}

function normalizeForFuzzyMatch(text: string): string {
	return text
		.split("\n")
		.map((line) => line.trimEnd())
		.join("\n")
		.replace(FUZZY_SINGLE_QUOTES_RE, "'")
		.replace(FUZZY_DOUBLE_QUOTES_RE, '"')
		.replace(FUZZY_HYPHENS_RE, "-")
		.replace(FUZZY_UNICODE_SPACES_RE, " ");
}

function buildNormalizedWithMap(text: string): {
	normalized: string;
	indexMap: number[];
} {
	const lines = text.split("\n");
	const normalizedChars: string[] = [];
	const indexMap: number[] = [];
	let originalOffset = 0;

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i]!;
		const trimmed = line.replace(/\s+$/u, "");

		for (let j = 0; j < trimmed.length; j++) {
			normalizedChars.push(normalizeFuzzyChar(trimmed[j]!));
			indexMap.push(originalOffset + j);
		}

		if (i < lines.length - 1) {
			normalizedChars.push("\n");
			indexMap.push(originalOffset + line.length);
		}

		originalOffset += line.length + 1;
	}

	return { normalized: normalizedChars.join(""), indexMap };
}

function mapNormalizedSpanToOriginal(
	indexMap: number[],
	normalizedStart: number,
	normalizedLength: number,
): { index: number; matchLength: number } | null {
	if (normalizedStart < 0 || normalizedLength <= 0) return null;
	const normalizedEnd = normalizedStart + normalizedLength;
	if (normalizedEnd > indexMap.length) return null;

	const start = indexMap[normalizedStart];
	const end = indexMap[normalizedEnd - 1];
	if (start === undefined || end === undefined || end < start) return null;

	return { index: start, matchLength: end - start + 1 };
}

/**
 * Find `oldText` in `content` with optional fuzzy whitespace/unicode matching.
 * Always returns an index/length in the original content.
 */
export function fuzzyFindText(
	content: string,
	oldText: string,
): {
	found: boolean;
	index: number;
	matchLength: number;
	usedFuzzyMatch: boolean;
} {
	const exactIndex = content.indexOf(oldText);
	if (exactIndex !== -1) {
		return {
			found: true,
			index: exactIndex,
			matchLength: oldText.length,
			usedFuzzyMatch: false,
		};
	}

	const normalizedNeedle = normalizeForFuzzyMatch(oldText);
	if (!normalizedNeedle.length) return { found: false, index: -1, matchLength: 0, usedFuzzyMatch: false };

	const { normalized, indexMap } = buildNormalizedWithMap(content);
	const normalizedIndex = normalized.indexOf(normalizedNeedle);
	if (normalizedIndex === -1) {
		return { found: false, index: -1, matchLength: 0, usedFuzzyMatch: false };
	}

	const mapped = mapNormalizedSpanToOriginal(indexMap, normalizedIndex, normalizedNeedle.length);
	if (!mapped) {
		return { found: false, index: -1, matchLength: 0, usedFuzzyMatch: false };
	}

	return {
		found: true,
		index: mapped.index,
		matchLength: mapped.matchLength,
		usedFuzzyMatch: true,
	};
}

/**
 * Replace `oldText` with `newText` in `content`.
 * Fuzzy matching only determines target spans; replacement always applies to
 * the original content (never normalizes the whole file).
 */
export function replaceText(
	content: string,
	oldText: string,
	newText: string,
	opts: { all?: boolean },
): { content: string; count: number } {
	if (!oldText.length) return { content, count: 0 };
	const normalizedNew = normalizeToLF(newText);

	if (opts.all) {
		const exactCount = content.split(oldText).length - 1;
		if (exactCount > 0) {
			return {
				content: content.split(oldText).join(normalizedNew),
				count: exactCount,
			};
		}

		const normalizedNeedle = normalizeForFuzzyMatch(oldText);
		if (!normalizedNeedle.length) return { content, count: 0 };

		const { normalized, indexMap } = buildNormalizedWithMap(content);
		const spans: Array<{ index: number; matchLength: number }> = [];
		let searchFrom = 0;

		while (searchFrom <= normalized.length - normalizedNeedle.length) {
			const pos = normalized.indexOf(normalizedNeedle, searchFrom);
			if (pos === -1) break;
			const mapped = mapNormalizedSpanToOriginal(indexMap, pos, normalizedNeedle.length);
			if (mapped) {
				const prev = spans[spans.length - 1];
				if (!prev || mapped.index >= prev.index + prev.matchLength) {
					spans.push(mapped);
				}
			}
			searchFrom = pos + Math.max(1, normalizedNeedle.length);
		}

		if (!spans.length) return { content, count: 0 };

		let out = content;
		for (let i = spans.length - 1; i >= 0; i--) {
			const span = spans[i]!;
			out = out.substring(0, span.index) + normalizedNew + out.substring(span.index + span.matchLength);
		}
		return { content: out, count: spans.length };
	}

	const result = fuzzyFindText(content, oldText);
	if (!result.found) return { content, count: 0 };

	return {
		content: content.substring(0, result.index) + normalizedNew + content.substring(result.index + result.matchLength),
		count: 1,
	};
}

// ─── Diff generation ────────────────────────────────────────────────────

function formatDiffPreviewLine(
	prefix: " " | "+" | "-",
	lineNum: number,
	lineNumWidth: number,
	line: string,
	includeHash: boolean,
): string {
	const paddedLineNum = String(lineNum).padStart(lineNumWidth, " ");
	if (!includeHash) {
		return `${prefix}${paddedLineNum}    ${line}`;
	}
	return `${prefix}${paddedLineNum}#${computeLineHash(lineNum, line)}:${line}`;
}

export function generateDiffString(
	oldContent: string,
	newContent: string,
	contextLines = 4,
): { diff: string; firstChangedLine: number | undefined } {
	const parts = Diff.diffLines(oldContent, newContent);
	const output: string[] = [];
	const maxLineNum = Math.max(oldContent.split("\n").length, newContent.split("\n").length);
	const lineNumWidth = String(maxLineNum).length;
	let oldLineNum = 1;
	let newLineNum = 1;
	let lastWasChange = false;
	let firstChangedLine: number | undefined;

	for (let i = 0; i < parts.length; i++) {
		const part = parts[i]!;
		const raw = part.value.split("\n");
		if (raw[raw.length - 1] === "") raw.pop();

		if (part.added || part.removed) {
			if (firstChangedLine === undefined) firstChangedLine = newLineNum;
			for (const line of raw) {
				if (part.added) {
					output.push(formatDiffPreviewLine("+", newLineNum, lineNumWidth, line, true));
					newLineNum++;
				} else {
					output.push(formatDiffPreviewLine("-", oldLineNum, lineNumWidth, line, false));
					oldLineNum++;
				}
			}
			lastWasChange = true;
			continue;
		}

		const nextPartIsChange = i < parts.length - 1 && (parts[i + 1]?.added || parts[i + 1]?.removed);
		if (lastWasChange || nextPartIsChange) {
			if (lastWasChange && nextPartIsChange) {
				if (raw.length <= contextLines * 2) {
					for (const line of raw) {
						output.push(formatDiffPreviewLine(" ", newLineNum, lineNumWidth, line, true));
						oldLineNum++;
						newLineNum++;
					}
				} else {
					const leading = raw.slice(0, contextLines);
					const trailing = raw.slice(-contextLines);
					for (const line of leading) {
						output.push(formatDiffPreviewLine(" ", newLineNum, lineNumWidth, line, true));
						oldLineNum++;
						newLineNum++;
					}
					output.push(` ${"".padStart(lineNumWidth, " ")} ...`);
					const omitted = raw.length - leading.length - trailing.length;
					oldLineNum += omitted;
					newLineNum += omitted;
					for (const line of trailing) {
						output.push(formatDiffPreviewLine(" ", newLineNum, lineNumWidth, line, true));
						oldLineNum++;
						newLineNum++;
					}
				}
			} else {
				let linesToShow = raw;
				let skipStart = 0;
				let skipEnd = 0;

				if (!lastWasChange) {
					skipStart = Math.max(0, raw.length - contextLines);
					linesToShow = raw.slice(skipStart);
				}
				if (!nextPartIsChange && linesToShow.length > contextLines) {
					skipEnd = linesToShow.length - contextLines;
					linesToShow = linesToShow.slice(0, contextLines);
				}

				if (skipStart > 0) {
					output.push(` ${"".padStart(lineNumWidth, " ")} ...`);
					oldLineNum += skipStart;
					newLineNum += skipStart;
				}
				for (const line of linesToShow) {
					output.push(formatDiffPreviewLine(" ", newLineNum, lineNumWidth, line, true));
					oldLineNum++;
					newLineNum++;
				}
				if (skipEnd > 0) {
					output.push(` ${"".padStart(lineNumWidth, " ")} ...`);
					oldLineNum += skipEnd;
					newLineNum += skipEnd;
				}
			}
		} else {
			oldLineNum += raw.length;
			newLineNum += raw.length;
		}

		lastWasChange = false;
	}

	return { diff: output.join("\n"), firstChangedLine };
}

export interface CompactHashlineDiffPreview {
	preview: string;
	addedLines: number;
	removedLines: number;
}

type DiffPreviewKind = "context" | "addition" | "deletion";

function classifyDiffPreviewLine(line: string): DiffPreviewKind | null {
	if (line.startsWith("+")) return "addition";
	if (line.startsWith("-")) return "deletion";
	if (line.startsWith(" ")) return "context";
	return null;
}

function summarizeOmitted(count: number, label: string): string {
	return `... ${count} more ${label} line${count === 1 ? "" : "s"}`;
}

function collapseDiffPreviewRun(lines: string[], maxVisible: number, label: string): string[] {
	if (lines.length <= maxVisible) {
		return lines;
	}

	return [...lines.slice(0, maxVisible), summarizeOmitted(lines.length - maxVisible, label)];
}

export function buildCompactHashlineDiffPreview(
	diff: string,
	options: {
		maxUnchangedRun?: number;
		maxAdditionRun?: number;
		maxDeletionRun?: number;
		maxOutputLines?: number;
	} = {},
): CompactHashlineDiffPreview {
	const { maxUnchangedRun = 2, maxAdditionRun = 4, maxDeletionRun = 4, maxOutputLines = 12 } = options;

	if (!diff.trim()) {
		return { preview: "", addedLines: 0, removedLines: 0 };
	}

	const lines = diff.split("\n").filter((line) => line.length > 0);
	const previewLines: string[] = [];
	let addedLines = 0;
	let removedLines = 0;

	for (let index = 0; index < lines.length; ) {
		const kind = classifyDiffPreviewLine(lines[index]!);
		let end = index + 1;
		while (end < lines.length && classifyDiffPreviewLine(lines[end]!) === kind) {
			end += 1;
		}

		const run = lines.slice(index, end);
		switch (kind) {
			case "addition":
				addedLines += run.length;
				previewLines.push(...collapseDiffPreviewRun(run, maxAdditionRun, "added"));
				break;
			case "deletion":
				removedLines += run.length;
				previewLines.push(...collapseDiffPreviewRun(run, maxDeletionRun, "removed"));
				break;
			case "context":
				previewLines.push(...collapseDiffPreviewRun(run, maxUnchangedRun, "unchanged"));
				break;
			default:
				previewLines.push(...run);
				break;
		}

		index = end;
	}

	if (previewLines.length > maxOutputLines) {
		const visibleLines = previewLines.slice(0, maxOutputLines);
		visibleLines.push(summarizeOmitted(previewLines.length - maxOutputLines, "preview"));
		return {
			preview: visibleLines.join("\n"),
			addedLines,
			removedLines,
		};
	}

	return {
		preview: previewLines.join("\n"),
		addedLines,
		removedLines,
	};
}
