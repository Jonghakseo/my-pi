import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAgentDir } from "@mariozechner/pi-coding-agent";

export type PromptSuggestLiteThinking = "session-default" | "minimal" | "low" | "medium" | "high" | "xhigh";
export type PromptSuggestLiteAcceptKey = "space" | "right";

export type PromptSuggestLiteConfig = {
	enabled: boolean;
	modelRef: string;
	thinking: PromptSuggestLiteThinking;
	customInstruction: string;
	noSuggestionToken: string;
	fastPathContinueOnError: boolean;
	maxSuggestionChars: number;
	maxAssistantTurnChars: number;
	maxRecentConversationMessages: number;
	maxRecentConversationMessageChars: number;
	maxRecentUserPrompts: number;
	maxRecentUserPromptChars: number;
	maxToolSignals: number;
	maxToolSignalChars: number;
	maxTouchedFiles: number;
	maxUnresolvedQuestions: number;
	acceptKeys: PromptSuggestLiteAcceptKey[];
	steeringHistoryWindow: number;
	logSteeringEvents: boolean;
};

export const promptSuggestLiteConfigPath = join(getAgentDir(), "prompt-suggest-lite.json");

export const defaultPromptSuggestLiteConfig: PromptSuggestLiteConfig = {
	enabled: true,
	modelRef: "session-default",
	thinking: "session-default",
	customInstruction: "",
	noSuggestionToken: "[no suggestion]",
	fastPathContinueOnError: true,
	maxSuggestionChars: 180,
	maxAssistantTurnChars: 12000,
	maxRecentConversationMessages: 4,
	maxRecentConversationMessageChars: 4000,
	maxRecentUserPrompts: 10,
	maxRecentUserPromptChars: 500,
	maxToolSignals: 8,
	maxToolSignalChars: 220,
	maxTouchedFiles: 8,
	maxUnresolvedQuestions: 6,
	acceptKeys: ["right"],
	steeringHistoryWindow: 20,
	logSteeringEvents: true,
};

const VALID_THINKING = new Set<PromptSuggestLiteThinking>([
	"session-default",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
]);
const VALID_ACCEPT_KEYS = new Set<PromptSuggestLiteAcceptKey>(["space", "right"]);

function numberWithDefault(value: unknown, fallback: number, min = 0): number {
	const coerced = Number(value);
	if (!Number.isFinite(coerced)) return fallback;
	return Math.max(min, Math.floor(coerced));
}

function stringWithDefault(value: unknown, fallback: string): string {
	return typeof value === "string" ? value : fallback;
}

function booleanWithDefault(value: unknown, fallback: boolean): boolean {
	return typeof value === "boolean" ? value : fallback;
}

export function normalizePromptSuggestLiteConfig(input: unknown): PromptSuggestLiteConfig {
	const raw = input && typeof input === "object" ? (input as Record<string, unknown>) : {};
	const defaults = defaultPromptSuggestLiteConfig;
	const thinking = stringWithDefault(raw.thinking, defaults.thinking) as PromptSuggestLiteThinking;
	const acceptKeys = Array.isArray(raw.acceptKeys)
		? raw.acceptKeys.filter((key): key is PromptSuggestLiteAcceptKey =>
				VALID_ACCEPT_KEYS.has(key as PromptSuggestLiteAcceptKey),
			)
		: defaults.acceptKeys;

	return {
		enabled: booleanWithDefault(raw.enabled, defaults.enabled),
		modelRef: stringWithDefault(raw.modelRef, defaults.modelRef).trim() || defaults.modelRef,
		thinking: VALID_THINKING.has(thinking) ? thinking : defaults.thinking,
		customInstruction: stringWithDefault(raw.customInstruction, defaults.customInstruction),
		noSuggestionToken:
			stringWithDefault(raw.noSuggestionToken, defaults.noSuggestionToken).trim() || defaults.noSuggestionToken,
		fastPathContinueOnError: booleanWithDefault(raw.fastPathContinueOnError, defaults.fastPathContinueOnError),
		maxSuggestionChars: numberWithDefault(raw.maxSuggestionChars, defaults.maxSuggestionChars, 20),
		maxAssistantTurnChars: numberWithDefault(raw.maxAssistantTurnChars, defaults.maxAssistantTurnChars, 100),
		maxRecentConversationMessages: numberWithDefault(
			raw.maxRecentConversationMessages,
			defaults.maxRecentConversationMessages,
			0,
		),
		maxRecentConversationMessageChars: numberWithDefault(
			raw.maxRecentConversationMessageChars,
			defaults.maxRecentConversationMessageChars,
			50,
		),
		maxRecentUserPrompts: numberWithDefault(raw.maxRecentUserPrompts, defaults.maxRecentUserPrompts, 0),
		maxRecentUserPromptChars: numberWithDefault(raw.maxRecentUserPromptChars, defaults.maxRecentUserPromptChars, 20),
		maxToolSignals: numberWithDefault(raw.maxToolSignals, defaults.maxToolSignals, 0),
		maxToolSignalChars: numberWithDefault(raw.maxToolSignalChars, defaults.maxToolSignalChars, 20),
		maxTouchedFiles: numberWithDefault(raw.maxTouchedFiles, defaults.maxTouchedFiles, 0),
		maxUnresolvedQuestions: numberWithDefault(raw.maxUnresolvedQuestions, defaults.maxUnresolvedQuestions, 0),
		acceptKeys: acceptKeys.length > 0 ? acceptKeys : defaults.acceptKeys,
		steeringHistoryWindow: numberWithDefault(raw.steeringHistoryWindow, defaults.steeringHistoryWindow, 0),
		logSteeringEvents: booleanWithDefault(raw.logSteeringEvents, defaults.logSteeringEvents),
	};
}

export function ensurePromptSuggestLiteConfigExists(): void {
	try {
		if (existsSync(promptSuggestLiteConfigPath)) return;
		mkdirSync(dirname(promptSuggestLiteConfigPath), { recursive: true });
		writeFileSync(promptSuggestLiteConfigPath, `${JSON.stringify(defaultPromptSuggestLiteConfig, null, 2)}\n`, "utf8");
	} catch {
		// Fall back to defaults when the config file cannot be created.
	}
}

export function loadPromptSuggestLiteConfig(): PromptSuggestLiteConfig {
	ensurePromptSuggestLiteConfigExists();
	try {
		if (!existsSync(promptSuggestLiteConfigPath)) return defaultPromptSuggestLiteConfig;
		return normalizePromptSuggestLiteConfig(JSON.parse(readFileSync(promptSuggestLiteConfigPath, "utf8")));
	} catch {
		return defaultPromptSuggestLiteConfig;
	}
}

export function savePromptSuggestLiteConfig(config: PromptSuggestLiteConfig): void {
	mkdirSync(dirname(promptSuggestLiteConfigPath), { recursive: true });
	writeFileSync(
		promptSuggestLiteConfigPath,
		`${JSON.stringify(normalizePromptSuggestLiteConfig(config), null, 2)}\n`,
		"utf8",
	);
}
