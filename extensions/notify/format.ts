import {
	cleanSummaryLine,
	extractSummaryCandidates,
	hasKoreanText,
	isGenericHeading,
	sanitizeNotificationText,
	stripLeadingTitle,
	stripMarkdownBlocks,
	stripSummaryLabel,
	truncateAtWord,
} from "./text.ts";

export type NotificationMessage = {
	role?: string;
	content?: string | Array<{ type?: string; text?: string }>;
};

const FALLBACK_TITLE = "π";
const MAX_BODY_LENGTH = 140;

export function extractAssistantText(messages: NotificationMessage[]): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i];
		if (message.role !== "assistant") continue;
		if (typeof message.content === "string") {
			if (message.content.trim()) return message.content.trim();
			continue;
		}
		if (!Array.isArray(message.content)) continue;
		const text = message.content
			.filter((p) => p.type === "text" && typeof p.text === "string")
			.map((p) => p.text)
			.join("\n")
			.trim();
		if (text) return text;
	}
	return "";
}

export function normalizeSingleSummary(text: string, maxLength = MAX_BODY_LENGTH): string | undefined {
	const lines = text
		.split(/\r?\n+/)
		.map(cleanSummaryLine)
		.filter(Boolean);
	if (!lines.length) return undefined;
	const candidates = extractSummaryCandidates(lines);
	if (!candidates.length) return undefined;
	const summary = sanitizeNotificationText(stripSummaryLabel(candidates[0]));
	return summary ? truncateAtWord(summary, maxLength) : undefined;
}

export function summarizeNotificationBody(text: string, maxLength = MAX_BODY_LENGTH): string {
	const lines = stripMarkdownBlocks(text)
		.split(/\r?\n+/)
		.map(cleanSummaryLine)
		.filter(Boolean);
	if (!lines.length) return "";
	const contentLines = lines.length > 1 && isGenericHeading(lines[0]) ? lines.slice(1) : lines;
	return normalizeSingleSummary(contentLines.join("\n"), maxLength) || "";
}

export function buildCompletionNotification(
	sessionName?: string,
	messages: NotificationMessage[] = [],
): { title: string; body: string } {
	const title = sanitizeNotificationText(sessionName || "") || FALLBACK_TITLE;
	const summary = stripLeadingTitle(summarizeNotificationBody(extractAssistantText(messages)), title);
	return {
		title,
		body: summary && hasKoreanText(summary) ? summary : "",
	};
}
