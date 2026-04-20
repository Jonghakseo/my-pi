import { constants, readFileSync } from "node:fs";
import { access as fsAccess } from "node:fs/promises";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import {
	createReadToolDefinition,
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	formatSize,
	type TruncationResult,
	truncateHead,
} from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { loadFileKindAndText } from "./file-kind.ts";
import { computeLineHash } from "./hashline.ts";
import { normalizeToLF, stripBom } from "./hashline-edit-diff.ts";
import { resolveToCwd } from "./hashline-path-utils.ts";
import { throwIfAborted } from "./runtime.ts";
import { getFileSnapshot } from "./snapshot.ts";

const READ_DESC = readFileSync(new URL("../prompts/read.md", import.meta.url), "utf-8")
	.replaceAll("{{DEFAULT_MAX_LINES}}", String(DEFAULT_MAX_LINES))
	.replaceAll("{{DEFAULT_MAX_BYTES}}", formatSize(DEFAULT_MAX_BYTES))
	.trim();

const READ_PROMPT_SNIPPET = readFileSync(new URL("../prompts/read-snippet.md", import.meta.url), "utf-8").trim();

const READ_PROMPT_GUIDELINES = readFileSync(new URL("../prompts/read-guidelines.md", import.meta.url), "utf-8")
	.split("\n")
	.map((line) => line.trim())
	.filter((line) => line.startsWith("- "))
	.map((line) => line.slice(2));

function normalizePositiveInteger(value: number | undefined, name: "offset" | "limit"): number | undefined {
	if (value === undefined) {
		return undefined;
	}

	if (!Number.isInteger(value) || value < 1) {
		throw new Error(`Read request field "${name}" must be a positive integer.`);
	}

	return value;
}

function getPreviewLines(text: string): string[] {
	if (text.length === 0) {
		return [];
	}

	const lines = text.split("\n");
	return text.endsWith("\n") ? lines.slice(0, -1) : lines;
}

export function formatHashlineReadPreview(
	text: string,
	options: { offset?: number; limit?: number },
): { text: string; truncation?: TruncationResult; nextOffset?: number } {
	const allLines = getPreviewLines(text);
	const totalLines = allLines.length;
	const startLine = normalizePositiveInteger(options.offset, "offset") ?? 1;
	if (totalLines === 0) {
		if (startLine === 1) {
			return {
				text: "File is empty. Use edit with prepend or append and omit pos to insert content.",
			};
		}

		return {
			text: `Offset ${startLine} is beyond end of file (0 lines total). The file is empty. Use edit with prepend or append and omit pos to insert content.`,
		};
	}

	if (startLine > totalLines) {
		return {
			text: `Offset ${startLine} is beyond end of file (${totalLines} lines total). Use offset=1 to read from the start, or offset=${totalLines} to read the last line.`,
		};
	}

	const limit = normalizePositiveInteger(options.limit, "limit");
	const endIdx = limit ? Math.min(startLine - 1 + limit, totalLines) : totalLines;
	const selected = allLines.slice(startLine - 1, endIdx);
	const formatted = selected
		.map((line, index) => {
			const lineNumber = startLine + index;
			return `${lineNumber}#${computeLineHash(lineNumber, line)}:${line}`;
		})
		.join("\n");

	const truncation = truncateHead(formatted);
	if (truncation.firstLineExceedsLimit) {
		return {
			text: `[Line ${startLine} exceeds ${formatSize(truncation.maxBytes)}. Hashline output requires full lines; cannot compute hashes for a truncated preview.]`,
			truncation,
		};
	}

	let preview = truncation.content;
	let nextOffset: number | undefined;
	if (truncation.truncated) {
		const endLineDisplay = startLine + truncation.outputLines - 1;
		nextOffset = endLineDisplay + 1;
		if (truncation.truncatedBy === "lines") {
			preview += `\n\n[Showing lines ${startLine}-${endLineDisplay} of ${totalLines}. Use offset=${nextOffset} to continue.]`;
		} else {
			preview += `\n\n[Showing lines ${startLine}-${endLineDisplay} of ${totalLines} (${formatSize(truncation.maxBytes)} limit). Use offset=${nextOffset} to continue.]`;
		}
	} else if (endIdx < totalLines) {
		nextOffset = endIdx + 1;
		preview += `\n\n[Showing lines ${startLine}-${endIdx} of ${totalLines}. Use offset=${nextOffset} to continue.]`;
	}

	return {
		text: preview,
		truncation: truncation.truncated ? truncation : undefined,
		...(nextOffset !== undefined ? { nextOffset } : {}),
	};
}

export function registerReadTool(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "read",
		label: "Read",
		description: READ_DESC,
		promptSnippet: READ_PROMPT_SNIPPET,
		promptGuidelines: READ_PROMPT_GUIDELINES,
		parameters: Type.Object({
			path: Type.String({
				description: "Path to the file to read (relative or absolute)",
			}),
			offset: Type.Optional(
				Type.Integer({
					minimum: 1,
					description: "Line number to start reading from (1-indexed)",
				}),
			),
			limit: Type.Optional(
				Type.Integer({
					minimum: 1,
					description: "Maximum number of lines to read",
				}),
			),
		}),

		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const rawPath = params.path;
			const absolutePath = resolveToCwd(rawPath, ctx.cwd);

			throwIfAborted(signal);
			try {
				await fsAccess(absolutePath, constants.R_OK);
			} catch (error: unknown) {
				const code = error instanceof Error ? (error as NodeJS.ErrnoException).code : undefined;
				if (code === "ENOENT") {
					throw new Error(`File not found: ${rawPath}`);
				}
				if (code === "EACCES" || code === "EPERM") {
					throw new Error(`File is not readable: ${rawPath}`);
				}
				throw new Error(`Cannot access file: ${rawPath}`);
			}

			throwIfAborted(signal);
			const file = await loadFileKindAndText(absolutePath);
			if (file.kind === "directory") {
				throw new Error(`Path is a directory: ${rawPath}. Use ls to inspect directories.`);
			}

			if (file.kind === "binary") {
				throw new Error(
					`Path is a binary file: ${rawPath} (${file.description}). Hashline read only supports UTF-8 text files and supported images.`,
				);
			}

			if (file.kind === "image") {
				const builtinRead = createReadToolDefinition(ctx.cwd);
				return builtinRead.execute(_toolCallId, params, signal, _onUpdate, ctx);
			}

			throwIfAborted(signal);
			const normalized = normalizeToLF(stripBom(file.text).text);
			const preview = formatHashlineReadPreview(normalized, {
				offset: params.offset,
				limit: params.limit,
			});
			const snapshot = await getFileSnapshot(absolutePath);

			return {
				content: [{ type: "text", text: `${preview.text}\n\n[snapshotId: ${snapshot.snapshotId}]` }],
				details: {
					truncation: preview.truncation,
					snapshotId: snapshot.snapshotId,
					...(preview.nextOffset !== undefined ? { nextOffset: preview.nextOffset } : {}),
				},
			};
		},
	});
}
