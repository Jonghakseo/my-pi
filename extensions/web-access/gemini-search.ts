import { activityMonitor } from "./activity.js";
import { hasExaApiKey, isExaAvailable, searchWithExa } from "./exa.js";
import { API_BASE, DEFAULT_MODEL, getApiKey, isGeminiApiAvailable } from "./gemini-api.js";
import type { SearchOptions, SearchResponse, SearchResult } from "./search-types.js";
import { loadConfigSection } from "./config.js";

export type SearchProvider = "auto" | "gemini" | "exa";
export type ResolvedSearchProvider = Exclude<SearchProvider, "auto">;

export interface AttributedSearchResponse extends SearchResponse {
	provider: ResolvedSearchProvider;
}

let cachedSearchConfig: { searchProvider: SearchProvider; searchModel?: string } | null = null;

function getSearchConfig(): { searchProvider: SearchProvider; searchModel?: string } {
	if (cachedSearchConfig) return cachedSearchConfig;
	cachedSearchConfig = loadConfigSection(
		"search",
		{ searchProvider: "auto" as SearchProvider, searchModel: undefined as string | undefined },
		(raw) => ({
			searchProvider: normalizeSearchProvider(raw.searchProvider ?? raw.provider),
			searchModel: normalizeSearchModel(raw.searchModel),
		}),
	);
	return cachedSearchConfig;
}

function normalizeSearchModel(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const normalized = value.trim();
	return normalized.length > 0 ? normalized : undefined;
}

function normalizeSearchProvider(value: unknown): SearchProvider {
	const normalized = typeof value === "string" ? value.trim().toLowerCase() : "";
	return normalized === "auto" || normalized === "gemini" || normalized === "exa" ? normalized : "auto";
}

export interface FullSearchOptions extends SearchOptions {
	provider?: SearchProvider;
	includeContent?: boolean;
}

function errorMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

function isAbortError(err: unknown): boolean {
	return errorMessage(err).toLowerCase().includes("abort");
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: provider selection is intentionally centralized so fallback ordering stays consistent.
export async function search(query: string, options: FullSearchOptions = {}): Promise<AttributedSearchResponse> {
	const config = getSearchConfig();
	const provider = options.provider ?? config.searchProvider;

	if (provider === "gemini") {
		const result = await searchWithGeminiApi(query, options);
		if (result) return { ...result, provider: "gemini" };
		throw new Error("Gemini search unavailable. Set GEMINI_API_KEY in ~/.pi/web-search.json");
	}

	if (provider === "exa") {
		const exaApiKeyConfigured = hasExaApiKey();
		try {
			const result = await searchWithExa(query, options);
			if (result && "exhausted" in result) {
				throw new Error(
					"Exa monthly free tier exhausted (1,000 requests). Resets next month.\n" +
						"  Use provider: 'gemini', or upgrade at exa.ai/pricing",
				);
			}
			if (result && "answer" in result) return { ...result, provider: "exa" };
			if (exaApiKeyConfigured) {
				throw new Error("Exa search returned no results.");
			}
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			if (message.toLowerCase().includes("abort")) throw err;
			if (exaApiKeyConfigured) throw err;
			// No API key: allow provider fallback.
		}
	}

	const fallbackErrors: string[] = [];

	if (provider !== "exa" && isExaAvailable()) {
		try {
			const result = await searchWithExa(query, options);
			if (result && "answer" in result) return { ...result, provider: "exa" };
		} catch (err) {
			if (isAbortError(err)) throw err;
			fallbackErrors.push(`Exa: ${errorMessage(err)}`);
		}
	}

	if (isGeminiApiAvailable()) {
		try {
			const geminiResult = await searchWithGeminiApi(query, options);
			if (geminiResult) return { ...geminiResult, provider: "gemini" };
		} catch (err) {
			if (isAbortError(err)) throw err;
			fallbackErrors.push(`Gemini: ${errorMessage(err)}`);
		}
	}

	if (fallbackErrors.length > 0) {
		throw new Error(`Auto provider search failed:\n  - ${fallbackErrors.join("\n  - ")}`);
	}

	throw new Error(
		"No search provider available. Either:\n" +
			"  1. Set EXA_API_KEY (or exaApiKey) in ~/.pi/web-search.json\n" +
			"  2. Set GEMINI_API_KEY in ~/.pi/web-search.json",
	);
}

async function searchWithGeminiApi(query: string, options: SearchOptions = {}): Promise<SearchResponse | null> {
	const apiKey = getApiKey();
	if (!apiKey) return null;

	const activityId = activityMonitor.logStart({ type: "api", query });

	try {
		const model = getSearchConfig().searchModel ?? DEFAULT_MODEL;
		const body = {
			contents: [{ parts: [{ text: query }] }],
			tools: [{ google_search: {} }],
		};

		const res = await fetch(`${API_BASE}/models/${model}:generateContent?key=${apiKey}`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(body),
			signal: AbortSignal.any([AbortSignal.timeout(60000), ...(options.signal ? [options.signal] : [])]),
		});

		if (!res.ok) {
			const errorText = await res.text();
			throw new Error(`Gemini API error ${res.status}: ${errorText.slice(0, 300)}`);
		}

		const data = (await res.json()) as GeminiSearchResponse;
		activityMonitor.logComplete(activityId, res.status);

		const answer =
			data.candidates?.[0]?.content?.parts
				?.map((p) => p.text)
				.filter(Boolean)
				.join("\n") ?? "";

		const metadata = data.candidates?.[0]?.groundingMetadata;
		const results = await resolveGroundingChunks(metadata?.groundingChunks, options.signal);

		if (!answer && results.length === 0) return null;
		return { answer, results };
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		if (message.toLowerCase().includes("abort")) {
			activityMonitor.logComplete(activityId, 0);
		} else {
			activityMonitor.logError(activityId, message);
		}
		throw err;
	}
}

async function resolveGroundingChunks(
	chunks: GroundingChunk[] | undefined,
	signal?: AbortSignal,
): Promise<SearchResult[]> {
	if (!chunks?.length) return [];

	const results: SearchResult[] = [];
	for (const chunk of chunks) {
		if (!chunk.web) continue;
		const title = chunk.web.title || "";
		let url = chunk.web.uri || "";

		if (url.includes("vertexaisearch.cloud.google.com/grounding-api-redirect")) {
			const resolved = await resolveRedirect(url, signal);
			if (resolved) url = resolved;
		}

		if (url) results.push({ title, url, snippet: "" });
	}
	return results;
}

async function resolveRedirect(proxyUrl: string, signal?: AbortSignal): Promise<string | null> {
	try {
		const res = await fetch(proxyUrl, {
			method: "HEAD",
			redirect: "manual",
			signal: AbortSignal.any([AbortSignal.timeout(5000), ...(signal ? [signal] : [])]),
		});
		return res.headers.get("location") || null;
	} catch {
		return null;
	}
}

interface GeminiSearchResponse {
	candidates?: Array<{
		content?: { parts?: Array<{ text?: string }> };
		groundingMetadata?: {
			webSearchQueries?: string[];
			groundingChunks?: GroundingChunk[];
			groundingSupports?: Array<{
				segment?: { startIndex?: number; endIndex?: number; text?: string };
				groundingChunkIndices?: number[];
			}>;
		};
	}>;
}

interface GroundingChunk {
	web?: { uri?: string; title?: string };
}
