import { loadConfigSection, normalizeApiKey } from "./config.js";

export const API_BASE = "https://generativelanguage.googleapis.com/v1beta";
export const DEFAULT_MODEL = "gemini-3-flash-preview";

interface GeminiApiConfig {
	geminiApiKey: string | null;
}

const GEMINI_API_DEFAULTS: GeminiApiConfig = { geminiApiKey: null };

function loadGeminiApiConfig(): GeminiApiConfig {
	return loadConfigSection("gemini-api", GEMINI_API_DEFAULTS, (raw) => ({
		geminiApiKey: normalizeApiKey(raw.geminiApiKey),
	}));
}

function withTimeout(signal: AbortSignal | undefined, timeoutMs: number): AbortSignal {
	const timeout = AbortSignal.timeout(timeoutMs);
	return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

export function getApiKey(): string | null {
	return normalizeApiKey(process.env.GEMINI_API_KEY) ?? loadGeminiApiConfig().geminiApiKey;
}

export function isGeminiApiAvailable(): boolean {
	return getApiKey() !== null;
}

export interface GeminiApiOptions {
	model?: string;
	mimeType?: string;
	signal?: AbortSignal;
	timeoutMs?: number;
}

export async function queryGeminiApiWithVideo(
	prompt: string,
	videoUri: string,
	options: GeminiApiOptions = {},
): Promise<string> {
	const apiKey = getApiKey();
	if (!apiKey) throw new Error("GEMINI_API_KEY not configured");

	const model = options.model ?? DEFAULT_MODEL;
	const signal = withTimeout(options.signal, options.timeoutMs ?? 120000);
	const url = `${API_BASE}/models/${model}:generateContent?key=${apiKey}`;

	const fileData: Record<string, string> = { fileUri: videoUri };
	if (options.mimeType) fileData.mimeType = options.mimeType;

	const body = {
		contents: [
			{
				parts: [{ fileData }, { text: prompt }],
			},
		],
	};

	const res = await fetch(url, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body),
		signal,
	});

	if (!res.ok) {
		const errorText = await res.text();
		throw new Error(`Gemini API error ${res.status}: ${errorText.slice(0, 300)}`);
	}

	const data = (await res.json()) as GenerateContentResponse;
	const text = data.candidates?.[0]?.content?.parts
		?.map((p) => p.text)
		.filter(Boolean)
		.join("\n");

	if (!text) throw new Error("Gemini API returned empty response");
	return text;
}

interface GenerateContentResponse {
	candidates?: Array<{
		content?: {
			parts?: Array<{ text?: string }>;
		};
	}>;
}
