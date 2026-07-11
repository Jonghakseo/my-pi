import { randomUUID } from "node:crypto";
import { platform } from "node:os";
import { complete, getModel, type Api, type Model } from "@earendil-works/pi-ai/compat";
import type { AgentToolResult, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	type CuratorWorkflow,
	type ProviderAvailability,
	normalizeProviderInput,
	saveConfig,
} from "./config-runtime.js";
import { type CuratorServerHandle, startCuratorServer } from "./curator-server.js";
import { type ExtractedContent, fetchAllContent } from "./extract.js";
import { type ResolvedSearchProvider, search } from "./gemini-search.js";
import { type GlimpseWindow, extractDomain, getGlimpseOpen, openInBrowser, openInGlimpse } from "./glimpse.js";
import {
	duplicateQuerySet,
	formatQueryHeader,
	formatSearchSummary,
	hasFullInlineCoverage,
	stripThumbnails,
} from "./result-format.js";
import { generateId, type QueryResultData, type StoredSearchData, storeResult } from "./storage.js";
import {
	buildDeterministicSummary,
	generateSummaryDraft,
	type SummaryGenerationContext,
	type SummaryMeta,
} from "./summary-review.js";

export const state = {
	pendingFetches: new Map<string, AbortController>(),
	sessionActive: false,
	widgetVisible: false,
	widgetUnsubscribe: null as (() => void) | null,
	activeCurator: null as CuratorServerHandle | null,
	glimpseWin: null as GlimpseWindow | null,
	pendingCurate: null as PendingCurate | null,
};

export interface PendingCurate {
	phase: "searching" | "curating";
	workflow: CuratorWorkflow;
	summaryContext: SummaryGenerationContext;
	searchResults: Map<number, QueryResultData>;
	allInlineContent: ExtractedContent[];
	queryList: string[];
	includeContent: boolean;
	numResults?: number;
	recencyFilter?: "day" | "week" | "month" | "year";
	domainFilter?: string[];
	availableProviders: ProviderAvailability;
	defaultProvider: ResolvedSearchProvider;
	summaryModels: Array<{ value: string; label: string }>;
	defaultSummaryModel: string | null;
	timeoutSeconds: number;
	onUpdate:
		| ((update: { content: Array<{ type: string; text: string }>; details?: Record<string, unknown> }) => void)
		| undefined;
	signal: AbortSignal | undefined;
	abortSearches: () => void;
	finish: (value: AgentToolResult<Record<string, unknown>>) => void;
	cancel: (reason?: "user" | "stale") => void;
	browserPromise?: Promise<void>;
}

function cancelPendingCurate(reason: "user" | "stale" = "stale"): void {
	state.pendingCurate?.cancel(reason);
}

function closeCurator(): void {
	const win = state.glimpseWin;
	state.glimpseWin = null;
	try {
		win?.close();
	} catch {}
	cancelPendingCurate();
	if (state.activeCurator) {
		state.activeCurator.close();
		state.activeCurator = null;
	}
}

