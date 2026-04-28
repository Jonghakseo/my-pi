import {
	completeSimple,
	type Api,
	type Message,
	type Model,
	type ThinkingLevel as AiThinkingLevel,
	type UserMessage,
} from "@mariozechner/pi-ai";
import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { PromptSuggestLiteConfig, PromptSuggestLiteThinking } from "./config.ts";

interface CompletionResponseLike {
	content?: unknown;
	usage?: {
		input?: number;
		output?: number;
		cacheRead?: number;
		cacheWrite?: number;
		totalTokens?: number;
		cost?: { total?: number };
	};
}

type PiModel = Model<Api>;

type StreamSimpleLike = (
	model: PiModel,
	context: { systemPrompt: string; messages: Message[] },
	options: {
		apiKey?: string;
		headers?: Record<string, string>;
		reasoning?: AiThinkingLevel;
		sessionId?: string;
		onPayload?: (payload: unknown) => Promise<undefined>;
	},
) => { result(): Promise<CompletionResponseLike> };

type ModelRegistryLike = {
	getAll(): PiModel[];
	getApiKeyAndHeaders?: (
		model: PiModel,
	) => Promise<{ ok: true; apiKey?: string; headers?: Record<string, string> } | { ok: false; error: string }>;
	getApiKey?: (model: PiModel) => Promise<string | undefined>;
};

const CLAUDE_BRIDGE_STREAM_SIMPLE_KEY = Symbol.for("claude-bridge:activeStreamSimple");

function extractText(content: unknown): string {
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

function toReasoning(thinking: PromptSuggestLiteThinking): AiThinkingLevel | undefined {
	return thinking === "session-default" ? undefined : (thinking as AiThinkingLevel);
}

function resolveModelForCall(currentModel: PiModel, modelRef: string, allModels: PiModel[]): PiModel {
	const normalized = modelRef.trim();
	if (!normalized || normalized === "session-default") return currentModel;
	if (normalized.includes("/")) {
		const [provider, ...rest] = normalized.split("/");
		const id = rest.join("/");
		const exact = allModels.find((entry) => entry.provider === provider && entry.id === id);
		if (exact) return exact;
		throw new Error(`Configured prompt-suggest-lite model not found: ${normalized}`);
	}

	const candidates = allModels.filter((entry) => entry.id === normalized);
	if (candidates.length === 1) return candidates[0];
	if (candidates.length > 1) {
		throw new Error(
			`Configured prompt-suggest-lite model '${normalized}' is ambiguous. Use provider/id, e.g. ${candidates[0]?.provider}/${candidates[0]?.id}`,
		);
	}
	throw new Error(`Configured prompt-suggest-lite model not found: ${normalized}`);
}

async function resolveRequestAuth(
	model: PiModel,
	modelRegistry: ModelRegistryLike,
): Promise<{ apiKey?: string; headers?: Record<string, string> }> {
	if (typeof modelRegistry.getApiKeyAndHeaders === "function") {
		const auth = await modelRegistry.getApiKeyAndHeaders(model);
		if (!auth.ok) throw new Error(auth.error);
		return { apiKey: auth.apiKey, headers: auth.headers };
	}
	return { apiKey: await modelRegistry.getApiKey?.(model) };
}

function getClaudeBridgeStreamSimple(): StreamSimpleLike | undefined {
	const value = (globalThis as Record<symbol, unknown>)[CLAUDE_BRIDGE_STREAM_SIMPLE_KEY];
	return typeof value === "function" ? (value as StreamSimpleLike) : undefined;
}

async function invokeModel(
	model: PiModel,
	context: { systemPrompt: string; messages: Message[] },
	options: {
		apiKey?: string;
		headers?: Record<string, string>;
		reasoning?: AiThinkingLevel;
	},
): Promise<CompletionResponseLike> {
	const claudeBridgeStream = getClaudeBridgeStreamSimple();
	if (model.api === "claude-bridge" && claudeBridgeStream) {
		return await claudeBridgeStream(model, context, options).result();
	}
	return await completeSimple(model, context, options);
}

export async function generatePromptSuggestion(params: {
	ctx: ExtensionContext;
	config: PromptSuggestLiteConfig;
	prompt: string;
}): Promise<{ text: string; modelRef: string }> {
	const { ctx, config, prompt } = params;
	if (!ctx.model) throw new Error("No active model available for prompt-suggest-lite");
	const modelRegistry = ctx.modelRegistry as unknown as ModelRegistryLike;
	const model = resolveModelForCall(ctx.model, config.modelRef, modelRegistry.getAll());
	const { apiKey, headers } = await resolveRequestAuth(model, modelRegistry);
	const userMessage: UserMessage = {
		role: "user",
		content: [{ type: "text", text: prompt }],
		timestamp: Date.now(),
	};
	const response = await invokeModel(
		model,
		{
			systemPrompt:
				"You are the private lightweight prompt suggestion model for pi. Return only the next user prompt text requested by the user message.",
			messages: [userMessage],
		},
		{
			apiKey,
			headers,
			reasoning: toReasoning(config.thinking),
		},
	);
	return {
		text: extractText(response.content),
		modelRef: `${model.provider}/${model.id}`,
	};
}
