import {
	createBashToolDefinition,
	type BashToolDetails,
	type ExtensionAPI,
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	formatSize,
	truncateTail,
	type Theme,
} from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";
import { Text, truncateToWidth, type Component } from "@mariozechner/pi-tui";
import { truncatePlainToWidth } from "../utils/format-utils.js";

const TAIL_LINES = 5;
const MAX_COMMAND_PREVIEW = 120;
const MIN_COMMAND_PREVIEW_WIDTH = 16;

type BashContent = { type: "text"; text: string };

function getBashTextContent(result: { content?: Array<{ type: string; text?: string }> }): string | undefined {
	const textContent = result.content?.find(
		(entry): entry is BashContent => entry.type === "text" && typeof entry.text === "string",
	);
	return textContent?.text;
}

function normalizeInlinePreview(value: string): string {
	return value.replace(/\r\n|\r|\n/g, " ");
}

class BashCallPreview implements Component {
	private readonly text = new Text("", 0, 0);

	constructor(
		private readonly header: string,
		private readonly command: string,
		private readonly theme: Theme,
	) {}

	render(width: number): string[] {
		const header = truncateToWidth(this.header, width, this.theme.fg("accent", "..."));
		const commandPreview = this.formatCommandPreview(width);
		this.text.setText(commandPreview ? `${header}\n${this.theme.fg("dim", commandPreview)}` : header);
		return this.text.render(width);
	}

	invalidate(): void {
		this.text.invalidate();
	}

	private formatCommandPreview(width: number): string {
		if (!this.command || width < MIN_COMMAND_PREVIEW_WIDTH) return "";
		return truncatePlainToWidth(normalizeInlinePreview(`$ ${this.command}`), Math.min(width, MAX_COMMAND_PREVIEW));
	}
}

function formatRunningDuration(ms: number): string {
	const seconds = Math.max(1, Math.ceil(ms / 1000));
	if (seconds < 60) return `${seconds}s`;

	const minutes = Math.floor(seconds / 60);
	const remainingSeconds = seconds % 60;
	if (minutes < 60) return remainingSeconds > 0 ? `${minutes}m ${remainingSeconds}s` : `${minutes}m`;

	const hours = Math.floor(minutes / 60);
	const remainingMinutes = minutes % 60;
	return remainingMinutes > 0 ? `${hours}h ${remainingMinutes}m` : `${hours}h`;
}

type RunningRenderState = {
	bashStartedAt?: number;
	bashTimer?: ReturnType<typeof setInterval>;
};

function clearRunningRenderTimer(state: RunningRenderState): void {
	if (state.bashTimer) {
		clearInterval(state.bashTimer);
		state.bashTimer = undefined;
	}
	state.bashStartedAt = undefined;
}

function formatTruncationWarning(
	details: BashToolDetails | undefined,
	theme: { fg: (color: "warning", text: string) => string },
): string {
	const truncation = details?.truncation;
	if (!truncation?.truncated) return "";

	if (truncation.firstLineExceedsLimit) {
		return `\n${theme.fg("warning", `[First line exceeds ${formatSize(truncation.maxBytes ?? DEFAULT_MAX_BYTES)} limit]`)}`;
	}

	if (truncation.truncatedBy === "lines") {
		return `\n${theme.fg("warning", `[Truncated: showing ${truncation.outputLines} of ${truncation.totalLines} lines (${truncation.maxLines ?? DEFAULT_MAX_LINES} line limit)]`)}`;
	}

	return `\n${theme.fg("warning", `[Truncated: ${truncation.outputLines} lines shown (${formatSize(truncation.maxBytes ?? DEFAULT_MAX_BYTES)} limit)]`)}`;
}

/**
 * Derive a short title from a bash command when the LLM doesn't provide one.
 * Takes the first command word and key flags/args.
 */
function deriveTitle(command: string): string {
	const trimmed = command.trim();
	if (!trimmed) return "명령어 실행";

	// Strip leading env vars (KEY=val ...) and common prefixes
	const withoutEnv = trimmed.replace(/^[A-Za-z_][A-Za-z0-9_]*=\S*\s*/, "");
	const withoutSudo = withoutEnv.replace(/^sudo\s+/, "");
	const withoutFlags = withoutSudo.replace(/^(?:!!\s*)?/, "");

	// Extract the first word (the command)
	const match = withoutFlags.match(/^\S+/);
	if (!match) return "명령어 실행";
	return match[0];
}

