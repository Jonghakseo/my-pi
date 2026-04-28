import type { PromptSuggestLiteConfig } from "./config.ts";
import type { PromptSuggestLiteTurnContext } from "./context.ts";
import type { PromptSuggestLiteSteeringEvent } from "./shared.ts";

function renderChangedExamples(examples: readonly PromptSuggestLiteSteeringEvent[]): string {
	const changed = examples
		.filter((event) => event.classification === "changed_course")
		.slice(-5)
		.reverse();
	if (changed.length === 0) return "RecentUserCorrections:\n(none)";
	return `RecentUserCorrections:\n${changed
		.map(
			(event) =>
				`- instead of ${JSON.stringify(event.suggestedPrompt)}\n  the user wrote: ${JSON.stringify(event.actualUserPrompt)}`,
		)
		.join("\n")}`;
}

function renderRecentConversationMessages(turn: PromptSuggestLiteTurnContext): string {
	if (turn.recentConversationMessages.length === 0) return "(none)";
	return turn.recentConversationMessages
		.map((message) => {
			const label = message.role === "user" ? "User" : "Assistant";
			return `${label}:\n${message.text}`;
		})
		.join("\n\n");
}

export function renderPromptSuggestLitePrompt(params: {
	turn: PromptSuggestLiteTurnContext;
	config: PromptSuggestLiteConfig;
	steeringHistory: readonly PromptSuggestLiteSteeringEvent[];
}): string {
	const { turn, config, steeringHistory } = params;
	return `Write the next message the user would most likely send in this pi coding-agent session.

Return only the user's message text.
Do not explain.
Do not wrap the result in quotes.
If no plausible next user message is clear, return exactly ${config.noSuggestionToken}.

Language/style:
- Match the user's recent language. If recent user messages are Korean, answer in Korean.
- Keep it concise, direct, and actionable.
- If the assistant proposed a good next step, a short approval such as "진행해줘.", "좋아, 계속해줘.", "Proceed.", or "Yes." is often best.
- Only add constraints/corrections when the recent conversation clearly needs them.

TurnStatus:
${turn.status}

AbortContext:
${turn.abortContextNote ?? "(none)"}

RecentConversationMessages:
${renderRecentConversationMessages(turn)}

RecentUserMessages:
${turn.recentUserPrompts.length > 0 ? turn.recentUserPrompts.map((prompt) => `- ${prompt}`).join("\n") : "(none)"}

ToolSignals:
${turn.toolSignals.length > 0 ? turn.toolSignals.map((signal) => `- ${signal}`).join("\n") : "(none)"}

TouchedFiles:
${turn.touchedFiles.length > 0 ? turn.touchedFiles.map((file) => `- ${file}`).join("\n") : "(none)"}

UnresolvedQuestions:
${turn.unresolvedQuestions.length > 0 ? turn.unresolvedQuestions.map((item) => `- ${item}`).join("\n") : "(none)"}

${renderChangedExamples(steeringHistory)}${
	config.customInstruction.trim() ? `\n\nAdditionalUserPreference:\n${config.customInstruction.trim()}` : ""
}

LatestAssistantMessage:
\`\`\`
${turn.assistantText || "(empty)"}
\`\`\`

Output constraints:
- One next user prompt only.
- Maximum ${config.maxSuggestionChars} characters.
- Prefer fewer characters when possible.`;
}

export function normalizeSuggestionText(value: string, config: PromptSuggestLiteConfig): string | undefined {
	const normalized = value
		.replace(/\r\n/g, "\n")
		.replace(/\r/g, "\n")
		.split("\n")
		.map((line) => line.trimEnd())
		.join("\n")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
	if (!normalized || normalized === config.noSuggestionToken) return undefined;
	return normalized.length > config.maxSuggestionChars
		? normalized.slice(0, config.maxSuggestionChars).trimEnd()
		: normalized;
}
