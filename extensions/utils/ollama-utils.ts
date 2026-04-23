/**
 * Shared Ollama provider utilities.
 *
 * `convertMessages` and `convertTools` transform the pi-ai message/tool
 * format into the Ollama native chat API shape.
 * `flattenTextContent` and `extractImages` are helper functions for
 * message content normalisation.
 *
 * Both `ollama-gemma4-26b.ts` and `ollama-glm-5-1-cloud.ts` share
 * identical implementations — they are consolidated here.
 */
import {
	calculateCost,
	createAssistantMessageEventStream,
	type Api,
	type AssistantMessage,
	type AssistantMessageEventStream,
	type Context,
	type ImageContent,
	type Model,
	type SimpleStreamOptions,
	type TextContent,
	type Tool,
} from "@mariozechner/pi-ai";

// ─── Message / content helpers ──────────────────────────────────────────────

export function flattenTextContent(content: string | (TextContent | ImageContent)[]): string {
	if (typeof content === "string") return content;
	return content
		.filter((item): item is TextContent => item.type === "text")
		.map((item) => item.text)
		.join("\n");
}

export function extractImages(content: string | (TextContent | ImageContent)[]): string[] | undefined {
	if (typeof content === "string") return undefined;
	const images = content.filter((item): item is ImageContent => item.type === "image").map((item) => item.data);
	return images.length > 0 ? images : undefined;
}

// ─── Ollama message format conversion ───────────────────────────────────────

export function convertMessages(context: Context): unknown[] {
	const messages: unknown[] = [];
	if (context.systemPrompt?.trim()) {
		messages.push({ role: "system", content: context.systemPrompt });
	}

	for (const message of context.messages) {
		if (message.role === "user") {
			messages.push({
				role: "user",
				content: flattenTextContent(message.content),
				images: extractImages(message.content),
			});
			continue;
		}

		if (message.role === "assistant") {
			const content = message.content
				.filter((block): block is TextContent => block.type === "text")
				.map((block) => block.text)
				.join("\n");
			const toolCalls = message.content
				.filter((block) => block.type === "toolCall")
				.map((block, index) => ({
					type: "function",
					function: {
						index,
						name: block.name,
						arguments: block.arguments,
					},
				}));
			messages.push({
				role: "assistant",
				content,
				...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
			});
			continue;
		}

		messages.push({
			role: "tool",
			tool_name: message.toolName,
			content: flattenTextContent(message.content),
		});
	}

	return messages;
}

export function convertTools(tools: Tool[] | undefined): unknown[] | undefined {
	if (!tools || tools.length === 0) return undefined;
	return tools.map((tool) => ({
		type: "function",
		function: {
			name: tool.name,
			description: tool.description,
			parameters: tool.parameters,
		},
	}));
}

// ─── Stream helpers ──────────────────────────────────────────────────────────

export function mapDoneReason(reason: unknown, hasToolCalls: boolean): "stop" | "length" | "toolUse" {
	if (hasToolCalls) return "toolUse";
	if (reason === "length" || reason === "max_tokens") return "length";
	return "stop";
}

export function createEmptyAssistantMessage(model: Model<Api>): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

/**
 * Stream an Ollama native chat request (non-streaming, single response).
 * Returns an `AssistantMessageEventStream` that the caller can subscribe to.
 *
 * @param url       The Ollama API endpoint (e.g. `${OLLAMA_BASE_URL}/api/chat`)
 * @param model     The model descriptor from pi-ai
 * @param context   The conversation context
 * @param options   Stream options (signal, etc.)
 * @param extra     Extra body fields to merge into the request payload
 */
export function streamOllamaNative(
	url: string,
	model: Model<Api>,
	context: Context,
	options?: SimpleStreamOptions,
	extra?: Record<string, unknown>,
): AssistantMessageEventStream {
	const stream = createAssistantMessageEventStream();

	(async () => {
		const output = createEmptyAssistantMessage(model);

		try {
			stream.push({ type: "start", partial: output });
			const response = await fetch(url, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					model: model.id,
					messages: convertMessages(context),
					tools: convertTools(context.tools),
					stream: false,
					...(extra ?? {}),
				}),
				signal: options?.signal,
			});

			if (!response.ok) {
				throw new Error(`Ollama chat failed: HTTP ${response.status}`);
			}

			const payload = (await response.json()) as {
				message?: {
					content?: string;
					thinking?: string;
					tool_calls?: Array<{
						type?: string;
						function?: { name?: string; arguments?: Record<string, unknown> };
					}>;
				};
				done_reason?: string;
				prompt_eval_count?: number;
				eval_count?: number;
			};

			output.usage.input = payload.prompt_eval_count ?? 0;
			output.usage.output = payload.eval_count ?? 0;
			output.usage.totalTokens = output.usage.input + output.usage.output;
			calculateCost(model, output.usage);

			const thinking = payload.message?.thinking?.trim();
			if (thinking) {
				output.content.push({ type: "thinking", thinking });
				const contentIndex = output.content.length - 1;
				stream.push({ type: "thinking_start", contentIndex, partial: output });
				stream.push({ type: "thinking_delta", contentIndex, delta: thinking, partial: output });
				stream.push({ type: "thinking_end", contentIndex, content: thinking, partial: output });
			}

			const content = payload.message?.content ?? "";
			if (content) {
				output.content.push({ type: "text", text: content });
				const contentIndex = output.content.length - 1;
				stream.push({ type: "text_start", contentIndex, partial: output });
				stream.push({ type: "text_delta", contentIndex, delta: content, partial: output });
				stream.push({ type: "text_end", contentIndex, content: content, partial: output });
			}

			const toolCalls = payload.message?.tool_calls ?? [];
			for (const toolCall of toolCalls) {
				const normalized = {
					type: "toolCall" as const,
					id: `${toolCall.function?.name ?? "tool"}-${output.content.length}`,
					name: toolCall.function?.name ?? "unknown",
					arguments: toolCall.function?.arguments ?? {},
				};
				output.content.push(normalized);
				const contentIndex = output.content.length - 1;
				stream.push({ type: "toolcall_start", contentIndex, partial: output });
				stream.push({
					type: "toolcall_delta",
					contentIndex,
					delta: JSON.stringify(normalized.arguments),
					partial: output,
				});
				stream.push({ type: "toolcall_end", contentIndex, toolCall: normalized, partial: output });
			}

			output.stopReason = mapDoneReason(payload.done_reason, toolCalls.length > 0);
			stream.push({ type: "done", reason: output.stopReason, message: output });
			stream.end();
		} catch (error) {
			output.stopReason = options?.signal?.aborted ? "aborted" : "error";
			output.errorMessage = error instanceof Error ? error.message : String(error);
			stream.push({ type: "error", reason: output.stopReason, error: output });
			stream.end();
		}
	})();

	return stream;
}
