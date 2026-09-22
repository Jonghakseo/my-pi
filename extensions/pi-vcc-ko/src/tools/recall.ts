import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { expandEntryFile, parseDrillDown } from "../core/drill-down.ts";
import { formatRecallOutput, formatTouchedOutput } from "../core/format-recall.ts";
import { getActiveLineageEntryIds } from "../core/lineage.ts";
import { loadAllMessages } from "../core/load-messages.ts";
import { normalizeRecallMode, normalizeRecallScope } from "../core/recall-scope.ts";
import { getTouchedFiles, searchEntriesDetailed } from "../core/search-entries.ts";

const DEFAULT_RECENT = 25;
const PAGE_SIZE = 5;

export const invalidExpandIndices = (requested: number[], available: Set<number>): number[] =>
	requested.filter((i) => !Number.isInteger(i) || !available.has(i));

export const registerRecallTool = (pi: ExtensionAPI) => {
	pi.registerTool({
		name: "vcc_recall",
		label: "VCC Recall",
		description:
			"Recall earlier parts of the current session — decisions made, files touched, commands run, " +
			"including anything dropped by compaction. Reach for this before telling the user you no longer " +
			"have the context. Plain keywords work best; a regex pattern is also accepted. Results are paged " +
			"(page); pass expand with entry indices to read full untruncated content. Use mode:'touched' to " +
			"list files worked on in this session with their entry indices, and #N:path to drill into a file's " +
			"content from an entry (#N:path:full for all lines). Note: apply_patch paths (inside the diff " +
			"payload) and bash redirects do not appear in the touched index. Only the current session is " +
			"searchable — earlier sessions are not.",
		promptSnippet:
			"vcc_recall: recall earlier parts of this session before saying the context is gone. " +
			"Plain keywords work best; scope:'all' widens to other conversation branches. " +
			"mode:'touched' lists files worked on; #N:path drills into a file's content from an entry.",
		parameters: Type.Object({
			query: Type.Optional(
				Type.String({
					description:
						"What to recall, in plain keywords (e.g. 'redis cache decision'). Multi-word queries are ranked by relevance. A regex pattern also works.",
				}),
			),
			expand: Type.Optional(
				Type.Array(Type.Number(), {
					description: "Entry indices to return full untruncated content for",
				}),
			),
			page: Type.Optional(
				Type.Number({
					description: "Page number (1-based) for paginated search results. Default: 1.",
				}),
			),
			scope: Type.Optional(
				Type.Union([Type.Literal("lineage"), Type.Literal("all")], {
					description:
						"Default 'lineage' covers the active conversation path. Use 'all' to also reach messages from other branches, such as turns that were edited or retried.",
				}),
			),
			mode: Type.Optional(
				Type.Union([Type.Literal("hybrid"), Type.Literal("touched")], {
					description:
						"What to show. hybrid (default) = normal search; touched = aggregated files-by-path with entry indices.",
				}),
			),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const sessionFile = ctx.sessionManager.getSessionFile();
			if (!sessionFile) {
				return {
					content: [{ type: "text", text: "No session file available." }],
					details: undefined,
				};
			}

			const scope = normalizeRecallScope(params.scope);
			const lineageEntryIds = scope === "lineage" ? getActiveLineageEntryIds(ctx.sessionManager) : undefined;

			// Drill-down: #N:path resolves to file-scoped tool content. Anchored so
			// inline mentions like "see #42:auth.ts" are never treated as drill-down.
			// Honors scope like every other recall path: the target entry must be on
			// the active lineage unless scope:'all'. Membership is checked against
			// global indices; expandEntryFile keeps loading unfiltered so #N stays
			// aligned with the global message index.
			const q = params.query?.trim();
			if (q && parseDrillDown(q)) {
				const parsed = parseDrillDown(q)!;
				if (lineageEntryIds) {
					const { rendered } = loadAllMessages(sessionFile, false, lineageEntryIds);
					if (!rendered.some((m) => m.index === parsed.index)) {
						return {
							content: [
								{
									type: "text",
									text: `Cannot expand indices outside active lineage: ${parsed.index}. Use scope:'all' to reach other branches.`,
								},
							],
							details: undefined,
						};
					}
				}
				const text = expandEntryFile(
					sessionFile,
					parsed.index,
					parsed.pathPattern,
					parsed.full,
					parsed.offset,
					parsed.limit,
				);
				return {
					content: [{ type: "text", text }],
					details: undefined,
				};
			}

			// touched mode: aggregate file operations across the live window.
			if (normalizeRecallMode(params.mode) === "touched") {
				const { rendered, rawMessages } = loadAllMessages(sessionFile, false, lineageEntryIds);
				const touched = getTouchedFiles(rawMessages, rendered);
				const text = formatTouchedOutput(touched, params.page);
				return {
					content: [{ type: "text", text }],
					details: undefined,
				};
			}

			const expandSet = new Set(params.expand ?? []);
			const hasExpand = expandSet.size > 0;

			if (hasExpand) {
				const { rendered: fullMsgs } = loadAllMessages(sessionFile, true, lineageEntryIds);
				const requested = [...expandSet];
				const byIndex = new Map(fullMsgs.map((m) => [m.index, m]));
				const invalid = invalidExpandIndices(requested, new Set(byIndex.keys()));
				if (invalid.length > 0) {
					return {
						content: [
							{
								type: "text",
								text: `Cannot expand indices outside ${scope === "all" ? "session history" : "active lineage"}: ${invalid.join(", ")}`,
							},
						],
						details: undefined,
					};
				}

				const expanded = requested.map((i) => byIndex.get(i)).filter((m): m is NonNullable<typeof m> => Boolean(m));
				const output = (scope === "all" ? "Scope: all\n\n" : "") + formatRecallOutput(expanded);
				return {
					content: [{ type: "text", text: output }],
					details: undefined,
				};
			}

			const { rendered: msgs, rawMessages } = loadAllMessages(sessionFile, false, lineageEntryIds);

			if (params.query?.trim()) {
				const { hits, totalBeforeCap, truncated } = searchEntriesDetailed(msgs, rawMessages, params.query);
				const page = Math.max(1, params.page ?? 1);
				// Single source of truth for page count: hits.length, the same array
				// that's actually paginated below (already floor-filtered and capped).
				const totalPages = Math.ceil(hits.length / PAGE_SIZE);
				const scopeSuffix = scope === "all" ? " (scope: all)" : "";
				// The hard cap can discard genuine matches; hits.length alone would
				// then understate the real total. Say so explicitly instead of
				// reporting the capped count as if it were everything. Neutral
				// wording ("showing", not "showing top"): regex-path hits are
				// boolean/chronological matches with no relevance score, so "top"
				// would falsely imply a ranking that only the BM25 path has.
				const truncationNote = truncated
					? ` — showing ${hits.length} of ${totalBeforeCap} matches, refine your query for more precise results`
					: "";

				// The hard cap creates a fixed reachable page range (1..totalPages).
				// A page beyond it isn't "no matches" — matches exist, the page just
				// isn't reachable. Say so explicitly instead of falling through to
				// formatRecallOutput's zero-hit message, which would be false here.
				if (hits.length > 0 && page > totalPages) {
					// truncationNote already ends in "...refine your query" when the
					// hard cap kicked in — don't repeat that suggestion here, just say
					// which pages exist. Only add "or refine your query" when there's
					// no truncation note to have said it already.
					const guidance = truncated
						? `Use a page between 1 and ${totalPages}.`
						: `Use a page between 1 and ${totalPages}, or refine your query.`;
					const text =
						`Page ${page} is outside the available range 1-${totalPages} ` +
						`(${hits.length} matches${scopeSuffix}${truncationNote}). ${guidance}`;
					return {
						content: [{ type: "text", text }],
						details: undefined,
					};
				}

				const start = (page - 1) * PAGE_SIZE;
				const pageResults = hits.slice(start, start + PAGE_SIZE);
				const header =
					totalPages > 1
						? `Page ${page}/${totalPages} (${hits.length} total matches${scopeSuffix}${truncationNote})`
						: `${hits.length} matches${scopeSuffix}${truncationNote}`;
				const footer =
					page < totalPages
						? `\n--- Use page:${page + 1}${scope === "all" ? " with scope:'all'" : ""} for more results ---`
						: "";
				const output = formatRecallOutput(pageResults, params.query, header) + footer;
				return {
					content: [{ type: "text", text: output }],
					details: undefined,
				};
			}

			const output =
				(scope === "all" ? "Scope: all\n\n" : "") + formatRecallOutput(msgs.slice(-DEFAULT_RECENT), params.query);
			return {
				content: [{ type: "text", text: output }],
				details: undefined,
			};
		},
	});
};
