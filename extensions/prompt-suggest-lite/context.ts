import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { PromptSuggestLiteConfig } from "./config.ts";

export type PromptSuggestLiteTurnStatus = "success" | "error" | "aborted";

export type PromptSuggestLiteConversationMessage = {
	role: "user" | "assistant";
	text: string;
};

export type PromptSuggestLiteTurnContext = {
	turnId: string;
	assistantText: string;
	status: PromptSuggestLiteTurnStatus;
	recentConversationMessages: PromptSuggestLiteConversationMessage[];
	recentUserPrompts: string[];
	toolSignals: string[];
	touchedFiles: string[];
	unresolvedQuestions: string[];
	abortContextNote?: string;
};

export type BranchMessageEntry = {
	id: string;
	message: AgentMessage;
};

function truncate(value: string, maxChars: number): string {
	if (value.length <= maxChars) return value;
	return `${value.slice(0, maxChars)}…`;
}

function textFromContent(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((block) => {
			if (block && typeof block === "object" && "type" in block && (block as { type?: string }).type === "text") {
				return String((block as { text?: unknown }).text ?? "");
			}
			return "";
		})
		.join("\n")
		.trim();
}

function extractRecentUserPrompts(messages: AgentMessage[], config: PromptSuggestLiteConfig): string[] {
	return [...messages]
		.reverse()
		.filter((message) => message.role === "user")
		.map((message) => textFromContent((message as { content?: unknown }).content))
		.map((text) => text.trim())
		.filter(Boolean)
		.slice(0, config.maxRecentUserPrompts)
		.map((prompt) => truncate(prompt, config.maxRecentUserPromptChars));
}

function messageText(message: AgentMessage): string {
	return textFromContent((message as { content?: unknown }).content).trim();
}

function withLatestConversationMessage(
	messages: AgentMessage[],
	latestMessage: AgentMessage | undefined,
): AgentMessage[] {
	if (!latestMessage || (latestMessage.role !== "user" && latestMessage.role !== "assistant")) return messages;
	const lastMessage = messages.at(-1);
	if (lastMessage === latestMessage) return messages;
	if (lastMessage?.role === latestMessage.role && messageText(lastMessage) === messageText(latestMessage))
		return messages;
	return [...messages, latestMessage];
}

function extractRecentConversationMessages(
	messages: AgentMessage[],
	config: PromptSuggestLiteConfig,
): PromptSuggestLiteConversationMessage[] {
	return messages
		.filter((message) => message.role === "user" || message.role === "assistant")
		.map((message) => ({ role: message.role as "user" | "assistant", text: messageText(message) }))
		.filter((message) => message.text.length > 0)
		.slice(-config.maxRecentConversationMessages)
		.map((message) => ({
			role: message.role,
			text: truncate(message.text, config.maxRecentConversationMessageChars),
		}));
}

type ToolSignal = {
	signal: string;
	touchedFiles: string[];
};

function stringArg(args: Record<string, unknown>, key: string): string | undefined {
	const value = args[key];
	return typeof value === "string" ? value : undefined;
}

function extractToolCallSignal(block: unknown, config: PromptSuggestLiteConfig): ToolSignal | undefined {
	if (!block || typeof block !== "object") return undefined;
	if ((block as { type?: string }).type !== "toolCall") return undefined;
	const args = ((block as { arguments?: unknown }).arguments ?? {}) as Record<string, unknown>;
	const name = String((block as { name?: unknown }).name ?? "tool");
	const pathValue = stringArg(args, "path");
	const fileValue = stringArg(args, "file");
	const target = pathValue ?? fileValue ?? stringArg(args, "pattern") ?? stringArg(args, "command");
	return {
		signal: truncate(`${name}${target ? `(${target})` : ""}`, config.maxToolSignalChars),
		touchedFiles: [pathValue, fileValue]
			.filter((value): value is string => Boolean(value))
			.map((value) => value.replace(/^@/, "")),
	};
}

function assistantToolSignals(message: AgentMessage, config: PromptSuggestLiteConfig): ToolSignal[] {
	const content = (message as { content?: unknown }).content;
	if (message.role !== "assistant" || !Array.isArray(content)) return [];
	return content
		.map((block) => extractToolCallSignal(block, config))
		.filter((signal): signal is ToolSignal => signal !== undefined);
}

function toolResultSignal(message: AgentMessage): string | undefined {
	if (message.role !== "toolResult" || !(message as { isError?: unknown }).isError) return undefined;
	return `${String((message as { toolName?: unknown }).toolName ?? "tool")}:error`;
}

function extractToolSignals(
	messages: AgentMessage[],
	config: PromptSuggestLiteConfig,
): { toolSignals: string[]; touchedFiles: string[] } {
	const toolSignals: string[] = [];
	const touchedFiles = new Set<string>();

	for (const message of messages) {
		for (const toolSignal of assistantToolSignals(message, config)) {
			toolSignals.push(toolSignal.signal);
			for (const file of toolSignal.touchedFiles) touchedFiles.add(file);
		}
		const errorSignal = toolResultSignal(message);
		if (errorSignal) toolSignals.push(errorSignal);
	}

	return {
		toolSignals: toolSignals.slice(0, config.maxToolSignals),
		touchedFiles: Array.from(touchedFiles).slice(0, config.maxTouchedFiles),
	};
}

