import { spawn } from "node:child_process";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
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

const PROVIDER_ID = "ollama-local";
const MODEL_ID = "gemma4:26b";
const MODEL_NAME = "Gemma 4 26B (Ollama Local)";
const OLLAMA_BASE_URL = "http://127.0.0.1:11434";
const OLLAMA_API = "ollama-native-chat";
const WARM_KEEP_ALIVE = "30m";
const WARM_TIMEOUT_MS = 10 * 60 * 1000;
const STARTUP_TIMEOUT_MS = 15 * 1000;
const THINK_TOKEN = "<|think|>";

type GemmaThinkMode = "on" | "off" | "light";

let bootPromise: Promise<void> | null = null;
let booted = false;
let thinkMode: GemmaThinkMode = "off";

function isTargetModel(ctx: ExtensionContext): boolean {
	return ctx.model?.provider === PROVIDER_ID && ctx.model?.id === MODEL_ID;
}

function stripThinkToken(systemPrompt: string): string {
	return systemPrompt.replace(new RegExp(`^\\s*${THINK_TOKEN}\\s*`), "").trimStart();
}

function applyThinkMode(systemPrompt: string, mode: GemmaThinkMode): string {
	const basePrompt = stripThinkToken(systemPrompt);
	if (mode === "on") {
		return `${THINK_TOKEN}\n${basePrompt}`;
	}
	if (mode === "light") {
		return `${basePrompt}\n\nGemma 4 thinking mode: keep reasoning minimal. Only think when necessary, keep it short, and prefer direct concise answers.`;
	}
	return `${basePrompt}\n\nGemma 4 thinking mode: answer directly without extended thinking. Keep responses concise and avoid exposing internal reasoning unless the runtime forces an empty thought block.`;
}

function parseThinkMode(raw: string): GemmaThinkMode | null {
	const normalized = raw.trim().toLowerCase();
	if (normalized === "on" || normalized === "off" || normalized === "light") return normalized;
	return null;
}

function notify(ctx: ExtensionContext, message: string, level: "info" | "warning" | "error" = "info") {
	if (!ctx.hasUI) return;
	ctx.ui.notify(message, level);
}

function flattenTextContent(content: string | (TextContent | ImageContent)[]): string {
	if (typeof content === "string") return content;
	return content
		.filter((item): item is TextContent => item.type === "text")
		.map((item) => item.text)
		.join("\n");
}

function extractImages(content: string | (TextContent | ImageContent)[]): string[] | undefined {
	if (typeof content === "string") return undefined;
	const images = content.filter((item): item is ImageContent => item.type === "image").map((item) => item.data);
	return images.length > 0 ? images : undefined;
}

