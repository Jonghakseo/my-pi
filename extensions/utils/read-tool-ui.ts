import {
	createReadToolDefinition,
	type ExtensionAPI,
	type ReadToolDetails,
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
	fg: (token: "error" | "muted" | "toolOutput" | "warning", text: string) => string;
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

			text.setText(
				`${formatPreviewBody(renderedText ?? "", theme)}${formatTruncationWarning(result.details as ReadToolDetails | undefined, theme)}`,
			);
			return text;
		},
		async execute(toolCallId, params, signal, onUpdate, ctx) {
			const builtinTool = createReadToolDefinition(ctx.cwd);
			return builtinTool.execute(toolCallId, params, signal, onUpdate, ctx);
		},
	});
}
