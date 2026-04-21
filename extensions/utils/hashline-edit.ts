/** biome-ignore-all lint/style/noNonNullAssertion: vendored hashline edit flow preserves upstream anchor assumptions. */
/** biome-ignore-all lint/complexity/noExcessiveCognitiveComplexity: vendored hashline edit flow keeps upstream validation and execute branches aligned with protocol semantics. */
/** biome-ignore-all lint/suspicious/noExplicitAny: theme bridge types intentionally accept Pi runtime token shapes. */
import { constants, readFileSync } from "node:fs";
import { access as fsAccess } from "node:fs/promises";
import { StringEnum } from "@mariozechner/pi-ai";
import type { ExtensionAPI, ToolDefinition } from "@mariozechner/pi-coding-agent";
import { withFileMutationQueue } from "@mariozechner/pi-coding-agent";
import type { Component } from "@mariozechner/pi-tui";
import { Container, Markdown, Spacer, Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import { applyExactUniqueLegacyReplace, extractLegacyTopLevelReplace } from "./edit-compat.ts";
import { renderEditSideBySide } from "./edit-side-by-side.ts";
import { loadFileKindAndText } from "./file-kind.ts";
import { writeFileAtomically } from "./fs-write.ts";
import {
	applyHashlineEdits,
	computeAffectedLineRanges,
	computeLegacyEditLineRange,
	formatHashlineRegion,
	getLeadingDisplayPrefixError,
	type HashlineToolEdit,
	resolveEditAnchors,
} from "./hashline.ts";
import { formatHashlineTextForDisplay } from "./hashline-display.ts";
import {
	buildCompactHashlineDiffPreview,
	detectLineEnding,
	generateDiffString,
	normalizeToLF,
	restoreLineEndings,
	stripBom,
} from "./hashline-edit-diff.ts";
import { resolveToCwd } from "./hashline-path-utils.ts";
import { formatHashlineReadPreview } from "./hashline-read.ts";
import { throwIfAborted } from "./runtime.ts";

const hashlineEditContentSchema = Type.Union([
	Type.String({ description: "literal file content (preferred format)" }),
	Type.Null(),
]);

const hashlineEditLinesSchema = Type.Union([
	Type.Array(Type.String(), { description: "legacy line-array content" }),
	Type.String({ description: "legacy string content" }),
	Type.Null(),
]);

const editAnchorRangeSchema = Type.Object(
	{
		start: Type.String({ description: "range start anchor" }),
		end: Type.Optional(Type.String({ description: "range end anchor" })),
	},
	{ additionalProperties: false },
);

const hashlineEditItemSchema = Type.Object(
	{
		op: StringEnum(["replace", "append", "prepend", "replace_text"] as const, {
			description: 'edit operation: "replace", "append", "prepend", or "replace_text"',
		}),
		pos: Type.Optional(Type.String({ description: "legacy anchor" })),
		end: Type.Optional(Type.String({ description: "legacy limit position" })),
		range: Type.Optional(editAnchorRangeSchema),
		content: Type.Optional(hashlineEditContentSchema),
		lines: Type.Optional(hashlineEditLinesSchema),
		oldText: Type.Optional(Type.String({ description: "exact text to replace" })),
		newText: Type.Optional(Type.String({ description: "replacement text" })),
	},
	{ additionalProperties: false },
);

const returnRangeSchema = Type.Object(
	{
		start: Type.Integer({ minimum: 1, description: "first post-edit line to return" }),
		end: Type.Optional(Type.Integer({ minimum: 1, description: "last post-edit line to return" })),
	},
	{ additionalProperties: false },
);

export const hashlineEditToolSchema = Type.Object(
	{
		path: Type.String({ description: "path" }),
		returnMode: Type.Optional(
			StringEnum(["changed", "ranges"] as const, {
				description: 'response mode: "changed" or "ranges"',
			}),
		),
		returnRanges: Type.Optional(
			Type.Array(returnRangeSchema, { description: "post-edit line ranges when returnMode is ranges" }),
		),
		edits: Type.Optional(Type.Array(hashlineEditItemSchema, { description: "edits over $path" })),
	},
	{ additionalProperties: false },
);

type ReturnRange = {
	start: number;
	end?: number;
};

type EditAnchorRange = {
	start: string;
	end?: string;
};

type ReturnedRangePreview = {
	start: number;
	end: number;
	text: string;
	nextOffset?: number;
	empty?: true;
};

type EditRequestParams = {
	path: string;
	returnMode?: "changed" | "ranges";
	returnRanges?: ReturnRange[];
	edits?: HashlineToolEdit[];
	oldText?: string;
	newText?: string;
	old_text?: string;
	new_text?: string;
};

type CompatibilityDetails = {
	used: true;
	strategy: "legacy-top-level-replace";
	matchCount: 1;
	fuzzyMatch?: true;
};

type HashlineEditToolDetails = {
	diff: string;
	firstChangedLine?: number;
	compatibility?: CompatibilityDetails;
	classification?: "noop";
	returnedRanges?: ReturnedRangePreview[];
	structureOutline?: string[];
};

const EDIT_DESC = readFileSync(new URL("../prompts/edit.md", import.meta.url), "utf-8").trim();

const EDIT_PROMPT_SNIPPET = readFileSync(new URL("../prompts/edit-snippet.md", import.meta.url), "utf-8").trim();

const ROOT_KEYS = new Set([
	"path",
	"returnMode",
	"returnRanges",
	"edits",
	"oldText",
	"newText",
	"old_text",
	"new_text",
]);
const ITEM_KEYS = new Set(["op", "pos", "end", "range", "content", "lines", "oldText", "newText"]);
const LEGACY_KEYS = ["oldText", "newText", "old_text", "new_text"] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOwn(request: Record<string, unknown>, key: string): boolean {
	return Object.hasOwn(request, key);
}

function isStringArray(value: unknown): value is string[] {
	return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function getVisibleLines(text: string): string[] {
	if (text.length === 0) {
		return [];
	}
	const lines = text.split("\n");
	return text.endsWith("\n") ? lines.slice(0, -1) : lines;
}

function withHiddenStringProperty(
	target: Record<string, unknown>,
	key: (typeof LEGACY_KEYS)[number],
	value: string,
): void {
	Object.defineProperty(target, key, {
		value,
		enumerable: false,
		configurable: true,
		writable: true,
	});
}

/**
 * Normalise raw tool-call arguments before validation and execution.
 *
 * In newer pi runtimes this is registered as `prepareArguments` so it runs
 * before schema validation, letting old-session payloads with top-level
 * `oldText/newText` continue to work without exposing those fields in the
 * public tool schema.
 *
 * The legacy fields are stored as non-enumerable properties so they pass
 * through `Object.keys()` and `JSON.stringify()` silently while still being
 * accessible to `assertEditRequest` and `extractLegacyTopLevelReplace`.
 */
export function prepareEditArguments(args: unknown): unknown {
	if (!isRecord(args)) {
		return args;
	}

	const hasAnyLegacyKey = LEGACY_KEYS.some((key) => hasOwn(args, key));
	if (!hasAnyLegacyKey) {
		return args;
	}

	const prepared: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(args)) {
		if (!LEGACY_KEYS.includes(key as (typeof LEGACY_KEYS)[number])) {
			prepared[key] = value;
		}
	}

	for (const legacyKey of LEGACY_KEYS) {
		if (!hasOwn(args, legacyKey)) continue;
		const value = args[legacyKey];
		if (typeof value === "string") {
			withHiddenStringProperty(prepared, legacyKey, value);
		} else {
			// Preserve non-string legacy values as non-enumerable so
			// assertEditRequest can reject them with a clear type error
			// instead of silently dropping them.
			Object.defineProperty(prepared, legacyKey, {
				value,
				enumerable: false,
				configurable: true,
				writable: true,
			});
		}
	}

	return prepared;
}

// Intentional overlap with the published TypeBox schema:
// - pi normally runs AJV validation before execute(), but that can be disabled in
//   environments without runtime code generation support.
// - some request rules here are cross-field semantics the top-level object schema does
//   not express cleanly, such as rejecting mixed camelCase/snake_case legacy keys.
export function assertEditRequest(request: unknown): asserts request is EditRequestParams {
	if (!isRecord(request)) {
		throw new Error("Edit request must be an object.");
	}

	const unknownRootKeys = Object.keys(request).filter((key) => !ROOT_KEYS.has(key));
	if (unknownRootKeys.length > 0) {
		throw new Error(`Edit request contains unknown or unsupported fields: ${unknownRootKeys.join(", ")}.`);
	}

	if (typeof request.path !== "string" || request.path.length === 0) {
		throw new Error('Edit request requires a non-empty "path" string.');
	}

	if (hasOwn(request, "edits") && !Array.isArray(request.edits)) {
		throw new Error('Edit request requires an "edits" array when provided.');
	}

	if (hasOwn(request, "returnMode")) {
		if (request.returnMode !== "changed" && request.returnMode !== "ranges") {
			throw new Error('Edit request field "returnMode" must be "changed" or "ranges" when provided.');
		}
	}

	if (hasOwn(request, "returnRanges")) {
		if (!Array.isArray(request.returnRanges) || request.returnRanges.length === 0) {
			throw new Error('Edit request field "returnRanges" must be a non-empty array when provided.');
		}
		for (const [index, range] of request.returnRanges.entries()) {
			if (!isRecord(range)) {
				throw new Error(`returnRanges[${index}] must be an object.`);
			}
			const start = range.start as number;
			if (!Number.isInteger(start) || start < 1) {
				throw new Error(`returnRanges[${index}].start must be a positive integer.`);
			}
			if (hasOwn(range, "end")) {
				if (!Number.isInteger(range.end) || (range.end as number) < 1) {
					throw new Error(`returnRanges[${index}].end must be a positive integer when provided.`);
				}
				if ((range.end as number) < start) {
					throw new Error(`returnRanges[${index}].end must be >= start.`);
				}
			}
		}
	}

	if (request.returnMode === "ranges") {
		if (!Array.isArray(request.returnRanges) || request.returnRanges.length === 0) {
			throw new Error('Edit request with returnMode "ranges" requires a non-empty "returnRanges" array.');
		}
	} else if (hasOwn(request, "returnRanges")) {
		throw new Error('Edit request field "returnRanges" is only supported when returnMode is "ranges".');
	}

	for (const legacyKey of LEGACY_KEYS) {
		if (hasOwn(request, legacyKey) && typeof request[legacyKey] !== "string") {
			throw new Error(`Edit request field "${legacyKey}" must be a string.`);
		}
	}

	const hasCamelLegacy = hasOwn(request, "oldText") || hasOwn(request, "newText");
	const hasSnakeLegacy = hasOwn(request, "old_text") || hasOwn(request, "new_text");
	if (hasCamelLegacy && hasSnakeLegacy) {
		throw new Error(
			"Edit request cannot mix legacy camelCase and snake_case fields. Use either oldText/newText or old_text/new_text.",
		);
	}

	const hasAnyLegacyKey = hasCamelLegacy || hasSnakeLegacy;
	const hasStructuredEdits = Array.isArray(request.edits) && request.edits.length > 0;
	if (hasAnyLegacyKey && !hasStructuredEdits) {
		const legacy = extractLegacyTopLevelReplace(request);
		if (!legacy) {
			throw new Error("Legacy top-level replace requires both oldText/newText or old_text/new_text.");
		}
	}

	if (!Array.isArray(request.edits)) {
		return;
	}

	for (const [index, edit] of request.edits.entries()) {
		if (!isRecord(edit)) {
			throw new Error(`Edit ${index} must be an object.`);
		}

		const unknownItemKeys = Object.keys(edit).filter((key) => !ITEM_KEYS.has(key));
		if (unknownItemKeys.length > 0) {
			throw new Error(`Edit ${index} contains unknown or unsupported fields: ${unknownItemKeys.join(", ")}.`);
		}

		if (typeof edit.op !== "string") {
			throw new Error(`Edit ${index} requires an "op" string.`);
		}
		if (edit.op !== "replace" && edit.op !== "append" && edit.op !== "prepend" && edit.op !== "replace_text") {
			throw new Error(
				`Edit ${index} uses unknown op "${edit.op}". Expected "replace", "append", "prepend", or "replace_text".`,
			);
		}

		if (hasOwn(edit, "pos") && typeof edit.pos !== "string") {
			throw new Error(`Edit ${index} field "pos" must be a string when provided.`);
		}
		if (hasOwn(edit, "end") && typeof edit.end !== "string") {
			throw new Error(`Edit ${index} field "end" must be a string when provided.`);
		}
		if (hasOwn(edit, "range")) {
			if (!isRecord(edit.range)) {
				throw new Error(`Edit ${index} field "range" must be an object when provided.`);
			}
			const range = edit.range as EditAnchorRange;
			if (typeof range.start !== "string" || range.start.length === 0) {
				throw new Error(`Edit ${index} field "range.start" must be a non-empty string.`);
			}
			if (hasOwn(range, "end") && typeof range.end !== "string") {
				throw new Error(`Edit ${index} field "range.end" must be a string when provided.`);
			}
		}
		if (hasOwn(edit, "content") && edit.content !== null && typeof edit.content !== "string") {
			throw new Error(`Edit ${index} field "content" must be a string or null when provided.`);
		}
		if (hasOwn(edit, "oldText") && typeof edit.oldText !== "string") {
			throw new Error(`Edit ${index} field "oldText" must be a string when provided.`);
		}
		if (hasOwn(edit, "newText") && typeof edit.newText !== "string") {
			throw new Error(`Edit ${index} field "newText" must be a string when provided.`);
		}
		if (hasOwn(edit, "lines") && edit.lines !== null && typeof edit.lines !== "string" && !isStringArray(edit.lines)) {
			throw new Error(`Edit ${index} field "lines" must be a string array, string, or null.`);
		}

		if (edit.op === "replace_text") {
			if (typeof edit.oldText !== "string" || typeof edit.newText !== "string") {
				throw new Error(`Edit ${index} with op "replace_text" requires string "oldText" and "newText" fields.`);
			}
			if (
				hasOwn(edit, "pos") ||
				hasOwn(edit, "end") ||
				hasOwn(edit, "range") ||
				hasOwn(edit, "content") ||
				hasOwn(edit, "lines")
			) {
				throw new Error(`Edit ${index} with op "replace_text" only supports "oldText" and "newText".`);
			}
			continue;
		}

		const hasContent = hasOwn(edit, "content");
		const hasLines = hasOwn(edit, "lines");
		if (hasContent && hasLines) {
			throw new Error(`Edit ${index} must use either "content" or legacy "lines", not both.`);
		}
		if (!hasContent && !hasLines) {
			throw new Error(`Edit ${index} requires a "content" field (or legacy "lines").`);
		}
		const editPayload = hasContent
			? ((edit.content as string | null) ?? null)
			: ((edit.lines as string[] | string | null) ?? null);
		const leadingPrefixError = getLeadingDisplayPrefixError(editPayload, hasContent ? "content" : "lines");
		if (leadingPrefixError) {
			throw new Error(`Edit ${index} ${leadingPrefixError}`);
		}

		if (hasOwn(edit, "oldText") || hasOwn(edit, "newText")) {
			throw new Error(`Edit ${index} with op "${edit.op}" does not support "oldText" or "newText".`);
		}

		if (edit.op === "replace") {
			const hasRange = hasOwn(edit, "range");
			const hasLegacyAnchors = hasOwn(edit, "pos") || hasOwn(edit, "end");
			if (hasRange && hasLegacyAnchors) {
				throw new Error(`Edit ${index} with op "replace" must use either "range" or legacy "pos"/"end", not both.`);
			}
			if (!hasRange && typeof edit.pos !== "string") {
				throw new Error(
					`Edit ${index} with op "replace" requires a "range.start" object or legacy "pos" anchor string.`,
				);
			}
			continue;
		}

		if (hasOwn(edit, "range")) {
			throw new Error(
				`Edit ${index} with op "${edit.op}" does not support "range". Use "pos" or omit it for file boundary insertion.`,
			);
		}

		if ((edit.op === "append" || edit.op === "prepend") && hasOwn(edit, "end")) {
			throw new Error(
				`Edit ${index} with op "${edit.op}" does not support "end". Use "pos" or omit it for file boundary insertion.`,
			);
		}
	}
}

type EditPreview = { diff: string; warnings?: string[] } | { error: string };
type EditRenderState = {
	argsKey?: string;
	preview?: EditPreview;
};

type DiffTheme = {
	fg: (color: any, text: string) => string;
	bg: (color: any, text: string) => string;
	bold: (text: string) => string;
};

function createEditDiffComponent(
	details: HashlineEditToolDetails,
	theme: DiffTheme,
	expanded: boolean,
	isPartial: boolean,
	options?: { showSummary?: boolean },
): Component {
	return new (class implements Component {
		constructor(
			private readonly diffDetails: HashlineEditToolDetails,
			private readonly renderTheme: DiffTheme,
			private readonly preview: boolean,
			private readonly rowLimit: number | undefined,
			private readonly showSummary: boolean,
		) {}

		render(width: number): string[] {
			const lines = renderEditSideBySide({
				diff: this.diffDetails.diff,
				width,
				theme: this.renderTheme,
				maxRows: this.rowLimit,
				isPreview: this.preview,
			});
			return this.showSummary ? lines : lines.slice(1);
		}

		invalidate(): void {}
	})(details, theme, isPartial || !expanded, expanded ? undefined : 5, options?.showSummary ?? true);
}

function getRenderablePreviewInput(args: unknown): EditRequestParams | null {
	if (!isRecord(args) || typeof args.path !== "string") {
		return null;
	}

	const request: EditRequestParams = { path: args.path };
	if (Array.isArray(args.edits)) {
		request.edits = args.edits as HashlineToolEdit[];
	}
	if (typeof args.oldText === "string") {
		request.oldText = args.oldText;
	}
	if (typeof args.newText === "string") {
		request.newText = args.newText;
	}
	if (typeof args.old_text === "string") {
		request.old_text = args.old_text;
	}
	if (typeof args.new_text === "string") {
		request.new_text = args.new_text;
	}

	const hasAnyEditPayload =
		request.edits !== undefined ||
		request.oldText !== undefined ||
		request.newText !== undefined ||
		request.old_text !== undefined ||
		request.new_text !== undefined;
	return hasAnyEditPayload ? request : null;
}

function formatPreviewSummary(diff: string, theme: { fg: (token: any, text: string) => string }): string {
	const preview = buildCompactHashlineDiffPreview(diff, { maxOutputLines: 0 });
	return [
		theme.fg("dim", "Pending changes:"),
		theme.fg("success", `+${preview.addedLines}`),
		theme.fg("dim", "/"),
		theme.fg("error", `-${preview.removedLines}`),
		theme.fg("warning", "(preview)"),
	].join(" ");
}

function formatPreviewWarnings(warnings: string[] | undefined): string | undefined {
	if (!warnings?.length) {
		return undefined;
	}
	return `Warnings:\n${warnings.join("\n")}`;
}

function getRenderedEditTextContent(result: { content?: Array<{ type: string; text?: string }> }): string | undefined {
	const textContent = result.content?.find(
		(entry): entry is { type: "text"; text: string } => entry.type === "text" && typeof entry.text === "string",
	);
	return textContent?.text;
}

function trimEdgeEmptyLines(lines: string[]): string[] {
	let start = 0;
	let end = lines.length;

	while (start < end && lines[start] === "") {
		start++;
	}
	while (end > start && lines[end - 1] === "") {
		end--;
	}

	return lines.slice(start, end);
}

function isRenderedEditSectionBoundary(line: string): boolean {
	return (
		line === "Diff preview:" ||
		line.startsWith("--- Updated anchors") ||
		line === "Warnings:" ||
		line === "Structure outline:" ||
		/^--- Range \d+ /.test(line)
	);
}

function formatRenderedEditResultMarkdown(
	text: string,
	options: { expanded: boolean; includeDiffPreview?: boolean; hideLeadingStatusSummary?: boolean },
): string {
	const lines = formatHashlineTextForDisplay(text).split("\n");
	const displayedLines = [...lines];
	if (options.hideLeadingStatusSummary && displayedLines[0]?.startsWith("Updated ")) {
		displayedLines.shift();
		if (displayedLines[0]?.startsWith("Changes:")) {
			displayedLines.shift();
		}
		while (displayedLines[0] === "") {
			displayedLines.shift();
		}
	}
	const maxLines = options.expanded ? 60 : 20;
	const shownLines = displayedLines.slice(0, maxLines);
	const sections: string[] = [];
	let plainLines: string[] = [];

	const flushPlainLines = () => {
		const trimmed = trimEdgeEmptyLines(plainLines);
		if (trimmed.length > 0) {
			sections.push(trimmed.join("\n"));
		}
		plainLines = [];
	};

	let index = 0;
	while (index < shownLines.length) {
		const line = shownLines[index]!;

		if (line === "Diff preview:") {
			flushPlainLines();
			index++;
			const bodyLines: string[] = [];
			while (index < shownLines.length && !isRenderedEditSectionBoundary(shownLines[index]!)) {
				bodyLines.push(shownLines[index]!);
				index++;
			}
			if (options.includeDiffPreview !== false) {
				sections.push(["#### Diff preview", "```diff", ...trimEdgeEmptyLines(bodyLines), "```"].join("\n"));
			}
			continue;
		}

		if (line.startsWith("--- Updated anchors")) {
			flushPlainLines();
			const title = line.replace(/^---\s*/, "").replace(/\s*---$/, "");
			index++;
			const bodyLines: string[] = [];
			while (index < shownLines.length && !isRenderedEditSectionBoundary(shownLines[index]!)) {
				bodyLines.push(shownLines[index]!);
				index++;
			}
			sections.push([`#### ${title}`, "```text", ...trimEdgeEmptyLines(bodyLines), "```"].join("\n"));
			continue;
		}

		plainLines.push(line);
		index++;
	}

	flushPlainLines();

	if (displayedLines.length > maxLines) {
		sections.push(`... ${displayedLines.length - maxLines} more result lines`);
	}

	return sections.join("\n\n");
}

function createRenderedEditMarkdownTheme(theme: {
	fg: (token: any, text: string) => string;
	bold: (text: string) => string;
	italic?: (text: string) => string;
	underline?: (text: string) => string;
	strikethrough?: (text: string) => string;
}) {
	return {
		heading: (text: string) => theme.fg("mdHeading", text),
		link: (text: string) => theme.fg("mdLink", text),
		linkUrl: (text: string) => theme.fg("mdLinkUrl", text),
		code: (text: string) => theme.fg("mdCode", text),
		codeBlock: (text: string) => theme.fg("mdCodeBlock", text),
		codeBlockBorder: (text: string) => theme.fg("mdCodeBlockBorder", text),
		quote: (text: string) => theme.fg("mdQuote", text),
		quoteBorder: (text: string) => theme.fg("mdQuoteBorder", text),
		hr: (text: string) => theme.fg("mdHr", text),
		listBullet: (text: string) => theme.fg("mdListBullet", text),
		bold: (text: string) => theme.bold(text),
		italic: (text: string) => (theme.italic ? theme.italic(text) : text),
		underline: (text: string) => (theme.underline ? theme.underline(text) : text),
		strikethrough: (text: string) => (theme.strikethrough ? theme.strikethrough(text) : text),
		highlightCode: (code: string, lang?: string) =>
			code.split("\n").map((line) => {
				if (lang === "diff") {
					if (line.startsWith("+") && !line.startsWith("+++")) {
						return theme.fg("toolDiffAdded", line);
					}
					if (line.startsWith("-") && !line.startsWith("---")) {
						return theme.fg("toolDiffRemoved", line);
					}
					return theme.fg("toolDiffContext", line);
				}

				return theme.fg("mdCodeBlock", line);
			}),
	};
}

function formatRequestedRangePreviews(
	text: string,
	ranges: ReturnRange[],
): { text: string; returnedRanges: ReturnedRangePreview[] } {
	const totalLines = getVisibleLines(text).length;
	const returnedRanges = ranges.map((range) => {
		const requestedEnd = range.end ?? range.start;
		const preview = formatHashlineReadPreview(text, {
			offset: range.start,
			limit: requestedEnd - range.start + 1,
		});
		const hasReturnedLines = /^\d+#/m.test(preview.text);
		const actualEnd = hasReturnedLines
			? preview.nextOffset !== undefined
				? preview.nextOffset - 1
				: Math.min(requestedEnd, totalLines)
			: requestedEnd;
		return {
			start: range.start,
			end: hasReturnedLines ? Math.max(range.start, actualEnd) : actualEnd,
			text: preview.text,
			...(preview.nextOffset !== undefined ? { nextOffset: preview.nextOffset } : {}),
			...(!hasReturnedLines ? { empty: true as const } : {}),
		};
	});

	const formatted = returnedRanges
		.map((range, index) => `--- Range ${index + 1} (lines ${range.start}-${range.end}) ---\n${range.text}`)
		.join("\n\n");

	return {
		text: formatted,
		returnedRanges,
	};
}

const STRUCTURE_MARKER_RE =
	/^(#{1,6}\s+.+|(export\s+)?(async\s+)?function\s+\w+|(export\s+)?class\s+\w+|(export\s+)?interface\s+\w+|(export\s+)?type\s+\w+|(export\s+)?enum\s+\w+|(const|let|var)\s+\w+\s*=\s*(async\s*)?\()/;

function truncateOutlineEntry(text: string, max = 88): string {
	return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

function collectOutlineEntries(previewText: string): string[] {
	const structural: string[] = [];
	const fallback: string[] = [];

	for (const line of previewText.split("\n")) {
		const match = line.match(/^(\d+)#[A-Z]{2}:(.*)$/);
		if (!match) {
			continue;
		}
		const lineNumber = match[1]!;
		const content = match[2]?.trim();
		if (content.length === 0) {
			continue;
		}
		const entry = `${lineNumber}: ${truncateOutlineEntry(content.replace(/\s+/g, " "))}`;
		if (STRUCTURE_MARKER_RE.test(content)) {
			structural.push(entry);
			continue;
		}
		if (fallback.length < 6) {
			fallback.push(entry);
		}
	}

	const entries = structural.length > 0 ? structural : fallback;
	return entries.slice(0, 8);
}

function buildStructureOutline(sections: Array<{ label?: string; previewText: string }>): {
	text: string;
	outline: string[];
} {
	const outlineLines = ["Structure outline:"];
	const detailOutline: string[] = [];
	const useSectionLabels = sections.length > 1;

	for (const section of sections) {
		const entries = collectOutlineEntries(section.previewText);
		if (useSectionLabels && section.label) {
			outlineLines.push(`- ${section.label}`);
		}

		if (entries.length === 0) {
			const fallback = "No structural markers found in returned content.";
			outlineLines.push(useSectionLabels ? `  - ${fallback}` : `- ${fallback}`);
			detailOutline.push(section.label ? `${section.label}: ${fallback}` : fallback);
			continue;
		}

		for (const entry of entries) {
			outlineLines.push(useSectionLabels ? `  - ${entry}` : `- ${entry}`);
			detailOutline.push(section.label ? `${section.label}: ${entry}` : entry);
		}
	}

	return {
		text: outlineLines.join("\n"),
		outline: detailOutline,
	};
}

function formatEditCall(
	args: EditRequestParams | undefined,
	state: EditRenderState,
	showPreviewSummary: boolean,
	theme: {
		bold: (text: string) => string;
		fg: (token: any, text: string) => string;
	},
): string {
	const path = args?.path;
	const pathDisplay =
		typeof path === "string" && path.length > 0 ? theme.fg("accent", path) : theme.fg("toolOutput", "...");
	let text = `${theme.fg("toolTitle", theme.bold("edit"))} ${pathDisplay}`;

	if (!state.preview) {
		return text;
	}

	if ("error" in state.preview) {
		text += `\n\n${theme.fg("error", formatHashlineTextForDisplay(state.preview.error))}`;
		return text;
	}

	if (showPreviewSummary && state.preview.diff) {
		text += `\n\n${formatPreviewSummary(state.preview.diff, theme)}`;
	}
	const previewWarnings = showPreviewSummary ? formatPreviewWarnings(state.preview.warnings) : undefined;
	if (previewWarnings) {
		text += `\n\n${theme.fg("warning", previewWarnings)}`;
	}
	return text;
}

function renderEditCallComponent(
	args: EditRequestParams | undefined,
	state: EditRenderState,
	theme: DiffTheme,
	context: { expanded: boolean; executionStarted?: boolean; lastComponent?: Component },
): Component {
	const preview = state.preview;
	const showPreviewBody = !!preview && !("error" in preview) && !!preview.diff && !context.executionStarted;
	const headerText = formatEditCall(args, state, !showPreviewBody, theme);
	if (!showPreviewBody || !preview || "error" in preview) {
		const text = context.lastComponent instanceof Text ? context.lastComponent : new Text("", 0, 0);
		text.setText(headerText);
		return text;
	}

	const container = context.lastComponent instanceof Container ? context.lastComponent : new Container();
	container.clear();
	container.addChild(new Text(headerText, 0, 0));
	container.addChild(new Spacer(1));
	container.addChild(
		createEditDiffComponent({ diff: preview.diff }, theme, context.expanded, true, { showSummary: true }),
	);
	const previewWarnings = formatPreviewWarnings(preview.warnings);
	if (previewWarnings) {
		container.addChild(new Spacer(1));
		container.addChild(new Text(theme.fg("warning", previewWarnings), 0, 0));
	}
	return container;
}

export async function computeEditPreview(request: unknown, cwd: string): Promise<EditPreview> {
	const preparedRequest = prepareEditArguments(request);
	try {
		assertEditRequest(preparedRequest);
	} catch (error: unknown) {
		return { error: error instanceof Error ? error.message : String(error) };
	}

	const params = preparedRequest as EditRequestParams;
	const path = params.path;
	const absolutePath = resolveToCwd(path, cwd);
	const toolEdits = Array.isArray(params.edits) ? params.edits : [];
	const legacy = extractLegacyTopLevelReplace(params as Record<string, unknown>);

	if (toolEdits.length === 0 && !legacy) {
		return { error: "No edits provided." };
	}

	try {
		await fsAccess(absolutePath, constants.R_OK);
	} catch (error: unknown) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code === "ENOENT") {
			return { error: `File not found: ${path}` };
		}
		if (code === "EACCES" || code === "EPERM") {
			return { error: `File is not readable: ${path}` };
		}
		return { error: `Cannot access file: ${path}` };
	}

	try {
		const file = await loadFileKindAndText(absolutePath);
		if (file.kind === "directory") {
			return { error: `Path is a directory: ${path}. Use ls to inspect directories.` };
		}
		if (file.kind === "image") {
			return {
				error: `Path is an image file: ${path}. Hashline edit only supports UTF-8 text files.`,
			};
		}
		if (file.kind === "binary") {
			return {
				error: `Path is a binary file: ${path} (${file.description}). Hashline edit only supports UTF-8 text files.`,
			};
		}

		const originalNormalized = normalizeToLF(stripBom(file.text).text);
		let result: string;
		let warnings: string[] | undefined;
		if (toolEdits.length > 0) {
			const resolved = resolveEditAnchors(toolEdits);
			const editResult = applyHashlineEdits(originalNormalized, resolved);
			result = editResult.content;
			warnings = editResult.warnings;
		} else {
			if (!legacy) return { error: "No edits provided." };
			result = applyExactUniqueLegacyReplace(
				originalNormalized,
				normalizeToLF(legacy.oldText),
				normalizeToLF(legacy.newText),
			).content;
		}

		if (originalNormalized === result) {
			return {
				error: `No changes made to ${path}. The edits produced identical content.`,
			};
		}

		return { diff: generateDiffString(originalNormalized, result).diff, ...(warnings ? { warnings } : {}) };
	} catch (error: unknown) {
		return { error: error instanceof Error ? error.message : String(error) };
	}
}

export function registerEditTool(pi: ExtensionAPI): void {
	const toolDefinition: ToolDefinition<typeof hashlineEditToolSchema, HashlineEditToolDetails, EditRenderState> = {
		name: "edit",
		label: "Edit",
		description: EDIT_DESC,
		parameters: hashlineEditToolSchema,
		prepareArguments: prepareEditArguments as ToolDefinition<
			typeof hashlineEditToolSchema,
			HashlineEditToolDetails,
			EditRenderState
		>["prepareArguments"],
		promptSnippet: EDIT_PROMPT_SNIPPET,
		renderShell: "self",
		renderCall(args, theme, context) {
			const previewInput = getRenderablePreviewInput(args);
			if (!context.argsComplete || !previewInput) {
				context.state.argsKey = undefined;
				context.state.preview = undefined;
			} else {
				const argsKey = JSON.stringify({ cwd: context.cwd, previewInput });
				if (context.state.argsKey !== argsKey) {
					context.state.argsKey = argsKey;
					context.state.preview = undefined;
					computeEditPreview(previewInput, context.cwd)
						.then((preview) => {
							if (context.state.argsKey === argsKey) {
								context.state.preview = preview;
								context.invalidate();
							}
						})
						.catch((err: unknown) => {
							if (context.state.argsKey === argsKey) {
								context.state.preview = {
									error: err instanceof Error ? err.message : String(err),
								};
								context.invalidate();
							}
						});
				}
			}
			return renderEditCallComponent(
				previewInput ?? undefined,
				context.state as EditRenderState,
				theme as DiffTheme,
				context,
			);
		},

		renderResult(result, { expanded, isPartial }, theme, context) {
			if (isPartial) {
				const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
				text.setText(theme.fg("warning", "Editing..."));
				return text;
			}

			const renderedText = getRenderedEditTextContent(result as { content?: Array<{ type: string; text?: string }> });
			if (!renderedText) {
				return new Text("", 0, 0);
			}

			if (context.isError) {
				const text = context.lastComponent instanceof Text ? context.lastComponent : new Text("", 0, 0);
				text.setText(`\n${theme.fg("error", formatHashlineTextForDisplay(renderedText))}`);
				return text;
			}

			const details = result.details as HashlineEditToolDetails | undefined;
			if (details?.diff) {
				const container = context.lastComponent instanceof Container ? context.lastComponent : new Container();
				container.clear();
				container.addChild(createEditDiffComponent(details, theme as DiffTheme, expanded, isPartial));
				const supplementaryMarkdownText = formatRenderedEditResultMarkdown(renderedText, {
					expanded,
					includeDiffPreview: false,
					hideLeadingStatusSummary: true,
				});
				if (supplementaryMarkdownText.trim().length > 0) {
					container.addChild(new Spacer(1));
					const markdown = new Markdown("", 0, 0, createRenderedEditMarkdownTheme(theme));
					markdown.setText(supplementaryMarkdownText);
					container.addChild(markdown);
				}
				return container;
			}

			const markdown =
				context.lastComponent instanceof Markdown
					? context.lastComponent
					: new Markdown("", 0, 0, createRenderedEditMarkdownTheme(theme));
			markdown.setText(formatRenderedEditResultMarkdown(renderedText, { expanded }));
			return markdown;
		},

		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			assertEditRequest(params);

			const normalizedParams = params as EditRequestParams;
			const path = normalizedParams.path;
			const absolutePath = resolveToCwd(path, ctx.cwd);
			const returnMode = normalizedParams.returnMode ?? "changed";
			const requestedReturnRanges = normalizedParams.returnRanges;
			const toolEdits = Array.isArray(normalizedParams.edits) ? (normalizedParams.edits as HashlineToolEdit[]) : [];
			const legacy = extractLegacyTopLevelReplace(normalizedParams as Record<string, unknown>);

			if (toolEdits.length === 0 && !legacy) {
				return {
					content: [{ type: "text", text: "No edits provided." }],
					isError: true,
					details: { diff: "", firstChangedLine: undefined },
				};
			}

			return withFileMutationQueue(absolutePath, async () => {
				throwIfAborted(signal);
				try {
					await fsAccess(absolutePath, constants.R_OK | constants.W_OK);
				} catch (error: unknown) {
					const code = (error as NodeJS.ErrnoException).code;
					if (code === "ENOENT") {
						throw new Error(`File not found: ${path}`);
					}
					if (code === "EACCES" || code === "EPERM") {
						throw new Error(`File is not writable: ${path}`);
					}
					throw new Error(`Cannot access file: ${path}`);
				}

				throwIfAborted(signal);
				const file = await loadFileKindAndText(absolutePath);
				if (file.kind === "directory") {
					throw new Error(`Path is a directory: ${path}. Use ls to inspect directories.`);
				}
				if (file.kind === "image") {
					throw new Error(`Path is an image file: ${path}. Hashline edit only supports UTF-8 text files.`);
				}
				if (file.kind === "binary") {
					throw new Error(
						`Path is a binary file: ${path} (${file.description}). Hashline edit only supports UTF-8 text files.`,
					);
				}

				throwIfAborted(signal);
				const { bom, text: content } = stripBom(file.text);
				const originalEnding = detectLineEnding(content);
				const originalNormalized = normalizeToLF(content);

				let result: string;
				let warnings: string[] | undefined;
				let noopEdits:
					| Array<{
							editIndex: number;
							loc: string;
							currentContent: string;
					  }>
					| undefined;
				let firstChangedLine: number | undefined;
				let compatibilityDetails: CompatibilityDetails | undefined;

				if (toolEdits.length > 0) {
					const resolved = resolveEditAnchors(toolEdits);
					const anchorResult = applyHashlineEdits(originalNormalized, resolved, signal);
					result = anchorResult.content;
					warnings = anchorResult.warnings;
					noopEdits = anchorResult.noopEdits;
					firstChangedLine = anchorResult.firstChangedLine;
				} else {
					if (!legacy) throw new Error("No edits provided.");
					const normalizedOldText = normalizeToLF(legacy.oldText);
					const normalizedNewText = normalizeToLF(legacy.newText);
					const replaced = applyExactUniqueLegacyReplace(originalNormalized, normalizedOldText, normalizedNewText);
					result = replaced.content;
					compatibilityDetails = {
						used: true,
						strategy: legacy.strategy,
						matchCount: replaced.matchCount,
						...(replaced.usedFuzzyMatch ? { fuzzyMatch: true } : {}),
					};
					const legacyRange = computeLegacyEditLineRange(originalNormalized, result);
					firstChangedLine = legacyRange?.firstChangedLine;
				}

				if (originalNormalized === result) {
					const noopDetails = noopEdits?.length
						? noopEdits
								.map(
									(edit) =>
										`Edit ${edit.editIndex}: replacement for ${edit.loc} is identical to current content:\n  ${edit.loc}: ${edit.currentContent}`,
								)
								.join("\n")
						: "The edits produced identical content.";
					const noopRangePreviews =
						returnMode === "ranges" && requestedReturnRanges
							? formatRequestedRangePreviews(originalNormalized, requestedReturnRanges)
							: undefined;
					const noopOutline = noopRangePreviews
						? buildStructureOutline(
								noopRangePreviews.returnedRanges.map((range, index) => ({
									label: `Range ${index + 1} (lines ${range.start}-${range.end})`,
									previewText: range.text,
								})),
							)
						: undefined;
					return {
						content: [
							{
								type: "text",
								text:
									returnMode === "ranges"
										? `No changes made to ${path}\nClassification: noop\n\n${noopOutline?.text}\n\nRequested range payloads are available in details.returnedRanges.`
										: `No changes made to ${path}\nClassification: noop\n${noopDetails}`,
							},
						],
						details: {
							diff: "",
							firstChangedLine: undefined,
							classification: "noop" as const,
							...(noopRangePreviews ? { returnedRanges: noopRangePreviews.returnedRanges } : {}),
							...(noopOutline ? { structureOutline: noopOutline.outline } : {}),
						},
					};
				}

				throwIfAborted(signal);
				await writeFileAtomically(absolutePath, bom + restoreLineEndings(result, originalEnding));

				const diffResult = generateDiffString(originalNormalized, result);

				if (returnMode === "ranges") {
					const rangePreviews = formatRequestedRangePreviews(result, requestedReturnRanges!);
					const outline = buildStructureOutline(
						rangePreviews.returnedRanges.map((range, index) => ({
							label: `Range ${index + 1} (lines ${range.start}-${range.end})`,
							previewText: range.text,
						})),
					);
					const warningsBlock = warnings?.length ? `\n\nWarnings:\n${warnings.join("\n")}` : "";
					return {
						content: [
							{
								type: "text",
								text: `Updated ${path}${warningsBlock}\n\n${outline.text}\n\nRequested range payloads are available in details.returnedRanges.`,
							},
						],
						details: {
							diff: diffResult.diff,
							firstChangedLine: firstChangedLine ?? diffResult.firstChangedLine,
							returnedRanges: rangePreviews.returnedRanges,
							structureOutline: outline.outline,
							...(compatibilityDetails ? { compatibility: compatibilityDetails } : {}),
						},
					};
				}

				const preview = buildCompactHashlineDiffPreview(diffResult.diff);
				const summaryLine = `Changes: +${preview.addedLines} -${preview.removedLines}${preview.preview ? "" : " (no textual diff preview)"}`;
				const previewBlock = preview.preview ? `\n\nDiff preview:\n${preview.preview}` : "";
				const warningsBlock = warnings?.length ? `\n\nWarnings:\n${warnings.join("\n")}` : "";

				const resultLines =
					result.length === 0 ? [] : result.endsWith("\n") ? result.split("\n").slice(0, -1) : result.split("\n");
				const anchorRanges = computeAffectedLineRanges({
					originalContent: originalNormalized,
					resultContent: result,
				});
				const anchorsBlock = anchorRanges
					? anchorRanges
							.map((anchorRange, index) => {
								const region = resultLines.slice(anchorRange.start - 1, anchorRange.end);
								const formatted = formatHashlineRegion(region, anchorRange.start);
								const rangeLabel =
									anchorRanges.length > 1
										? `region ${index + 1}/${anchorRanges.length}, lines ${anchorRange.start}-${anchorRange.end}`
										: `lines ${anchorRange.start}-${anchorRange.end}`;
								return `\n\n--- Updated anchors (${rangeLabel}; use these for subsequent edits in this region, or read for distant edits) ---\n${formatted}`;
							})
							.join("")
					: "";

				return {
					content: [
						{
							type: "text",
							text: `Updated ${path}\n${summaryLine}${previewBlock}${warningsBlock}${anchorsBlock}`,
						},
					],
					details: {
						diff: diffResult.diff,
						firstChangedLine: firstChangedLine ?? diffResult.firstChangedLine,
						...(compatibilityDetails ? { compatibility: compatibilityDetails } : {}),
					},
				};
			});
		},
	};

	pi.registerTool(toolDefinition);
}