export function createRuntimeSupport(pi: ExtensionAPI) {
	function startBackgroundFetch(urls: string[]): string | null {
		if (urls.length === 0) return null;
		const fetchId = generateId();
		const controller = new AbortController();
		state.pendingFetches.set(fetchId, controller);
		fetchAllContent(urls, controller.signal)
			.then((fetched) => {
				if (!state.sessionActive || !state.pendingFetches.has(fetchId)) return;
				const data: StoredSearchData = {
					id: fetchId,
					type: "fetch",
					timestamp: Date.now(),
					urls: stripThumbnails(fetched),
				};
				storeResult(fetchId, data);
				pi.appendEntry("web-search-results", data);
				const ok = fetched.filter((f) => !f.error).length;
				pi.sendMessage(
					{
						customType: "web-search-content-ready",
						content: `Content fetched for ${ok}/${fetched.length} URLs [${fetchId}]. Full page content now available.`,
						display: true,
					},
					{ triggerTurn: true },
				);
			})
			.catch((err) => {
				if (!state.sessionActive || !state.pendingFetches.has(fetchId)) return;
				const message = err instanceof Error ? err.message : String(err);
				const isAbort = (err instanceof Error && err.name === "AbortError") || message.toLowerCase().includes("abort");
				if (!isAbort) {
					pi.sendMessage(
						{
							customType: "web-search-error",
							content: `Content fetch failed [${fetchId}]: ${message}`,
							display: true,
						},
						{ triggerTurn: false },
					);
				}
			})
			.finally(() => {
				state.pendingFetches.delete(fetchId);
			});
		return fetchId;
	}

	function storeAndPublishSearch(results: QueryResultData[]): string {
		const id = generateId();
		const data: StoredSearchData = {
			id,
			type: "search",
			timestamp: Date.now(),
			queries: results,
		};
		storeResult(id, data);
		pi.appendEntry("web-search-results", data);
		return id;
	}

	interface SearchReturnOptions {
		queryList: string[];
		results: QueryResultData[];
		urls: string[];
		includeContent: boolean;
		inlineContent?: ExtractedContent[];
		curated?: boolean;
		curatedFrom?: number;
		workflow?: CuratorWorkflow;
		approvedSummary?: string;
		summaryMeta?: SummaryMeta;
	}

	function normalizeSummaryMeta(meta: SummaryMeta | undefined, summaryText: string): SummaryMeta {
		const normalizedText = summaryText.trim();
		if (!meta) {
			return {
				model: null,
				durationMs: 0,
				tokenEstimate: normalizedText.length > 0 ? Math.max(1, Math.ceil(normalizedText.length / 4)) : 0,
				fallbackUsed: false,
				edited: false,
			};
		}

		return {
			model: meta.model,
			durationMs: Number.isFinite(meta.durationMs) && meta.durationMs >= 0 ? meta.durationMs : 0,
			tokenEstimate:
				Number.isFinite(meta.tokenEstimate) && meta.tokenEstimate >= 0
					? meta.tokenEstimate
					: normalizedText.length > 0
						? Math.max(1, Math.ceil(normalizedText.length / 4))
						: 0,
			fallbackUsed: meta.fallbackUsed === true,
			fallbackReason: meta.fallbackReason,
			edited: meta.edited === true,
		};
	}

	function buildCurationCancelledReturn(reason: "user" | "stale"): AgentToolResult<Record<string, unknown>> {
		const message = `Search curation cancelled (${reason}).`;
		return {
			content: [{ type: "text", text: message }],
			details: {
				error: message,
				cancelled: true,
				cancelReason: reason,
			},
		};
	}

	async function resolveFirstAvailableModel(
		ctx: SummaryGenerationContext,
		candidates: Array<{ provider: string; id: string }>,
	): Promise<{ model: Model<Api>; apiKey: string }> {
		const lookupModel = getModel as (provider: string, modelId: string) => Model<Api> | undefined;
		for (const { provider, id } of candidates) {
			const model = lookupModel(provider, id);
			if (!model) continue;
			const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
			if (auth.ok && auth.apiKey) return { model, apiKey: auth.apiKey };
		}
		throw new Error(`No model available: ${candidates.map((c) => `${c.provider}/${c.id}`).join(", ")}`);
	}

	async function rewriteSearchQuery(
		query: string,
		ctx: SummaryGenerationContext,
		signal: AbortSignal,
	): Promise<string> {
		const { model, apiKey } = await resolveFirstAvailableModel(ctx, [
			{ provider: "anthropic", id: "claude-haiku-4-5" },
			{ provider: "google", id: "gemini-2.5-flash" },
			{ provider: "openai", id: "gpt-4.1-mini" },
		]);
		const response = await complete(
			model,
			{
				messages: [
					{
						role: "user",
						content: [
							{
								type: "text",
								text: `Rewrite this web search query to get better, more specific results. Add relevant year qualifiers, precise technical terms, and specificity. Return ONLY the improved query text, nothing else.\n\nQuery: ${query}`,
							},
						],
						timestamp: Date.now(),
					},
				],
			},
			{ apiKey, signal },
		);
		if (response.stopReason === "aborted") throw new Error("Aborted");
		const contentParts = Array.isArray(response.content) ? response.content : [];
		const text = contentParts
			.map((p) => {
				if (!p || typeof p !== "object") return "";
				const part = p as unknown as Record<string, unknown>;
				return typeof part.text === "string" ? part.text : "";
			})
			.join("")
			.trim();
		if (!text) throw new Error("Rewrite returned empty response");
		return text;
	}

	async function generateSummaryForSelectedIndices(
		selectedQueryIndices: number[],
		resultsByIndex: Map<number, QueryResultData>,
		summaryContext: SummaryGenerationContext,
		signal?: AbortSignal,
		modelOverride?: string,
		feedback?: string,
	): Promise<{ summary: string; meta: SummaryMeta }> {
		const selectedResults: QueryResultData[] = [];
		for (const qi of selectedQueryIndices) {
			const result = resultsByIndex.get(qi);
			if (result) selectedResults.push(result);
		}
		if (selectedResults.length === 0) {
			throw new Error("No selected results available for summary generation");
		}
		try {
			return await generateSummaryDraft(selectedResults, summaryContext, signal, modelOverride, feedback);
		} catch (err) {
			const isEmptyResponse = err instanceof Error && err.message.includes("Summary model returned empty response");
			if (!isEmptyResponse) throw err;
			const deterministic = buildDeterministicSummary(selectedResults);
			return {
				summary: deterministic.summary,
				meta: {
					...deterministic.meta,
					fallbackReason: "summary-model-empty-response",
				},
			};
		}
	}

	async function loadSummaryModelChoices(
		summaryContext: SummaryGenerationContext,
	): Promise<{ summaryModels: Array<{ value: string; label: string }>; defaultSummaryModel: string | null }> {
		const summaryModels: Array<{ value: string; label: string }> = [];
		const seen = new Set<string>();
		const availableValues = new Set<string>();

		const addModel = (provider: string, id: string) => {
			const value = `${provider}/${id}`;
			if (seen.has(value)) return;
			seen.add(value);
			summaryModels.push({ value, label: value });
		};

		try {
			const availableModels = summaryContext.modelRegistry.getAvailable();
			for (const model of availableModels) {
				const value = `${model.provider}/${model.id}`;
				availableValues.add(value);
				addModel(model.provider, model.id);
			}
		} catch (err) {
			const _message = err instanceof Error ? err.message : String(err);
		}

		const currentModelValue = summaryContext.model
			? `${summaryContext.model.provider}/${summaryContext.model.id}`
			: null;
		if (summaryContext.model && currentModelValue && !seen.has(currentModelValue)) {
			addModel(summaryContext.model.provider, summaryContext.model.id);
		}

		const preferredDefaults = ["anthropic/claude-haiku-4-5", "openai-codex/gpt-5.3-codex-spark"];
		let defaultSummaryModel: string | null = null;
		for (const preferred of preferredDefaults) {
			if (availableValues.has(preferred)) {
				defaultSummaryModel = preferred;
				break;
			}
		}
		if (!defaultSummaryModel && summaryModels.length > 0) {
			defaultSummaryModel = summaryModels[0].value;
		}

		return { summaryModels, defaultSummaryModel };
	}

	function resolveSummaryForSubmit(
		payload: { selectedQueryIndices: number[]; summary?: string; summaryMeta?: SummaryMeta },
		resultsByIndex: Map<number, QueryResultData>,
	): { approvedSummary: string; summaryMeta: SummaryMeta } {
		const submittedSummary = typeof payload.summary === "string" ? payload.summary.trim() : "";
		if (submittedSummary.length > 0) {
			return {
				approvedSummary: submittedSummary,
				summaryMeta: normalizeSummaryMeta(payload.summaryMeta, submittedSummary),
			};
		}

		const selected = filterByQueryIndices(payload.selectedQueryIndices, resultsByIndex).results;
		const fallbackResults = selected.length > 0 ? selected : [...resultsByIndex.values()];
		const deterministic = buildDeterministicSummary(fallbackResults);
		return {
			approvedSummary: deterministic.summary,
			summaryMeta: deterministic.meta,
		};
	}

	// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: search output formatting handles curated and non-curated response variants in one place.
	function buildSearchReturn(opts: SearchReturnOptions): AgentToolResult<Record<string, unknown>> {
		const sc = opts.results.filter((r) => !r.error).length;
		const tr = opts.results.reduce((sum, r) => sum + r.results.length, 0);

		const hasApprovedSummary = typeof opts.approvedSummary === "string" && opts.approvedSummary.trim().length > 0;
		let output = "";
		if (hasApprovedSummary) {
			output = opts.approvedSummary?.trim() ?? "";
		} else {
			if (opts.curated) {
				output +=
					"[These results were manually curated by the user in the browser. Use them as-is — do not re-search or discard.]\n\n";
			}
			const duplicateQueries = opts.curated ? duplicateQuerySet(opts.results) : new Set<string>();
			for (const { query, answer, results, error, provider } of opts.results) {
				if (opts.queryList.length > 1) {
					output += opts.curated ? formatQueryHeader(query, provider, duplicateQueries) : `## Query: "${query}"\n\n`;
				}
				if (error) output += `Error: ${error}\n\n`;
				else if (results.length === 0) output += "No results found.\n\n";
				else output += `${formatSearchSummary(results, answer)}\n\n`;
			}
		}

		const hasInlineReady = hasFullInlineCoverage(opts.urls, opts.inlineContent);
		let fetchId: string | null = null;
		if (hasInlineReady && opts.inlineContent) {
			fetchId = generateId();
			const data: StoredSearchData = {
				id: fetchId,
				type: "fetch",
				timestamp: Date.now(),
				urls: opts.inlineContent,
			};
			storeResult(fetchId, data);
			pi.appendEntry("web-search-results", data);
			if (!hasApprovedSummary) {
				output += `---\nFull content for ${opts.inlineContent.length} sources available [${fetchId}].`;
			}
		} else if (opts.includeContent) {
			fetchId = startBackgroundFetch(opts.urls);
			if (fetchId && !hasApprovedSummary) {
				output += `---\nContent fetching in background [${fetchId}]. Will notify when ready.`;
			}
		}

		const searchId = storeAndPublishSearch(opts.results);
		const isBackgroundFetch = fetchId !== null && !hasInlineReady;

		return {
			content: [{ type: "text", text: output.trim() }],
			details: {
				queries: opts.queryList,
				queryCount: opts.queryList.length,
				successfulQueries: sc,
				totalResults: tr,
				includeContent: opts.includeContent,
				fetchId,
				fetchUrls: isBackgroundFetch ? opts.urls : undefined,
				searchId,
				...(opts.curated
					? {
							curated: true,
							curatedFrom: opts.curatedFrom,
							curatedQueries: opts.results.map((r) => ({
								query: r.query,
								provider: r.provider || null,
								answer: r.answer || null,
								sources: r.results.map((s) => ({ title: s.title, url: s.url })),
								error: r.error,
							})),
						}
					: {}),
				...(opts.workflow && hasApprovedSummary
					? {
							summary: {
								text: opts.approvedSummary?.trim(),
								workflow: opts.workflow,
								model: opts.summaryMeta?.model ?? null,
								durationMs: opts.summaryMeta?.durationMs ?? 0,
								tokenEstimate: opts.summaryMeta?.tokenEstimate ?? 0,
								fallbackUsed: opts.summaryMeta?.fallbackUsed === true,
								fallbackReason: opts.summaryMeta?.fallbackReason,
								edited: opts.summaryMeta?.edited === true,
							},
						}
					: {}),
			},
		};
	}

	function filterByQueryIndices(selectedQueryIndices: number[], results: Map<number, QueryResultData>) {
		const filteredResults: QueryResultData[] = [];
		const filteredUrls: string[] = [];
		for (const qi of selectedQueryIndices) {
			const r = results.get(qi);
			if (r) {
				filteredResults.push(r);
				for (const res of r.results) {
					if (!filteredUrls.includes(res.url)) filteredUrls.push(res.url);
				}
			}
		}
		return { results: filteredResults, urls: filteredUrls };
	}

	function collectAllResultsAndUrls(resultsByIndex: Map<number, QueryResultData>) {
		const results = [...resultsByIndex.values()];
		const urls: string[] = [];
		for (const result of results) {
			for (const source of result.results) {
				if (!urls.includes(source.url)) urls.push(source.url);
			}
		}
		return { results, urls };
	}

	// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: browser bootstrapping coordinates server lifecycle, summary callbacks, and cancellation for one curator session.
	async function openCuratorBrowser(pc: PendingCurate, searchesComplete = true): Promise<void> {
		let handle: CuratorServerHandle | null = null;
		try {
			pc.phase = "curating";

			const searchAbort = new AbortController();
			const addSearchSignal = pc.signal ? AbortSignal.any([pc.signal, searchAbort.signal]) : searchAbort.signal;

			const sessionToken = randomUUID();
			handle = await startCuratorServer(
				{
					queries: pc.queryList,
					sessionToken,
					timeout: pc.timeoutSeconds,
					availableProviders: pc.availableProviders,
					defaultProvider: pc.defaultProvider,
					summaryModels: pc.summaryModels,
					defaultSummaryModel: pc.defaultSummaryModel,
				},
				{
					async onSummarize(selectedQueryIndices, summarizeSignal, model, feedback) {
						if (state.pendingCurate !== pc) throw new Error("Curator session is no longer active.");
						pc.onUpdate?.({
							content: [{ type: "text", text: "Generating summary draft..." }],
							details: { phase: "generating-summary", progress: 0.9 },
						});
						const draft = await generateSummaryForSelectedIndices(
							selectedQueryIndices,
							pc.searchResults,
							pc.summaryContext,
							summarizeSignal,
							model,
							feedback,
						);
						if (state.pendingCurate !== pc) throw new Error("Curator session is no longer active.");
						pc.onUpdate?.({
							content: [{ type: "text", text: "Summary draft ready — waiting for approval..." }],
							details: { phase: "waiting-for-approval", progress: 1 },
						});
						return draft;
					},
					onSubmit(payload) {
						if (state.pendingCurate !== pc) return;
						searchAbort.abort();
						const filtered =
							payload.selectedQueryIndices.length > 0
								? filterByQueryIndices(payload.selectedQueryIndices, pc.searchResults)
								: collectAllResultsAndUrls(pc.searchResults);
						const filteredInline = pc.allInlineContent.filter((c) => filtered.urls.includes(c.url));
						const base: SearchReturnOptions = {
							queryList: filtered.results.map((r) => r.query),
							results: filtered.results,
							urls: filtered.urls,
							includeContent: pc.includeContent,
							inlineContent: filteredInline.length > 0 ? filteredInline : undefined,
							curated: true,
							curatedFrom: pc.searchResults.size,
						};
						if (!payload.rawResults) {
							const resolvedSummary = resolveSummaryForSubmit(payload, pc.searchResults);
							base.workflow = pc.workflow;
							base.approvedSummary = resolvedSummary.approvedSummary;
							base.summaryMeta = resolvedSummary.summaryMeta;
						}
						pc.finish(buildSearchReturn(base));
						closeCurator();
					},
					onCancel(reason) {
						if (state.pendingCurate !== pc) return;
						searchAbort.abort();
						if (reason === "timeout") {
							const resolvedSummary = resolveSummaryForSubmit(
								{ selectedQueryIndices: [], summary: undefined, summaryMeta: undefined },
								pc.searchResults,
							);
							const all = collectAllResultsAndUrls(pc.searchResults);
							const filteredInline = pc.allInlineContent.filter((c) => all.urls.includes(c.url));
							pc.finish(
								buildSearchReturn({
									queryList: all.results.map((r) => r.query),
									results: all.results,
									urls: all.urls,
									includeContent: pc.includeContent,
									inlineContent: filteredInline.length > 0 ? filteredInline : undefined,
									curated: true,
									curatedFrom: pc.searchResults.size,
									workflow: pc.workflow,
									approvedSummary: resolvedSummary.approvedSummary,
									summaryMeta: resolvedSummary.summaryMeta,
								}),
							);
						} else {
							pc.finish(buildCurationCancelledReturn(reason));
						}
						closeCurator();
					},
					onProviderChange(provider) {
						if (state.pendingCurate !== pc) return;
						const normalized = normalizeProviderInput(provider);
						if (!normalized || normalized === "auto") return;
						pc.defaultProvider = normalized;
						try {
							saveConfig({ provider: normalized });
						} catch (err) {
							const _message = err instanceof Error ? err.message : String(err);
						}
					},
					async onAddSearch(query, queryIndex, provider) {
						if (state.pendingCurate !== pc) throw new Error("Curator session is no longer active.");
						const normalizedProvider = normalizeProviderInput(provider);
						const requestedProvider =
							!normalizedProvider || normalizedProvider === "auto" ? pc.defaultProvider : normalizedProvider;
						try {
							const {
								answer,
								results,
								inlineContent,
								provider: actualProvider,
							} = await search(query, {
								provider: requestedProvider,
								numResults: pc.numResults,
								recencyFilter: pc.recencyFilter,
								domainFilter: pc.domainFilter,
								includeContent: pc.includeContent,
								signal: addSearchSignal,
							});
							if (state.pendingCurate !== pc) throw new Error("Curator session is no longer active.");
							pc.searchResults.set(queryIndex, { query, answer, results, error: null, provider: actualProvider });
							if (inlineContent) pc.allInlineContent.push(...inlineContent);
							return {
								answer,
								results: results.map((r) => ({ title: r.title, url: r.url, domain: extractDomain(r.url) })),
								provider: actualProvider,
							};
						} catch (err) {
							const message = err instanceof Error ? err.message : String(err);
							if (state.pendingCurate === pc) {
								pc.searchResults.set(queryIndex, {
									query,
									answer: "",
									results: [],
									error: message,
									provider: requestedProvider,
								});
							}
							throw err;
						}
					},
					async onRewriteQuery(query, rewriteSignal) {
						if (state.pendingCurate !== pc) throw new Error("Curator session is no longer active.");
						return rewriteSearchQuery(query, pc.summaryContext, rewriteSignal);
					},
				},
			);

			if (state.pendingCurate !== pc) {
				handle.close();
				return;
			}

			state.activeCurator = handle;

			for (const [qi, data] of pc.searchResults) {
				if (data.error) {
					handle.pushError(qi, data.error, data.provider);
				} else {
					handle.pushResult(qi, {
						answer: data.answer,
						results: data.results.map((r) => ({ title: r.title, url: r.url, domain: extractDomain(r.url) })),
						provider: data.provider || pc.defaultProvider,
					});
				}
			}
			if (searchesComplete) handle.searchesDone();

			pc.onUpdate?.({
				content: [
					{
						type: "text",
						text: searchesComplete ? "Waiting for summary approval in browser..." : "Searches streaming to browser...",
					},
				],
				details: { phase: "curating", progress: searchesComplete ? 1 : 0.5 },
			});

			const open = platform() === "darwin" ? await getGlimpseOpen() : null;
			if (open) {
				try {
					const win = openInGlimpse(open, handle.url, "Search Curator");
					state.glimpseWin = win;
					win.on("closed", () => {
						if (state.glimpseWin === win) {
							state.glimpseWin = null;
							closeCurator();
						}
					});
					return;
				} catch (err) {
					const _message = err instanceof Error ? err.message : String(err);
					state.glimpseWin = null;
				}
			}
			await openInBrowser(pi, handle.url);
		} catch (err) {
			const _message = err instanceof Error ? err.message : String(err);
			if (state.pendingCurate === pc || (handle && state.activeCurator === handle)) {
				closeCurator();
			}
		}
	}

	return {
		buildCurationCancelledReturn,
		buildSearchReturn,
		closeCurator,
		collectAllResultsAndUrls,
		filterByQueryIndices,
		generateSummaryForSelectedIndices,
		loadSummaryModelChoices,
		openCuratorBrowser,
		resolveSummaryForSubmit,
		rewriteSearchQuery,
	};
}