export default function bashToolOverride(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "bash",
		label: "Bash",
		description: `Execute a bash command. The command will be executed in the current working directory.

Title is a short one-sentence summary in Korean of what the command does, shown in the UI. Always write the title in Korean.

When running long-running commands, it is helpful to run a sleep command in the background first, and then check the output. This prevents the command from timing out.

To execute a command that doesn't need the user to see its output, prefix it with "!!". The command will still be executed, but its output will be excluded from the conversation context.`,
		parameters: Type.Object({
			command: Type.String({ description: "The bash command to execute" }),
			title: Type.String({
				description: "명령어가 수행하는 작업을 설명하는 짧은 한글 문장. 반드시 한국어로 작성할 것",
			}),
			timeout: Type.Optional(Type.Number({ description: "Optional timeout in milliseconds" })),
		}),
		promptSnippet: "Execute commands in a bash shell; use title to describe the command's purpose",
		promptGuidelines: [
			"Always provide a concise title for bash commands describing what the command accomplishes. Write the title in Korean (한글).",
		],
		prepareArguments(args: unknown): { command: string; title: string; timeout?: number } {
			if (!args || typeof args !== "object") return args as never;
			const a = args as Record<string, unknown>;
			const command = typeof a.command === "string" ? a.command : "";
			const title = typeof a.title === "string" && a.title.length > 0 ? a.title : deriveTitle(command);
			const timeout = typeof a.timeout === "number" ? a.timeout : undefined;

			return { command, title, ...(timeout !== undefined ? { timeout } : {}) };
		},
		renderCall(args, theme, _context) {
			const title = args.title as string | undefined;
			const command = args.command as string;
			const showTitle = typeof title === "string" && title.length > 0;

			const header = showTitle
				? `${theme.fg("toolTitle", theme.bold("bash"))} ${theme.fg("accent", title)}`
				: theme.fg("toolTitle", theme.bold("bash"));

			return new BashCallPreview(header, command, theme);
		},
		renderResult(result, { expanded, isPartial }, theme, context) {
			const runningState = context.state as RunningRenderState;
			if (isPartial) {
				runningState.bashStartedAt ??= Date.now();
				if (!runningState.bashTimer) {
					runningState.bashTimer = setInterval(() => context.invalidate(), 1000);
					runningState.bashTimer.unref?.();
				}
				return reuseText(
					context,
					theme.fg("warning", `~${formatRunningDuration(Date.now() - runningState.bashStartedAt)}`),
				);
			}

			clearRunningRenderTimer(runningState);
			const renderedText = getBashTextContent(result as { content?: Array<{ type: string; text?: string }> });
			const details = result.details as BashToolDetails | undefined;

			if (context.isError) {
				return renderError(context, expanded, renderedText, theme);
			}

			if (!expanded) {
				return reuseText(context, "");
			}

			return renderExpandedOutput(context, renderedText, details, theme);
		},
		async execute(toolCallId, params, signal, onUpdate, ctx) {
			const { title: _title, ...bashParams } = params as { command: string; title: string; timeout?: number };
			const builtinTool = createBashToolDefinition(ctx.cwd);
			return builtinTool.execute(toolCallId, bashParams, signal, onUpdate, ctx);
		},
	});
}

function reuseText(context: { lastComponent?: Component }, text: string): Text {
	const component = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
	component.setText(text);
	return component;
}

function renderError(
	context: { lastComponent?: Component; isError: boolean },
	expanded: boolean,
	renderedText: string | undefined,
	theme: Theme,
): Text {
	if (!expanded) {
		return reuseText(context, theme.fg("error", "✗ Error"));
	}
	return reuseText(context, theme.fg("error", renderedText ?? "Command failed."));
}

function renderExpandedOutput(
	context: { lastComponent?: Component },
	renderedText: string | undefined,
	details: BashToolDetails | undefined,
	theme: Theme,
): Text {
	if (!renderedText) {
		return reuseText(context, "");
	}

	const contextTruncation = truncateTail(renderedText, {
		maxLines: DEFAULT_MAX_LINES,
		maxBytes: DEFAULT_MAX_BYTES,
	});

	const allLines = contextTruncation.content ? contextTruncation.content.split("\n") : [];
	const tailLines = allLines.slice(-TAIL_LINES);
	const hiddenCount = allLines.length - tailLines.length;

	const body = tailLines.map((line: string) => theme.fg("muted", line)).join("\n");
	const truncationWarning = formatTruncationWarning(details, theme);

	const statusParts: string[] = [];
	if (hiddenCount > 0) {
		statusParts.push(theme.fg("dim", `... ${hiddenCount} more lines above`));
	}
	if (truncationWarning) {
		statusParts.push(truncationWarning.trim());
	}

	let outputText = body;
	if (statusParts.length > 0) {
		outputText += `\n${statusParts.join("\n")}`;
	}

	return reuseText(context, outputText);
}
