import { Box, Text } from "@earendil-works/pi-tui";
import { StringEnum } from "@earendil-works/pi-ai/compat";
import type { AgentToolResult, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
	loadConfig,
	loadConfigForExtensionInit,
	loadCuratorBootstrap,
	normalizeProviderInput,
	normalizeQueryList,
	resolveWorkflow,
	type CuratorWorkflow,
} from "./config-runtime.js";
import type { ExtractedContent } from "./extract.js";
import { search } from "./gemini-search.js";
import { extractDomain } from "./glimpse.js";
import type { QueryResultData } from "./storage.js";
import { buildCurationCancelledReturn, closeCurator, type PendingCurate, state } from "./state.js";
import type { SummaryGenerationContext } from "./summary-review.js";
import type { GetRuntimeSupport } from "./runtime.js";

const abortedAwait = Symbol("abortedAwait");

function awaitWithAbort<T>(work: Promise<T>, signal: AbortSignal | undefined): Promise<T | typeof abortedAwait> {
	if (!signal) return work;
	if (signal.aborted) return Promise.resolve(abortedAwait);
	return new Promise<T | typeof abortedAwait>((resolve, reject) => {
		const onAbort = () => {
			cleanup();
			resolve(abortedAwait);
		};
		const cleanup = () => signal.removeEventListener("abort", onAbort);
		signal.addEventListener("abort", onAbort, { once: true });
		work.then(
			(value) => {
				cleanup();
				resolve(value);
			},
			(err: unknown) => {
				cleanup();
				reject(err);
			},
		);
	});
}

const isRecencyFilter = (value: unknown): value is "day" | "week" | "month" | "year" =>
	value === "day" || value === "week" || value === "month" || value === "year";

