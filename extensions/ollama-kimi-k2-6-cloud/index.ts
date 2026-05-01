import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type { Api, AssistantMessageEventStream, Model, SimpleStreamOptions } from "@mariozechner/pi-ai";
import { streamOllamaNative as streamOllamaNativeBase } from "../utils/ollama-utils.js";

const PROVIDER_ID = "ollama-kimi-cloud";
const MODEL_ID = "kimi-k2.6:cloud";
const MODEL_NAME = "Kimi K2.6 Cloud (via Ollama)";
const OLLAMA_BASE_URL = "http://127.0.0.1:11434";
const OLLAMA_API = "ollama-native-chat";

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
				input: ["text", "image"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 262144,
				maxTokens: 131072,
			},
		],
	});
}