function convertMessages(context: Context): unknown[] {
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

function convertTools(tools: Tool[] | undefined): unknown[] | undefined {
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

function mapThinkModeToFlag(mode: GemmaThinkMode): boolean {
	return mode !== "off";
}

function mapDoneReason(reason: unknown, hasToolCalls: boolean): "stop" | "length" | "toolUse" {
	if (hasToolCalls) return "toolUse";
	if (reason === "length" || reason === "max_tokens") return "length";
	return "stop";
}

function streamOllamaNative(
	model: Model<Api>,
	context: Context,
	options?: SimpleStreamOptions,
): AssistantMessageEventStream {
	const stream = createAssistantMessageEventStream();

	(async () => {
		const output: AssistantMessage = {
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

		try {
			stream.push({ type: "start", partial: output });
			const response = await fetch(`${OLLAMA_BASE_URL}/api/chat`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					model: model.id,
					messages: convertMessages(context),
					tools: convertTools(context.tools),
					stream: false,
					think: mapThinkModeToFlag(thinkMode),
					keep_alive: WARM_KEEP_ALIVE,
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
				stream.push({ type: "text_end", contentIndex, content, partial: output });
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

async function execOllama(
	pi: ExtensionAPI,
	args: string[],
	timeout = STARTUP_TIMEOUT_MS,
): Promise<{ ok: boolean; stdout: string; stderr: string }> {
	const result = await pi.exec("ollama", args, { timeout });
	return {
		ok: result.code === 0,
		stdout: result.stdout,
		stderr: result.stderr,
	};
}

function startOllamaServeDetached() {
	const child = spawn("ollama", ["serve"], {
		detached: true,
		stdio: "ignore",
	});
	child.unref();
}

async function waitForOllamaReady(timeoutMs: number): Promise<void> {
	const startedAt = Date.now();
	let lastError = "";
	while (Date.now() - startedAt < timeoutMs) {
		try {
			const res = await fetch(`${OLLAMA_BASE_URL}/api/version`);
			if (res.ok) return;
			lastError = `HTTP ${res.status}`;
		} catch (error) {
			lastError = error instanceof Error ? error.message : String(error);
		}
		await new Promise((resolve) => setTimeout(resolve, 500));
	}
	throw new Error(`Ollama server did not become ready in time (${lastError || "unknown error"})`);
}

async function ensureOllamaServer(pi: ExtensionAPI) {
	const versionCheck = await execOllama(pi, ["--version"]);
	if (!versionCheck.ok) {
		throw new Error(`ollama is not available: ${versionCheck.stderr || versionCheck.stdout}`);
	}

	try {
		await waitForOllamaReady(1000);
		return;
	} catch {
		startOllamaServeDetached();
		await waitForOllamaReady(STARTUP_TIMEOUT_MS);
	}
}

async function ensureModelPulled(pi: ExtensionAPI, ctx: ExtensionContext) {
	const show = await execOllama(pi, ["show", MODEL_ID], 30_000);
	if (show.ok) return;

	notify(ctx, `Pulling ${MODEL_ID}…`, "info");
	const pull = await execOllama(pi, ["pull", MODEL_ID], 60 * 60 * 1000);
	if (!pull.ok) {
		throw new Error(`failed to pull ${MODEL_ID}: ${pull.stderr || pull.stdout}`);
	}
}

async function warmModel(ctx: ExtensionContext) {
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), WARM_TIMEOUT_MS);
	try {
		const response = await fetch(`${OLLAMA_BASE_URL}/api/generate`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				model: MODEL_ID,
				prompt: "",
				stream: false,
				keep_alive: WARM_KEEP_ALIVE,
				options: {
					num_predict: 0,
				},
			}),
			signal: controller.signal,
		});
		if (!response.ok) {
			throw new Error(`warmup failed: HTTP ${response.status}`);
		}
		booted = true;
		notify(ctx, `${MODEL_NAME} is ready.`, "info");
	} finally {
		clearTimeout(timeout);
	}
}

async function ensureBooted(pi: ExtensionAPI, ctx: ExtensionContext) {
	if (!isTargetModel(ctx) || booted) return;
	if (bootPromise) return bootPromise;

	bootPromise = (async () => {
		notify(ctx, `Booting ${MODEL_NAME} lazily…`, "info");
		await ensureOllamaServer(pi);
		await ensureModelPulled(pi, ctx);
		await warmModel(ctx);
	})()
		.catch((error) => {
			booted = false;
			throw error;
		})
		.finally(() => {
			bootPromise = null;
		});

	return bootPromise;
}

export default function (pi: ExtensionAPI) {
	pi.registerProvider(PROVIDER_ID, {
		baseUrl: OLLAMA_BASE_URL,
		api: OLLAMA_API,
		apiKey: "ollama",
		streamSimple: streamOllamaNative,
		models: [
			{
				id: MODEL_ID,
				name: MODEL_NAME,
				reasoning: true,
				input: ["text", "image"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 262144,
				maxTokens: 16384,
			},
		],
	});

	pi.on("model_select", async (_event, ctx) => {
		if (!isTargetModel(ctx)) return;
		try {
			await ensureBooted(pi, ctx);
		} catch (error) {
			notify(ctx, error instanceof Error ? error.message : String(error), "error");
		}
	});

	pi.on("before_agent_start", async (event, ctx) => {
		if (!isTargetModel(ctx)) return;
		await ensureBooted(pi, ctx);
		return {
			systemPrompt: applyThinkMode(event.systemPrompt, thinkMode),
		};
	});

	pi.registerCommand("gemma-think", {
		description: "Control Gemma 4 26B thinking mode: /gemma-think on|off|light",
		handler: async (args: string, ctx: ExtensionContext) => {
			const mode = parseThinkMode(args);
			if (!mode) {
				notify(ctx, `Usage: /gemma-think on|off|light (current: ${thinkMode})`, "info");
				return;
			}
			thinkMode = mode;
			notify(ctx, `Gemma think mode: ${thinkMode}`, "info");
		},
	});

	pi.registerCommand("ollama-gemma4-status", {
		description: "Show Ollama Gemma 4 26B local provider status",
		handler: async (_args: string, ctx: ExtensionContext) => {
			const version = await execOllama(pi, ["--version"]);
			const list = await execOllama(pi, ["list"], 30_000);
			const ps = await execOllama(pi, ["ps"], 30_000);
			const lines = [
				`provider: ${PROVIDER_ID}`,
				`model: ${MODEL_ID}`,
				`thinkMode: ${thinkMode}`,
				`booted: ${booted ? "yes" : "no"}`,
				`ollama: ${version.ok ? version.stdout.trim() : version.stderr.trim() || "unavailable"}`,
				"",
				"[ollama list]",
				(list.stdout || list.stderr || "(no output)").trim(),
				"",
				"[ollama ps]",
				(ps.stdout || ps.stderr || "(no output)").trim(),
			].filter(Boolean);
			if (ctx.hasUI) ctx.ui.notify(lines.join("\n"), "info");
		},
	});
}
