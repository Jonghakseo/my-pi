import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import * as fs from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import type { EditToolDetails, ExtensionAPI, ThemeColor } from "@mariozechner/pi-coding-agent";
import { withFileMutationQueue } from "@mariozechner/pi-coding-agent";
import type { Component } from "@mariozechner/pi-tui";
import { Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import { DYNAMIC_SCOPE_SENTINEL_END, DYNAMIC_SCOPE_SENTINEL_START } from "./dynamic-agents-md.ts";
import { applyEditOverrideToRawContent } from "./utils/edit-override.ts";
import { renderEditSideBySide } from "./utils/edit-side-by-side.ts";

const EDIT_TOOL_DESCRIPTION = [
	"Edit a single file using exact text replacement. Each edits[].oldText must match a unique, non-overlapping region of the original file.",
	"Use { path, edits: [{ oldText, newText, replaceAll?: true }] }.",
	"By default, every oldText must resolve to exactly one match. Set replaceAll: true on a single edit to intentionally replace every occurrence instead of requiring uniqueness.",
].join(" ");

const editParams = Type.Object(
	{
		path: Type.String({ description: "Path to the file to edit (relative or absolute)" }),
		edits: Type.Array(
			Type.Object({
				oldText: Type.String({ description: "Exact text for one targeted replacement." }),
				newText: Type.String({ description: "Replacement text for this targeted edit." }),
				replaceAll: Type.Optional(
					Type.Boolean({ description: "Replace all occurrences intentionally instead of requiring a unique match." }),
				),
			}),
			{ minItems: 1 },
		),
	},
	{ additionalProperties: true },
);

type EditInput = {
	path: string;
	edits: Array<{
		oldText: string;
		newText: string;
		replaceAll?: boolean;
	}>;
};

type EditExecute = (
	_toolCallId: string,
	params: unknown,
	signal?: AbortSignal,
	_onUpdate?: unknown,
	ctx?: { cwd: string },
) => Promise<{
	isError: boolean;
	content: Array<{ type: "text"; text: string }>;
	details: EditToolDetails | undefined;
}>;

type FileSnapshotSource = "read" | "write" | "edit";

type FileSnapshot = {
	hash: string;
	source: FileSnapshotSource;
};

type ToolTextContent = {
	type: string;
	text?: string;
};

type DiffBgColor = "toolSuccessBg" | "toolErrorBg";

type RenderTheme = {
	fg: (color: ThemeColor, text: string) => string;
	bg: (color: DiffBgColor, text: string) => string;
	bold: (text: string) => string;
};

let currentCwd = process.cwd();
const lastObservedFileStates = new Map<string, FileSnapshot>();

function shortenPath(filePath: string): string {
	if (!filePath) return filePath;

	if (path.isAbsolute(filePath)) {
		const relativeToCwd = path.relative(currentCwd, filePath);
		if (!relativeToCwd.startsWith("../..")) return relativeToCwd || ".";
	}

	const home = homedir();
	if (filePath.startsWith(home)) return `~${filePath.slice(home.length)}`;
	return filePath;
}

function resolveEditPath(cwd: string, filePath: string): string {
	return path.isAbsolute(filePath) ? filePath : path.resolve(cwd, filePath);
}

function successMessage(filePath: string, editCount: number): string {
	return `Updated ${filePath} with ${editCount} edit${editCount === 1 ? "" : "s"}.`;
}

function throwIfAborted(signal?: AbortSignal, aborted = signal?.aborted ?? false): void {
	if (aborted) {
		throw new Error("Operation aborted");
	}
}

function hashBuffer(buffer: Buffer): string {
	return createHash("sha256").update(buffer).digest("hex");
}

function setFileSnapshot(absolutePath: string, hash: string, source: FileSnapshotSource): void {
	lastObservedFileStates.set(absolutePath, { hash, source });
}

function setFileSnapshotFromText(absolutePath: string, text: string, source: FileSnapshotSource): void {
	setFileSnapshot(absolutePath, hashBuffer(Buffer.from(text, "utf8")), source);
}

function getTextContent(content: unknown): string | undefined {
	if (!Array.isArray(content)) return undefined;
	const textParts = content
		.filter((part): part is ToolTextContent => typeof part === "object" && part !== null && "type" in part)
		.filter((part) => part.type === "text" && typeof part.text === "string")
		.map((part) => part.text as string);
	if (textParts.length === 0) return undefined;
	return textParts.join("");
}

function getStaleReadError(displayPath: string, source: FileSnapshotSource): Error {
	const sourceDescription = source === "read" ? "last read" : `last ${source}`;
	return new Error(`File changed since its ${sourceDescription}. Re-read ${displayPath} before applying edits.`);
}

function hasReadTruncation(details: unknown): boolean {
	return Boolean(details && typeof details === "object" && "truncation" in details && details.truncation);
}

function stripTrailingDynamicScopeInjections(text: string): string {
	let stripped = text;

	while (stripped.endsWith(DYNAMIC_SCOPE_SENTINEL_END)) {
		const startIndex = stripped.lastIndexOf(`\n\n${DYNAMIC_SCOPE_SENTINEL_START}`);
		if (startIndex === -1) return stripped;
		const trailingBlock = stripped.slice(startIndex);
		if (!trailingBlock.endsWith(DYNAMIC_SCOPE_SENTINEL_END)) return stripped;
		stripped = stripped.slice(0, startIndex);
	}

	return stripped;
}

function isWholeFileReadInput(input: Record<string, unknown>): boolean {
	if (typeof input.path !== "string") return false;
	if (input.offset === undefined) return true;
	return input.offset === 1;
}

function hasReadContinuationHint(text: string): boolean {
	return /\n\n\[(?:Showing lines \d+-\d+ of \d+(?: \([^\]]+ limit\))?\. Use offset=\d+ to continue\.|\d+ more lines in file\. Use offset=\d+ to continue\.)\]$/.test(
		text,
	);
}

