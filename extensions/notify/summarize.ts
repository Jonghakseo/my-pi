import { type Api, completeSimple, type Model } from "@mariozechner/pi-ai";
import { normalizeSingleSummary } from "./format.ts";
import { sanitizeNotificationText } from "./text.ts";

const NOTIFICATION_SUMMARY_PROMPT = [
	"You write production-style app notification bodies for coding work.",
	"Always answer in Korean.",
	"Return exactly one plain summary line.",
	"Do not repeat or restate the session title.",
	"Never output generic placeholders like Ready for input.",
	"Summarize only the single most important completed result.",
	"If multiple bullets or sentences exist, choose only one.",
	"No bullets, numbering, labels, quotes, emoji, or markdown.",
	"Keep it concise and natural.",
].join(" ");

export type NotificationSummaryModel = Model<Api>;
export type NotificationSummaryAuth =
	| { ok: true; apiKey?: string; headers?: Record<string, string> }
	| { ok: false; error: string };

export interface NotificationSummaryModelRegistry {
	getApiKeyAndHeaders(model: NotificationSummaryModel): Promise<NotificationSummaryAuth>;
}

function extractText(content: Array<{ type: string; text?: string }>): string {
	return content
		.filter((part) => part.type === "text" && typeof part.text === "string")
		.map((part) => part.text)
		.join("\n")
		.trim();
}

export async function resolveKoreanNotificationSummary(
	input: string,
	title: string | undefined,
	model: NotificationSummaryModel | undefined,
	modelRegistry: NotificationSummaryModelRegistry,
): Promise<string | undefined> {
	if (!sanitizeNotificationText(input) || !model) return undefined;
	const auth = await modelRegistry.getApiKeyAndHeaders(model);
	if (!auth.ok) return undefined;
	try {
		const message = await completeSimple(
			model,
			{
				systemPrompt: NOTIFICATION_SUMMARY_PROMPT,
				messages: [
					{
						role: "user",
						content: `Session title: ${title || "(none)"}\nAssistant result:\n${input}`,
						timestamp: Date.now(),
					},
				],
			},
			{
				apiKey: auth.apiKey,
				headers: auth.headers,
			},
		);
		if (message.stopReason === "error") return undefined;
		return normalizeSingleSummary(extractText(message.content));
	} catch {
		return undefined;
	}
}
