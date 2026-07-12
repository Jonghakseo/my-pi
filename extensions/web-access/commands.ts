import { randomUUID } from "node:crypto";
import { platform } from "node:os";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	type CuratorBootstrap,
	loadConfigForExtensionInit,
	loadCuratorBootstrap,
	normalizeProviderInput,
	normalizeQueryList,
	resolveWorkflow,
	saveConfig,
	type WebSearchWorkflow,
} from "./config-runtime.js";
import type { CuratorServerHandle } from "./curator-server.js";
import { search } from "./gemini-search.js";
import { getActiveGoogleEmail, isGeminiWebAvailable } from "./gemini-web.js";
import { extractDomain, getGlimpseOpen, openInBrowser, openInGlimpse } from "./glimpse.js";
import { deleteResult, getAllResults, type QueryResultData } from "./storage.js";
import { closeCurator, state } from "./state.js";
import type { SummaryGenerationContext } from "./summary-review.js";
import type { GetRuntimeSupport } from "./runtime.js";
export function registerCommands(pi: ExtensionAPI, getSupport: GetRuntimeSupport): void {
	pi.registerCommand("websearch", {
		description: "Open web search curator",
		// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: websearch command setup keeps curator startup, provider selection, and browser fallback in one command handler.
		handler: async (args, ctx) => {
			// Generation must be captured synchronously (before any await) so a
			// racing closeCurator() is detected via ownsCuratorStartup below.
			closeCurator();
			const curatorGeneration = state.curatorGeneration;
			// Heavy runtime (extract/curator/summary modules) loads on first use.
			const {
				buildSearchReturn,
				collectAllResultsAndUrls,
				filterByQueryIndices,
				generateSummaryForSelectedIndices,
				loadSummaryModelChoices,
				resolveSummaryForSubmit,
				rewriteSearchQuery,
				startCuratorServer,
			} = await getSupport();
			const ownsCuratorStartup = () => state.curatorGeneration === curatorGeneration;
			const sessionToken = randomUUID();

			const raw = args.trim();
			const queries = raw.length > 0 ? normalizeQueryList(raw.split(",")) : [];

			let bootstrap: CuratorBootstrap;
			try {
				bootstrap = await loadCuratorBootstrap(undefined);
			} catch (err) {
				if (!ownsCuratorStartup()) return;
				const message = err instanceof Error ? err.message : String(err);
				ctx.ui.notify(`Failed to load web search config: ${message}`, "error");
				return;
			}
			if (!ownsCuratorStartup()) return;
			const availableProviders = bootstrap.availableProviders;
			const initialProvider = bootstrap.defaultProvider;
			const curatorTimeoutSeconds = bootstrap.timeoutSeconds;
			let currentProvider = initialProvider;
			const summaryContext: SummaryGenerationContext = {
				model: ctx.model,
				modelRegistry: ctx.modelRegistry,
			};
			const summaryModelChoices = await loadSummaryModelChoices(summaryContext);
			if (!ownsCuratorStartup()) return;

			ctx.ui.notify("Opening web search curator...", "info");

			const collected = new Map<number, QueryResultData>();
			const searchAbort = new AbortController();
			let aborted = false;
			let commandHandle: CuratorServerHandle | null = null;

			function sendFollowUpFromReturn(payload: ReturnType<typeof buildSearchReturn>) {
				pi.sendMessage(
					{
						customType: "web-search-results",
						content: payload.content,
						display: true,
						details: payload.details,
					},
					{ triggerTurn: true, deliverAs: "followUp" },
				);
			}

			try {
				const handle = await startCuratorServer(
					{
						queries,
						sessionToken,
						timeout: curatorTimeoutSeconds,
						availableProviders,
						defaultProvider: initialProvider,
						summaryModels: summaryModelChoices.summaryModels,
						defaultSummaryModel: summaryModelChoices.defaultSummaryModel,
					},
					{
						async onSummarize(selectedQueryIndices, summarizeSignal, model, feedback) {
							if (commandHandle && state.activeCurator !== commandHandle) {
								throw new Error("Curator session is no longer active.");
							}
							return generateSummaryForSelectedIndices(
								selectedQueryIndices,
								collected,
								summaryContext,
								summarizeSignal,
								model,
								feedback,
							);
						},
						onSubmit(payload) {
							if (commandHandle && state.activeCurator !== commandHandle) return;
							aborted = true;
							searchAbort.abort();
							const filtered =
								payload.selectedQueryIndices.length > 0
									? filterByQueryIndices(payload.selectedQueryIndices, collected)
									: collectAllResultsAndUrls(collected);
							const base: Parameters<typeof buildSearchReturn>[0] = {
								queryList: filtered.results.map((r) => r.query),
								results: filtered.results,
								urls: filtered.urls,
								includeContent: false,
								curated: true,
								curatedFrom: collected.size,
							};
							if (!payload.rawResults) {
								const resolvedSummary = resolveSummaryForSubmit(payload, collected);
								base.workflow = "summary-review";
								base.approvedSummary = resolvedSummary.approvedSummary;
								base.summaryMeta = resolvedSummary.summaryMeta;
							}
							sendFollowUpFromReturn(buildSearchReturn(base));
							closeCurator();
						},
						onCancel(reason) {
							if (commandHandle && state.activeCurator !== commandHandle) return;
							aborted = true;
							searchAbort.abort();
							if (reason === "timeout") {
								const all = collectAllResultsAndUrls(collected);
								const resolvedSummary = resolveSummaryForSubmit(
									{ selectedQueryIndices: [], summary: undefined, summaryMeta: undefined },
									collected,
								);
								sendFollowUpFromReturn(
									buildSearchReturn({
										queryList: all.results.map((r) => r.query),
										results: all.results,
										urls: all.urls,
										includeContent: false,
										curated: true,
										curatedFrom: collected.size,
										workflow: "summary-review",
										approvedSummary: resolvedSummary.approvedSummary,
										summaryMeta: resolvedSummary.summaryMeta,
									}),
								);
							}
							closeCurator();
						},
						onProviderChange(provider) {
							if (commandHandle && state.activeCurator !== commandHandle) return;
							const normalized = normalizeProviderInput(provider);
							if (!normalized || normalized === "auto") return;
							currentProvider = normalized;
							try {
								saveConfig({ provider: normalized });
							} catch (err) {
								const _message = err instanceof Error ? err.message : String(err);
							}
						},
						async onAddSearch(query, queryIndex, provider) {
							if (commandHandle && state.activeCurator !== commandHandle) {
								throw new Error("Curator session is no longer active.");
							}
							const normalizedProvider = normalizeProviderInput(provider);
							const requestedProvider =
								!normalizedProvider || normalizedProvider === "auto" ? currentProvider : normalizedProvider;
							try {
								const {
									answer,
									results,
									provider: actualProvider,
								} = await search(query, {
									provider: requestedProvider,
									signal: searchAbort.signal,
								});
								if (commandHandle && state.activeCurator !== commandHandle) {
									throw new Error("Curator session is no longer active.");
								}
								collected.set(queryIndex, { query, answer, results, error: null, provider: actualProvider });
								return {
									answer,
									results: results.map((r) => ({ title: r.title, url: r.url, domain: extractDomain(r.url) })),
									provider: actualProvider,
								};
							} catch (err) {
								const message = err instanceof Error ? err.message : String(err);
								if (!commandHandle || state.activeCurator === commandHandle) {
									collected.set(queryIndex, {
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
							if (commandHandle && state.activeCurator !== commandHandle) {
								throw new Error("Curator session is no longer active.");
							}
							return rewriteSearchQuery(query, summaryContext, rewriteSignal);
						},
					},
				);

				if (!ownsCuratorStartup()) {
					handle.close();
					return;
				}
				commandHandle = handle;
				state.activeCurator = handle;
				const open = platform() === "darwin" ? await getGlimpseOpen() : null;
				if (!ownsCuratorStartup()) return;
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
					} catch (err) {
						const _message = err instanceof Error ? err.message : String(err);
						state.glimpseWin = null;
						await openInBrowser(pi, handle.url);
					}
				} else {
					await openInBrowser(pi, handle.url);
				}

				if (queries.length > 0) {
					// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: initial curator searches are streamed sequentially to preserve ordering and active-session guards.
					(async () => {
						for (let qi = 0; qi < queries.length; qi++) {
							if (aborted || state.activeCurator !== handle) break;
							const requestedProvider = currentProvider;
							try {
								const { answer, results, provider } = await search(queries[qi], {
									provider: requestedProvider,
									signal: searchAbort.signal,
								});
								if (aborted || state.activeCurator !== handle) break;
								handle.pushResult(qi, {
									answer,
									results: results.map((r) => ({ title: r.title, url: r.url, domain: extractDomain(r.url) })),
									provider,
								});
								collected.set(qi, { query: queries[qi], answer, results, error: null, provider });
							} catch (err) {
								if (aborted || state.activeCurator !== handle) break;
								const message = err instanceof Error ? err.message : String(err);
								handle.pushError(qi, message, requestedProvider);
								collected.set(qi, {
									query: queries[qi],
									answer: "",
									results: [],
									error: message,
									provider: requestedProvider,
								});
							}
						}
						if (!aborted && state.activeCurator === handle) handle.searchesDone();
					})();
				} else {
					if (state.activeCurator === handle) handle.searchesDone();
				}
			} catch (err) {
				if (!ownsCuratorStartup()) return;
				closeCurator();
				const message = err instanceof Error ? err.message : String(err);
				ctx.ui.notify(`Failed to open curator: ${message}`, "error");
			}
		},
	});

	pi.registerCommand("curator", {
		description: "Toggle or configure the search curator workflow",
		handler: async (args, ctx) => {
			const arg = args.trim().toLowerCase();

			let newWorkflow: WebSearchWorkflow;
			if (arg.length === 0) {
				const current = resolveWorkflow(loadConfigForExtensionInit().workflow, true);
				newWorkflow = current === "none" ? "summary-review" : "none";
			} else if (arg === "on") {
				newWorkflow = "summary-review";
			} else if (arg === "off") {
				newWorkflow = "none";
			} else if (arg === "none" || arg === "summary-review") {
				newWorkflow = arg;
			} else {
				ctx.ui.notify(`Unknown option: ${arg}. Use on, off, or summary-review.`, "error");
				return;
			}

			try {
				saveConfig({ workflow: newWorkflow });
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				ctx.ui.notify(`Failed to save config: ${message}`, "error");
				return;
			}

			const label =
				newWorkflow === "none"
					? "Curator disabled — web_search will return raw results"
					: "Curator enabled — web_search will open curator and auto-generate a summary draft";
			pi.sendMessage(
				{
					customType: "curator-config",
					content: [{ type: "text", text: label }],
					display: true,
					details: { workflow: newWorkflow },
				},
				{ triggerTurn: false, deliverAs: "followUp" },
			);
		},
	});

	pi.registerCommand("google-account", {
		description: "Show the active Google account for Gemini Web",
		handler: async () => {
			const cookies = await isGeminiWebAvailable();
			if (!cookies) {
				pi.sendMessage(
					{
						customType: "google-account",
						content: [
							{
								type: "text",
								text: "Gemini Web is unavailable. Sign into gemini.google.com in a supported Chromium-based browser.",
							},
						],
						display: true,
						details: { available: false },
					},
					{ triggerTurn: true, deliverAs: "followUp" },
				);
				return;
			}

			const email = await getActiveGoogleEmail(cookies);
			const text = email
				? `Active Google account: ${email}`
				: "Gemini Web is available, but the active Google account could not be determined.";

			pi.sendMessage(
				{
					customType: "google-account",
					content: [{ type: "text", text }],
					display: true,
					details: { available: true, email: email ?? null },
				},
				{ triggerTurn: true, deliverAs: "followUp" },
			);
		},
	});

	pi.registerCommand("search", {
		description: "Browse stored web search results",
		// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: stored-result browsing handles mixed search/fetch entries and detail previews in one interactive flow.
		handler: async (_args, ctx) => {
			const results = getAllResults();

			if (results.length === 0) {
				ctx.ui.notify("No stored search results", "info");
				return;
			}

			const options = results.map((r) => {
				const age = Math.floor((Date.now() - r.timestamp) / 60000);
				const ageStr = age < 60 ? `${age}m ago` : `${Math.floor(age / 60)}h ago`;
				if (r.type === "search" && r.queries) {
					const query = r.queries[0]?.query || "unknown";
					return `[${r.id.slice(0, 6)}] "${query}" (${r.queries.length} queries) - ${ageStr}`;
				}
				if (r.type === "fetch" && r.urls) {
					return `[${r.id.slice(0, 6)}] ${r.urls.length} URLs fetched - ${ageStr}`;
				}
				return `[${r.id.slice(0, 6)}] ${r.type} - ${ageStr}`;
			});

			const choice = await ctx.ui.select("Stored Search Results", options);
			if (!choice) return;

			const match = choice.match(/^\[([a-z0-9]+)\]/);
			if (!match) return;

			const selected = results.find((r) => r.id.startsWith(match[1]));
			if (!selected) return;

			const actions = ["View details", "Delete"];
			const action = await ctx.ui.select(`Result ${selected.id.slice(0, 6)}`, actions);

			if (action === "Delete") {
				deleteResult(selected.id);
				ctx.ui.notify(`Deleted ${selected.id.slice(0, 6)}`, "info");
			} else if (action === "View details") {
				let info = `ID: ${selected.id}\nType: ${selected.type}\nAge: ${Math.floor((Date.now() - selected.timestamp) / 60000)}m\n\n`;
				if (selected.type === "search" && selected.queries) {
					info += "Queries:\n";
					const queries = selected.queries.slice(0, 10);
					for (const q of queries) {
						info += `- "${q.query}" (${q.results.length} results)\n`;
					}
					if (selected.queries.length > 10) {
						info += `... and ${selected.queries.length - 10} more\n`;
					}
				}
				if (selected.type === "fetch" && selected.urls) {
					info += "URLs:\n";
					const urls = selected.urls.slice(0, 10);
					for (const u of urls) {
						const urlDisplay = u.url.length > 50 ? `${u.url.slice(0, 47)}...` : u.url;
						info += `- ${urlDisplay} (${u.error || `${u.content.length} chars`})\n`;
					}
					if (selected.urls.length > 10) {
						info += `... and ${selected.urls.length - 10} more\n`;
					}
				}
				ctx.ui.notify(info, "info");
			}
		},
	});
}