function shouldTrackReadSnapshot(input: Record<string, unknown>, details: unknown, text: string): boolean {
	if (!isWholeFileReadInput(input)) return false;
	if (hasReadTruncation(details)) return false;
	if (hasReadContinuationHint(text)) return false;
	return true;
}

function getReadSnapshotText(event: {
	input?: Record<string, unknown>;
	details?: unknown;
	content?: unknown;
}): string | undefined {
	if (!event.input) return undefined;
	const textContent = getTextContent(event.content);
	if (textContent === undefined) return undefined;
	const snapshotText = stripTrailingDynamicScopeInjections(textContent);
	if (!shouldTrackReadSnapshot(event.input, event.details, snapshotText)) return undefined;
	return snapshotText;
}

function getWriteSnapshotText(input: Record<string, unknown>): string | undefined {
	return typeof input.content === "string" ? input.content : undefined;
}

function createEditDiffComponent(
	details: EditToolDetails,
	theme: RenderTheme,
	expanded: boolean,
	isPartial: boolean,
): Component {
	return new (class implements Component {
		constructor(
			private readonly diffDetails: EditToolDetails,
			private readonly renderTheme: RenderTheme,
			private readonly preview: boolean,
			private readonly rowLimit?: number,
		) {}

		render(width: number): string[] {
			return renderEditSideBySide({
				diff: this.diffDetails.diff,
				width,
				theme: this.renderTheme,
				maxRows: this.rowLimit,
				isPreview: this.preview,
			});
		}

		invalidate(): void {}
	})(details, theme, isPartial || !expanded, expanded ? undefined : 5);
}