function extractUnresolvedQuestions(text: string, config: PromptSuggestLiteConfig): string[] {
	return text
		.split(/\n+/)
		.map((line) => line.trim())
		.filter((line) => line.endsWith("?") || line.endsWith("？"))
		.slice(0, config.maxUnresolvedQuestions);
}

function buildPlaceholderTurnContext(params: {
	turnId: string;
	messagesFromPrompt: AgentMessage[];
	branchMessages: AgentMessage[];
	config: PromptSuggestLiteConfig;
}): PromptSuggestLiteTurnContext | null {
	const lastMessage = params.messagesFromPrompt.at(-1);
	if (!lastMessage) return null;
	const { toolSignals, touchedFiles } = extractToolSignals(params.messagesFromPrompt, params.config);
	const conversationMessages = withLatestConversationMessage(params.branchMessages, lastMessage);
	const recentConversationMessages = extractRecentConversationMessages(conversationMessages, params.config);
	const recentUserPrompts = extractRecentUserPrompts(conversationMessages, params.config);

	if (lastMessage.role === "toolResult") {
		const isError = Boolean((lastMessage as { isError?: unknown }).isError);
		return {
			turnId: params.turnId,
			assistantText: isError ? "[error/toolcall]" : "[toolcall]",
			status: isError ? "error" : "success",
			recentConversationMessages,
			recentUserPrompts,
			toolSignals,
			touchedFiles,
			unresolvedQuestions: [],
		};
	}

	if (lastMessage.role === "assistant") return null;
	return {
		turnId: params.turnId,
		assistantText: "[empty]",
		status: "success",
		recentConversationMessages,
		recentUserPrompts,
		toolSignals,
		touchedFiles,
		unresolvedQuestions: [],
	};
}

export function buildTurnContext(params: {
	turnId: string;
	messagesFromPrompt: AgentMessage[];
	branchMessages: AgentMessage[];
	config: PromptSuggestLiteConfig;
}): PromptSuggestLiteTurnContext | null {
	const latestMessage = params.messagesFromPrompt.at(-1);
	if (!latestMessage) return null;
	if (latestMessage.role !== "assistant") return buildPlaceholderTurnContext(params);

	const assistantText = truncate(
		textFromContent((latestMessage as { content?: unknown }).content),
		params.config.maxAssistantTurnChars,
	);
	const stopReason = String((latestMessage as { stopReason?: unknown }).stopReason ?? "");
	const status: PromptSuggestLiteTurnStatus =
		stopReason === "error" ? "error" : stopReason === "aborted" ? "aborted" : "success";
	const { toolSignals, touchedFiles } = extractToolSignals(params.messagesFromPrompt, params.config);
	const conversationMessages = withLatestConversationMessage(params.branchMessages, latestMessage);
	return {
		turnId: params.turnId,
		assistantText,
		status,
		recentConversationMessages: extractRecentConversationMessages(conversationMessages, params.config),
		recentUserPrompts: extractRecentUserPrompts(conversationMessages, params.config),
		toolSignals,
		touchedFiles,
		unresolvedQuestions: extractUnresolvedQuestions(assistantText, params.config),
		abortContextNote:
			status === "aborted"
				? "The previous agent turn was aborted. The next prompt should intentionally resume, retry, or redirect."
				: undefined,
	};
}

export function buildAbortedFallbackTurn(params: {
	turnId: string;
	branchMessages: AgentMessage[];
	config: PromptSuggestLiteConfig;
}): PromptSuggestLiteTurnContext {
	return {
		turnId: params.turnId,
		assistantText: "[aborted]",
		status: "aborted",
		recentConversationMessages: extractRecentConversationMessages(params.branchMessages, params.config),
		recentUserPrompts: extractRecentUserPrompts(params.branchMessages, params.config),
		toolSignals: [],
		touchedFiles: [],
		unresolvedQuestions: [],
		abortContextNote:
			"The user explicitly aborted the previous agent turn. Suggest a concise next prompt that resumes intentionally or changes direction.",
	};
}

export function buildLatestHistoricalTurnContext(params: {
	branchEntries: BranchMessageEntry[];
	config: PromptSuggestLiteConfig;
}): PromptSuggestLiteTurnContext | null {
	let lastRelevantIndex = -1;
	for (let index = params.branchEntries.length - 1; index >= 0; index -= 1) {
		if (params.branchEntries[index]?.message.role !== "user") {
			lastRelevantIndex = index;
			break;
		}
	}
	if (lastRelevantIndex === -1) return null;

	let startIndex = 0;
	for (let index = lastRelevantIndex - 1; index >= 0; index -= 1) {
		if (params.branchEntries[index]?.message.role === "user") {
			startIndex = index + 1;
			break;
		}
	}

	const latestEntry = params.branchEntries[lastRelevantIndex];
	if (!latestEntry) return null;
	const branchMessages = params.branchEntries.map((entry) => entry.message);
	return buildTurnContext({
		turnId: latestEntry.id,
		messagesFromPrompt: branchMessages.slice(startIndex, lastRelevantIndex + 1),
		branchMessages,
		config: params.config,
	});
}
