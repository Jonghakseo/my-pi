import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { Api, AssistantMessageEventStream, Model, SimpleStreamOptions } from "@mariozechner/pi-ai";
import { streamOllamaNative as streamOllamaNativeBase } from "./utils/ollama-utils.js";

const PROVIDER_ID = "ollama-cloud";
const MODEL_ID = "glm-5.1:cloud";
const MODEL_NAME = "GLM 5.1 Cloud (via Ollama)";
const OLLAMA_BASE_URL = "http://127.0.0.1:11434";
const OLLAMA_API = "ollama-native-chat";

function notify(ctx: ExtensionContext, message: string, level: "info" | "warning" | "error" = "info") {
	if (!ctx.hasUI) return;
	ctx.ui.notify(message, level);
}

function streamOllamaNative(
	model: Model<Api>,
	context: import("@mariozechner/pi-ai").Context,
	options?: SimpleStreamOptions,
): AssistantMessageEventStream {
	return streamOllamaNativeBase(`${OLLAMA_BASE_URL}/api/chat`, model, context, options);
}

export default function (pi: ExtensionAPI) {
	pi.registerProvider(PROVIDER_ID, {
		baseUrl: OLLAMA_BASE_URL,
		apiKey: "ollama",
		api: OLLAMA_API,
		streamSimple: streamOllamaNative,
		models: [
			{
				id: MODEL_ID,
				name: MODEL_NAME,
				reasoning: true,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 200000,
				maxTokens: 131072,
			},
		],
	});

	pi.registerCommand("ollama-glm-cloud-status", {
		description: "Show Ollama GLM 5.1 Cloud provider configuration",
		handler: async (_args: string, ctx: ExtensionContext) => {
			const message = [
				`provider: ${PROVIDER_ID}`,
				`model: ${MODEL_ID}`,
				`name: ${MODEL_NAME}`,
				`baseUrl: ${OLLAMA_BASE_URL}`,
				"transport: native /api/chat via local Ollama",
			].join("\n");
			notify(ctx, message, "info");
		},
	});
}