export function createEditExecute(): EditExecute {
	return async function execute(_toolCallId, params, signal, _onUpdate, ctx) {
		const { path: requestedPath, edits } = params as EditInput;
		const absolutePath = resolveEditPath(ctx?.cwd ?? process.cwd(), requestedPath);
		const cwd = ctx?.cwd ?? process.cwd();
		const displayPath = path.isAbsolute(requestedPath)
			? requestedPath
			: path.relative(cwd, absolutePath) || requestedPath;

		try {
			throwIfAborted(signal);
			return await withFileMutationQueue(absolutePath, async () => {
				let aborted = signal?.aborted ?? false;
				const onAbort = () => {
					aborted = true;
				};
				signal?.addEventListener("abort", onAbort, { once: true });

				try {
					throwIfAborted(signal, aborted);
					await fs.access(absolutePath, fsConstants.R_OK | fsConstants.W_OK);
					throwIfAborted(signal, aborted);

					const rawBuffer = await fs.readFile(absolutePath);
					const rawContent = rawBuffer.toString("utf8");
					const rawHash = hashBuffer(rawBuffer);
					throwIfAborted(signal, aborted);

					const lastObserved = lastObservedFileStates.get(absolutePath);
					if (lastObserved && lastObserved.hash !== rawHash) {
						throw getStaleReadError(displayPath, lastObserved.source);
					}

					const applied = applyEditOverrideToRawContent(rawContent, edits, displayPath);
					throwIfAborted(signal, aborted);

					const verificationBuffer = await fs.readFile(absolutePath);
					if (hashBuffer(verificationBuffer) !== rawHash) {
						throw new Error(`File changed while preparing edits. Re-read ${displayPath} and retry.`);
					}
					throwIfAborted(signal, aborted);

					await fs.writeFile(absolutePath, applied.rawNewContent, "utf8");
					setFileSnapshot(absolutePath, hashBuffer(Buffer.from(applied.rawNewContent, "utf8")), "edit");

					return {
						isError: false,
						content: [{ type: "text" as const, text: successMessage(displayPath, edits.length) }],
						details: {
							diff: applied.diff,
							firstChangedLine: applied.firstChangedLine,
						} satisfies EditToolDetails,
					};
				} finally {
					signal?.removeEventListener("abort", onAbort);
				}
			});
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			return {
				isError: true,
				content: [{ type: "text" as const, text: `Error editing ${displayPath}: ${message}` }],
				details: undefined,
			};
		}
	};
}

export default function editToolOverride(pi: ExtensionAPI) {
	pi.on("session_start", (_event, ctx) => {
		currentCwd = ctx.sessionManager.getCwd();
		lastObservedFileStates.clear();
	});
	pi.on("session_tree", (_event, ctx) => {
		currentCwd = ctx.sessionManager.getCwd();
	});
	pi.on("tool_result", async (event, ctx) => {
		if (event.isError) return;
		const input = event.input as Record<string, unknown>;
		if (typeof input.path !== "string") return;
		const absolutePath = resolveEditPath(ctx.cwd, input.path);

		if (event.toolName === "read") {
			const snapshotText = getReadSnapshotText({
				input,
				details: event.details,
				content: event.content,
			});
			if (snapshotText === undefined) return;
			setFileSnapshotFromText(absolutePath, snapshotText, "read");
			return;
		}

		if (event.toolName === "write") {
			const snapshotText = getWriteSnapshotText(input);
			if (snapshotText === undefined) {
				lastObservedFileStates.delete(absolutePath);
				return;
			}
			setFileSnapshotFromText(absolutePath, snapshotText, "write");
			return;
		}
	});

	pi.registerTool({
		name: "edit",
		label: "edit",
		description: EDIT_TOOL_DESCRIPTION,
		parameters: editParams,
		renderShell: "self",
		execute: createEditExecute(),
		renderCall(args, theme) {
			const filePath = typeof args.path === "string" ? args.path : "";
			const edits = Array.isArray(args.edits) ? args.edits.length : 0;
			const suffix = edits > 0 ? theme.fg("muted", ` (${edits} edit${edits === 1 ? "" : "s"})`) : "";
			return new Text(
				`${theme.fg("toolTitle", theme.bold("edit "))}${theme.fg("accent", shortenPath(filePath))}${suffix}`,
				0,
				0,
			);
		},
		renderResult(result, { expanded, isPartial }, theme) {
			const textPart = result.content.find((content) => content.type === "text");
			const text = textPart?.type === "text" ? textPart.text : "";
			if (isPartial) return new Text(theme.fg("warning", "Editing..."), 0, 0);
			if (text.startsWith("Error editing ")) {
				return new Text(theme.fg("error", text || "Edit failed"), 0, 0);
			}

			const details = result.details as EditToolDetails | undefined;
			if (!details?.diff) {
				return new Text(theme.fg("success", text || "Applied"), 0, 0);
			}

			return createEditDiffComponent(details, theme, expanded, isPartial);
		},
	});
}
