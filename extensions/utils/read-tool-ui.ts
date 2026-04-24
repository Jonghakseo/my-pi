import {
	createReadToolDefinition,
	type ExtensionAPI,
	type ReadToolDetails,
	type ReadToolInput,
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	formatSize,
} from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";

const PREVIEW_LINE_LIMIT = 10;
const BASE_READ_TOOL = createReadToolDefinition(process.cwd());

type ReadTextContent = {
	type: "text";
	text: string;
};

type ReadRenderTheme = {
	fg: (token: "dim" | "error" | "muted" | "toolOutput" | "warning", text: string) => string;
};

function trimTrailingEmptyLines(lines: string[]): string[] {
	let end = lines.length;
	while (end > 0 && lines[end - 1] === "") {
		end--;
	}
	return lines.slice(0, end);
}

function getRenderedReadTextContent(result: { content?: Array<{ type: string; text?: string }> }): string | undefined {
	const textContent = result.content?.find(
		(entry): entry is ReadTextContent => entry.type === "text" && typeof entry.text === "string",
	);
	return textContent?.text;
}

function formatTruncationWarning(details: ReadToolDetails | undefined, theme: ReadRenderTheme) {
	const truncation = details?.truncation;
	if (!truncation?.truncated) {
		return "";
	}

	if (truncation.firstLineExceedsLimit) {
		return `\n${theme.fg("warning", `[First line exceeds ${formatSize(truncation.maxBytes ?? DEFAULT_MAX_BYTES)} limit]`)}`;
	}

	if (truncation.truncatedBy === "lines") {
		return `\n${theme.fg("warning", `[Truncated: showing ${truncation.outputLines} of ${truncation.totalLines} lines (${truncation.maxLines ?? DEFAULT_MAX_LINES} line limit)]`)}`;
	}

	return `\n${theme.fg("warning", `[Truncated: ${truncation.outputLines} lines shown (${formatSize(truncation.maxBytes ?? DEFAULT_MAX_BYTES)} limit)]`)}`;
}

function formatPreviewBody(text: string, theme: ReadRenderTheme): string {
	const lines = trimTrailingEmptyLines(text.split("\n"));
	const previewLines = lines.slice(0, PREVIEW_LINE_LIMIT);
	const remaining = lines.length - previewLines.length;

	let rendered =
		previewLines.length > 0 ? `\n${previewLines.map((line) => theme.fg("toolOutput", line)).join("\n")}` : "";
	if (remaining > 0) {
		rendered += `\n${theme.fg("muted", `... (${remaining} more lines, expand keeps preview compact)`)}`;
	}
	return rendered;
}

function getReadDisplayName(rawPath: string): string {
	const normalized = rawPath.startsWith("@") ? rawPath.slice(1) : rawPath;
	const segments = normalized.split(/[\\/]+/).filter(Boolean);
	return segments.length > 0 ? segments[segments.length - 1] : normalized;
}

function getStartLine(args: ReadToolInput): number {
	if (typeof args.offset !== "number" || !Number.isFinite(args.offset)) {
		return 1;
	}

	const offset = Math.trunc(args.offset);
	return offset > 1 ? offset : 1;
}

function inferReadLineRange(args: ReadToolInput, renderedText: string, details: ReadToolDetails | undefined) {
	const explicitShowingRange = renderedText.match(/\[Showing lines (\d+)-(\d+) of \d+/);
	if (explicitShowingRange) {
		return { start: Number(explicitShowingRange[1]), end: Number(explicitShowingRange[2]) };
	}

	const firstLineExceedsLimit = renderedText.match(/^\[Line (\d+) is .+ exceeds /m);
	if (firstLineExceedsLimit) {
		const line = Number(firstLineExceedsLimit[1]);
		return { start: line, end: line };
	}

	const nextOffset = renderedText.match(/\[\d+ more lines in file\. Use offset=(\d+) to continue\.\]\s*$/);
	if (nextOffset) {
		return { start: getStartLine(args), end: Number(nextOffset[1]) - 1 };
	}

	const start = getStartLine(args);
	const truncation = details?.truncation;
	if (truncation?.firstLineExceedsLimit) {
		return { start, end: start };
	}
	if (truncation?.truncated && typeof truncation.outputLines === "number") {
		return { start, end: start + Math.max(1, truncation.outputLines) - 1 };
	}

	const outputLineCount = renderedText.split("\n").length;
	return { start, end: start + Math.max(1, outputLineCount) - 1 };
}

function formatReadRangeFooter(
	args: ReadToolInput | undefined,
	result: { content?: Array<{ type: string; text?: string }> },
	renderedText: string | undefined,
	details: ReadToolDetails | undefined,
	theme: ReadRenderTheme,
): string {
	if (
		args?.path === undefined ||
		renderedText === undefined ||
		result.content?.some((entry) => entry.type === "image")
	) {
		return "";
	}

	const range = inferReadLineRange(args, renderedText, details);
	return `\n${theme.fg("dim", `${getReadDisplayName(args.path)}:${range.start}-${range.end}`)}`;
}

export function registerReadTool(pi: ExtensionAPI): void {
	pi.registerTool({
		...BASE_READ_TOOL,
		renderResult(result, { expanded, isPartial }, theme, context) {
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			if (isPartial) {
				text.setText(theme.fg("warning", "Reading..."));
				return text;
			}

			const renderedText = getRenderedReadTextContent(result as { content?: Array<{ type: string; text?: string }> });
			if (context.isError) {
				text.setText(`\n${theme.fg("error", renderedText ?? "Read failed.")}`);
				return text;
			}

			if (!expanded) {
				text.setText("");
				return text;
			}

			const details = result.details as ReadToolDetails | undefined;
			text.setText(
				`${formatPreviewBody(renderedText ?? "", theme)}${formatTruncationWarning(details, theme)}${formatReadRangeFooter(context.args, result, renderedText, details, theme)}`,
			);
			return text;
		},
		async execute(toolCallId, params, signal, onUpdate, ctx) {
			const builtinTool = createReadToolDefinition(ctx.cwd);
			return builtinTool.execute(toolCallId, params, signal, onUpdate, ctx);
		},
	});
}
