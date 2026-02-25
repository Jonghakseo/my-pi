/**
 * Last Input Footer
 *
 * Shows the user's latest input in the footer status line.
 */

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";

const STATUS_KEY = "last-input-footer";
const LEGACY_WIDGET_KEY = "last-input-widget";
const LABEL = "📝";
const EMPTY_TEXT = "(아직 입력 없음)";

function extractUserText(message: any): string {
	const content = message?.content;

	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";

	const textBlocks = content
		.filter((block: any) => block?.type === "text" && typeof block.text === "string")
		.map((block: any) => block.text as string);

	if (textBlocks.length > 0) return textBlocks.join("\n");

	const imageCount = content.filter((block: any) => block?.type === "image").length;
	return imageCount > 0 ? `[image x${imageCount}]` : "";
}

function formatStatusText(inputText: string): string {
	const trimmed = inputText.trim();
	if (!trimmed) return `${LABEL} ${EMPTY_TEXT}`;

	const singleLine = trimmed.replace(/\s*\r?\n\s*/g, " ⏎ ");
	const maxChars = 90;
	const clipped = singleLine.length > maxChars ? `${singleLine.slice(0, maxChars - 1)}…` : singleLine;
	return `${LABEL} ${clipped}`;
}

function setFooterStatus(ctx: ExtensionContext, inputText: string) {
	if (!ctx.hasUI) return;
	ctx.ui.setStatus(STATUS_KEY, formatStatusText(inputText));

	// Clean up any previous widget rendering from older extension versions.
	ctx.ui.setWidget(LEGACY_WIDGET_KEY, undefined);
}

function readLastUserInputFromSession(ctx: ExtensionContext): string {
	const branch = ctx.sessionManager.getBranch();

	for (let i = branch.length - 1; i >= 0; i--) {
		const entry = branch[i] as any;
		if (entry.type !== "message") continue;
		if (entry.message?.role !== "user") continue;

		const text = extractUserText(entry.message);
		if (text) return text;
	}

	return "";
}

export default function (pi: ExtensionAPI) {
	let lastInput = "";

	const syncFromSession = (ctx: ExtensionContext) => {
		lastInput = readLastUserInputFromSession(ctx);
		setFooterStatus(ctx, lastInput);
	};

	pi.on("session_start", async (_event, ctx) => {
		syncFromSession(ctx);
	});

	pi.on("session_switch", async (_event, ctx) => {
		syncFromSession(ctx);
	});

	pi.on("session_fork", async (_event, ctx) => {
		syncFromSession(ctx);
	});

	pi.on("session_tree", async (_event, ctx) => {
		syncFromSession(ctx);
	});

	pi.on("input", async (event, ctx) => {
		if (event.source === "extension") {
			return { action: "continue" as const };
		}

		lastInput = event.text ?? "";
		setFooterStatus(ctx, lastInput);
		return { action: "continue" as const };
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		if (!ctx.hasUI) return;
		ctx.ui.setStatus(STATUS_KEY, undefined);
		ctx.ui.setWidget(LEGACY_WIDGET_KEY, undefined);
	});
}