export function registerWebSearchTool(pi: ExtensionAPI, getSupport: GetRuntimeSupport): void {
	pi.registerTool({
		name: "web_search",
		label: "Web Search",
		description: `Search the web using Perplexity AI, Exa, or Gemini. Returns an AI-synthesized answer with source citations. For comprehensive research, prefer queries (plural) with 2-4 varied angles over a single query — each query gets its own synthesized answer, so varying phrasing and scope gives much broader coverage. When includeContent is true, full page content is fetched in the background. Searches auto-open the interactive browser curator and stream results live; set workflow to "none" to skip curation. Provider auto-selects: Exa (direct API with key, MCP fallback without), else Perplexity (needs key), else Gemini API (needs key), else Gemini Web (needs a supported Chromium-based browser login).`,
		parameters: Type.Object({
			query: Type.Optional(
				Type.String({
					description: "Single search query. For research tasks, prefer 'queries' with multiple varied angles instead.",
				}),
			),
			queries: Type.Optional(
				Type.Array(Type.String(), {
					description:
						"Multiple queries searched in sequence, each returning its own synthesized answer. Prefer this for research — vary phrasing, scope, and angle across 2-4 queries to maximize coverage. Good: ['React vs Vue performance benchmarks 2026', 'React vs Vue developer experience comparison', 'React ecosystem size vs Vue ecosystem']. Bad: ['React vs Vue', 'React vs Vue comparison', 'React vs Vue review'] (too similar, redundant results).",
				}),
			),
			numResults: Type.Optional(Type.Number({ description: "Results per query (default: 5, max: 20)" })),
			includeContent: Type.Optional(Type.Boolean({ description: "Fetch full page content (async)" })),
			recencyFilter: Type.Optional(StringEnum(["day", "week", "month", "year"], { description: "Filter by recency" })),
			domainFilter: Type.Optional(
				Type.Array(Type.String(), { description: "Limit to domains (prefix with - to exclude)" }),
			),
			provider: Type.Optional(
				StringEnum(["auto", "perplexity", "gemini", "exa"], { description: "Search provider (default: auto)" }),
			),
			workflow: Type.Optional(
				StringEnum(["none", "summary-review"], {
					description:
						"Search workflow mode: none = no curator, summary-review = open curator with auto summary draft (default)",
				}),
			),
		}),

		// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: the web_search tool execute path coordinates validation, curator workflow, background fetch, and storage.
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const rawQueryList: unknown[] = Array.isArray(params.queries)
				? params.queries
				: params.query !== undefined
					? [params.query]
					: [];
			const queryList = normalizeQueryList(rawQueryList);
			const configWorkflow = loadConfigForExtensionInit().workflow;
			const workflow = resolveWorkflow(params.workflow ?? configWorkflow, ctx?.hasUI !== false);
			const shouldCurate = workflow !== "none";

			if (queryList.length === 0) {
				return {
					content: [{ type: "text", text: "Error: No query provided. Use 'query' or 'queries' parameter." }],
					details: { error: "No query provided" },
				};
			}

			if (shouldCurate && !ctx) {
				return {
					content: [{ type: "text", text: "Error: Curation requires an active extension context." }],
					details: { error: "Missing extension context" },
				};
			}

			if (shouldCurate) {
				// Generation must be captured synchronously (before any await) so a
				// closeCurator() racing with this call is detected as stale below.
				closeCurator();
				const curatorGeneration = state.curatorGeneration;
				if (signal?.aborted) return buildCurationCancelledReturn("user");
				// Heavy runtime (extract/curator/summary modules) loads on first search.
				const { loadSummaryModelChoices, openCuratorBrowser } = await getSupport();

				let resolvePromise: (value: AgentToolResult<Record<string, unknown>>) => void = () => {};
				const promise = new Promise<AgentToolResult<Record<string, unknown>>>((resolve) => {
					resolvePromise = resolve;
				});
				const includeContent = params.includeContent ?? false;
				const searchResults = new Map<number, QueryResultData>();
				const allInlineContent: ExtractedContent[] = [];
				const searchAbort = new AbortController();
				const searchSignal = signal ? AbortSignal.any([signal, searchAbort.signal]) : searchAbort.signal;
				let cancelled = false;

				const bootstrapResult = await awaitWithAbort(loadCuratorBootstrap(params.provider), signal);
				if (bootstrapResult === abortedAwait) return buildCurationCancelledReturn("user");
				if (state.curatorGeneration !== curatorGeneration) {
					return buildCurationCancelledReturn("stale");
				}
				const availableProviders = bootstrapResult.availableProviders;
				const defaultProvider = bootstrapResult.defaultProvider;
				const curatorTimeoutSeconds = bootstrapResult.timeoutSeconds;
				const curatorWorkflow: CuratorWorkflow = "summary-review";

				const summaryContext: SummaryGenerationContext = {
					model: ctx.model,
					modelRegistry: ctx.modelRegistry,
				};
				const summaryModelChoicesResult = await awaitWithAbort(loadSummaryModelChoices(summaryContext), signal);
				if (summaryModelChoicesResult === abortedAwait) return buildCurationCancelledReturn("user");
				if (state.curatorGeneration !== curatorGeneration) {
					return buildCurationCancelledReturn("stale");
				}
				const summaryModelChoices = summaryModelChoicesResult;

				const pc: PendingCurate = {
					phase: "searching",
					workflow: curatorWorkflow,
					summaryContext,
					searchResults,
					allInlineContent,
					queryList,
					includeContent,
					numResults: params.numResults,
					recencyFilter: isRecencyFilter(params.recencyFilter) ? params.recencyFilter : undefined,
					domainFilter: params.domainFilter,
					availableProviders,
					defaultProvider,
					summaryModels: summaryModelChoices.summaryModels,
					defaultSummaryModel: summaryModelChoices.defaultSummaryModel,
					timeoutSeconds: curatorTimeoutSeconds,
					onUpdate: onUpdate as PendingCurate["onUpdate"],
					signal,
					abortSearches: () => {
						if (!searchAbort.signal.aborted) searchAbort.abort();
					},
					finish: () => {},
					cancel: () => {},
				};

				const finish = (value: AgentToolResult<Record<string, unknown>>) => {
					if (cancelled) return;
					cancelled = true;
					pc.abortSearches();
					signal?.removeEventListener("abort", onAbort);
					state.pendingCurate = null;
					resolvePromise(value);
				};

				const cancel = (reason: "user" | "stale" = "stale") => {
					if (cancelled) return;
					finish(buildCurationCancelledReturn(reason));
				};

				pc.finish = finish;
				pc.cancel = cancel;

				const onAbort = () => closeCurator();
				state.pendingCurate = pc;
				signal?.addEventListener("abort", onAbort, { once: true });
				pc.browserPromise = openCuratorBrowser(pc, false);

				for (let qi = 0; qi < queryList.length; qi++) {
					if (signal?.aborted || cancelled || searchAbort.signal.aborted) break;
					onUpdate?.({
						content: [{ type: "text", text: `Searching ${qi + 1}/${queryList.length}: "${queryList[qi]}"...` }],
						details: { phase: "searching", progress: qi / queryList.length, currentQuery: queryList[qi] },
					});
					const requestedProvider = pc.defaultProvider;
					try {
						const { answer, results, inlineContent, provider } = await search(queryList[qi], {
							provider: requestedProvider,
							numResults: params.numResults,
							recencyFilter: isRecencyFilter(params.recencyFilter) ? params.recencyFilter : undefined,
							domainFilter: params.domainFilter,
							includeContent: params.includeContent,
							signal: searchSignal,
						});
						if (signal?.aborted || cancelled || searchAbort.signal.aborted) break;
						searchResults.set(qi, { query: queryList[qi], answer, results, error: null, provider });
						if (inlineContent) allInlineContent.push(...inlineContent);
						if (state.activeCurator) {
							state.activeCurator.pushResult(qi, {
								answer,
								results: results.map((r) => ({ title: r.title, url: r.url, domain: extractDomain(r.url) })),
								provider,
							});
						}
					} catch (err) {
						if (signal?.aborted || cancelled || searchAbort.signal.aborted) break;
						const message = err instanceof Error ? err.message : String(err);
						searchResults.set(qi, {
							query: queryList[qi],
							answer: "",
							results: [],
							error: message,
							provider: requestedProvider,
						});
						if (state.activeCurator) {
							state.activeCurator.pushError(qi, message, requestedProvider);
						}
					}
				}

				if (signal?.aborted || cancelled || searchAbort.signal.aborted) {
					cancel();
					return promise;
				}

				await pc.browserPromise;
				if (state.activeCurator && !cancelled) {
					state.activeCurator.searchesDone();
					pc.onUpdate?.({
						content: [{ type: "text", text: "All searches complete — waiting for summary approval in browser..." }],
						details: { phase: "curating", progress: 1 },
					});
				}

				return promise;
			}

			const searchResults: QueryResultData[] = [];
			const allUrls: string[] = [];
			const allInlineContent: ExtractedContent[] = [];
			const resolvedProvider = normalizeProviderInput(params.provider ?? loadConfig().provider);

			for (let i = 0; i < queryList.length; i++) {
				const query = queryList[i];

				onUpdate?.({
					content: [{ type: "text", text: `Searching ${i + 1}/${queryList.length}: "${query}"...` }],
					details: { phase: "search", progress: i / queryList.length, currentQuery: query },
				});

				try {
					const { answer, results, inlineContent, provider } = await search(query, {
						provider: resolvedProvider,
						numResults: params.numResults,
						recencyFilter: isRecencyFilter(params.recencyFilter) ? params.recencyFilter : undefined,
						domainFilter: params.domainFilter,
						includeContent: params.includeContent,
						signal,
					});

					if (signal?.aborted) break;

					searchResults.push({ query, answer, results, error: null, provider });
					for (const r of results) {
						if (!allUrls.includes(r.url)) {
							allUrls.push(r.url);
						}
					}
					if (inlineContent) allInlineContent.push(...inlineContent);
				} catch (err) {
					if (signal?.aborted) break;
					const message = err instanceof Error ? err.message : String(err);
					const requestedProvider =
						typeof resolvedProvider === "string" && resolvedProvider !== "auto" ? resolvedProvider : undefined;
					searchResults.push({ query, answer: "", results: [], error: message, provider: requestedProvider });
				}
			}

			const { buildSearchReturn } = await getSupport();
			return buildSearchReturn({
				queryList,
				results: searchResults,
				urls: allUrls,
				includeContent: params.includeContent ?? false,
				inlineContent: allInlineContent.length > 0 ? allInlineContent : undefined,
			});
		},

		renderCall(args, theme) {
			const input = args as { query?: unknown; queries?: unknown };
			const rawQueryList: unknown[] = Array.isArray(input.queries)
				? input.queries
				: input.query !== undefined
					? [input.query]
					: [];
			const queryList = normalizeQueryList(rawQueryList);
			if (queryList.length === 0) {
				return new Text(theme.fg("toolTitle", theme.bold("search ")) + theme.fg("error", "(no query)"), 0, 0);
			}
			if (queryList.length === 1) {
				const q = queryList[0];
				const display = q.length > 60 ? `${q.slice(0, 57)}...` : q;
				return new Text(theme.fg("toolTitle", theme.bold("search ")) + theme.fg("accent", `"${display}"`), 0, 0);
			}
			const lines = [theme.fg("toolTitle", theme.bold("search ")) + theme.fg("accent", `${queryList.length} queries`)];
			for (const q of queryList.slice(0, 5)) {
				const display = q.length > 50 ? `${q.slice(0, 47)}...` : q;
				lines.push(theme.fg("muted", `  "${display}"`));
			}
			if (queryList.length > 5) {
				lines.push(theme.fg("muted", `  ... and ${queryList.length - 5} more`));
			}
			return new Text(lines.join("\n"), 0, 0);
		},

		// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: search result rendering supports partial progress, curated summaries, and multiple detail layouts.
		renderResult(result, { expanded, isPartial }, theme) {
			type QueryDetail = {
				query: string;
				provider: string | null;
				answer: string | null;
				sources: Array<{ title: string; url: string }>;
				error: string | null;
			};
			const details = result.details as {
				queryCount?: number;
				successfulQueries?: number;
				totalResults?: number;
				error?: string;
				fetchId?: string;
				fetchUrls?: string[];
				phase?: string;
				progress?: number;
				currentQuery?: string;
				curated?: boolean;
				curatedFrom?: number;
				curatedQueries?: QueryDetail[];
				cancelled?: boolean;
				cancelReason?: string;
				summary?: {
					text: string;
					workflow: CuratorWorkflow;
					model: string | null;
					durationMs: number;
					tokenEstimate: number;
					fallbackUsed: boolean;
					fallbackReason?: string;
					edited?: boolean;
				};
			};

			if (isPartial) {
				if (details?.phase === "curating") {
					return new Text(theme.fg("accent", "waiting for summary approval..."), 0, 0);
				}
				if (details?.phase === "searching") {
					const progress = details?.progress ?? 0;
					const bar = "\u2588".repeat(Math.floor(progress * 10)) + "\u2591".repeat(10 - Math.floor(progress * 10));
					const query = details?.currentQuery || "";
					const display = query.length > 40 ? `${query.slice(0, 37)}...` : query;
					return new Text(theme.fg("accent", `[${bar}] ${display}`), 0, 0);
				}
				const progress = details?.progress ?? 0;
				const bar = "\u2588".repeat(Math.floor(progress * 10)) + "\u2591".repeat(10 - Math.floor(progress * 10));
				return new Text(theme.fg("accent", `[${bar}] ${details?.phase || "searching"}`), 0, 0);
			}

			if (details?.error) {
				return new Text(theme.fg("error", `Error: ${details.error}`), 0, 0);
			}

			let statusLine: string;
			const queryInfo =
				details?.queryCount === 1 ? "" : `${details?.successfulQueries}/${details?.queryCount} queries, `;
			statusLine = theme.fg("success", `${queryInfo}${details?.totalResults ?? 0} sources`);
			if (details?.curated && details?.curatedFrom) {
				statusLine += theme.fg("muted", ` (${details.queryCount}/${details.curatedFrom} queries curated)`);
			}
			if (details?.fetchId && details?.fetchUrls) {
				statusLine += theme.fg("muted", ` (fetching ${details.fetchUrls.length} URLs)`);
			} else if (details?.fetchId) {
				statusLine += theme.fg("muted", " (content ready)");
			}

			// Build expanded lines first so collapsed view can reference total count
			const lines = [statusLine];
			if (details?.summary?.text) {
				lines.push("");
				lines.push(theme.fg("accent", `── Summary (${details.summary.workflow}) ${"─".repeat(32)}`));
				lines.push("");
				for (const line of details.summary.text.split("\n")) {
					lines.push(`  ${line}`);
				}
				lines.push("");
				const metaParts = [
					details.summary.model ? `model=${details.summary.model}` : "model=deterministic",
					`duration=${details.summary.durationMs}ms`,
					`tokens~${details.summary.tokenEstimate}`,
					details.summary.fallbackUsed ? "fallback=true" : "fallback=false",
					details.summary.edited ? "edited=true" : "edited=false",
				];
				if (details.summary.fallbackReason) {
					metaParts.push(`reason=${details.summary.fallbackReason}`);
				}
				lines.push(theme.fg("dim", `  ${metaParts.join(" · ")}`));
			}

			const queryDetails = details?.curatedQueries;
			if (queryDetails?.length) {
				const kept = queryDetails.length;
				const from = details?.curatedFrom ?? kept;
				lines.push("");
				lines.push(
					theme.fg("accent", `\u2500\u2500 Curated Results (${kept} of ${from} queries kept) ${"\u2500".repeat(24)}`),
				);

				for (const cq of queryDetails) {
					lines.push("");
					const dq = cq.query.length > 65 ? `${cq.query.slice(0, 62)}...` : cq.query;
					const providerLabel = cq.provider ? ` (${cq.provider})` : "";
					lines.push(theme.fg("accent", `  "${dq}"${providerLabel}`));

					if (cq.error) {
						lines.push(theme.fg("error", `  ${cq.error}`));
					} else if (cq.answer) {
						lines.push("");
						for (const line of cq.answer.split("\n")) {
							lines.push(`  ${line}`);
						}
					}

					if (cq.sources.length > 0) {
						lines.push("");
						for (const s of cq.sources) {
							const domain = s.url.replace(/^https?:\/\//, "").replace(/\/.*$/, "");
							const title = s.title.length > 50 ? `${s.title.slice(0, 47)}...` : s.title;
							lines.push(theme.fg("muted", `  \u25b8 ${title}`) + theme.fg("dim", ` \u00b7 ${domain}`));
						}
					}
				}
				lines.push("");
			} else {
				const textContent = result.content.find((c) => c.type === "text")?.text || "";
				const preview = textContent.length > 500 ? `${textContent.slice(0, 500)}...` : textContent;
				for (const line of preview.split("\n")) {
					lines.push(theme.fg("dim", line));
				}
			}

			if (details?.fetchUrls && details.fetchUrls.length > 0) {
				if (details.curated) {
					lines.push(theme.fg("muted", `Fetching ${details.fetchUrls.length} URLs in background`));
				} else {
					lines.push(theme.fg("muted", "Fetching:"));
					for (const u of details.fetchUrls.slice(0, 5)) {
						const display = u.length > 60 ? `${u.slice(0, 57)}...` : u;
						lines.push(theme.fg("dim", `  ${display}`));
					}
					if (details.fetchUrls.length > 5) {
						lines.push(theme.fg("dim", `  ... and ${details.fetchUrls.length - 5} more`));
					}
				}
			}

			const totalLines = lines.length;

			if (!expanded) {
				const box = new Box(1, 0, (t) => theme.bg("toolSuccessBg", t));
				box.addChild(new Text(statusLine, 0, 0));

				let collapsedLines = 1; // statusLine
				const summaryPreview = details?.summary?.text?.trim() || "";
				if (summaryPreview) {
					const preview = summaryPreview.length > 120 ? `${summaryPreview.slice(0, 117)}...` : summaryPreview;
					box.addChild(new Text(theme.fg("dim", preview), 0, 0));
					collapsedLines++;
				} else if (details?.curatedQueries?.length) {
					for (const cq of details.curatedQueries.slice(0, 3)) {
						const dq = cq.query.length > 55 ? `${cq.query.slice(0, 52)}...` : cq.query;
						const srcCount = cq.sources?.length ?? 0;
						const suffix = cq.error ? theme.fg("error", " (error)") : theme.fg("dim", ` · ${srcCount} sources`);
						box.addChild(new Text(theme.fg("accent", `  "${dq}"`) + suffix, 0, 0));
						collapsedLines++;
					}
					if (details.curatedQueries.length > 3) {
						box.addChild(new Text(theme.fg("dim", `  ... and ${details.curatedQueries.length - 3} more`), 0, 0));
						collapsedLines++;
					}
				} else {
					const textContent = result.content.find((c) => c.type === "text")?.text || "";
					const firstContentLine = textContent.split("\n").find((l) => {
						const t = l.trim();
						return t && !t.startsWith("[") && !t.startsWith("#") && !t.startsWith("---");
					});
					const fallbackLine = (firstContentLine?.trim() || "").replace(/\*\*/g, "");
					if (fallbackLine) {
						const preview = fallbackLine.length > 120 ? `${fallbackLine.slice(0, 117)}...` : fallbackLine;
						box.addChild(new Text(theme.fg("dim", preview), 0, 0));
						collapsedLines++;
					}
				}
				const moreLines = Math.max(0, totalLines - collapsedLines);
				if (moreLines > 0) {
					box.addChild(
						new Text(theme.fg("muted", `\n... (${moreLines} more lines, ${totalLines} total, ctrl+o to expand)`), 0, 0),
					);
				}
				return box;
			}

			return new Text(lines.join("\n"), 0, 0);
		},
	});
}
