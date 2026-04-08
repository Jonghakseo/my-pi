/**
 * session-rag — Pi extension for session search via BM25 + vector RAG
 *
 * Tools:
 *   - search_session: Hybrid search over past Pi sessions by user messages
 *   - index_sessions: Re-index session files (incremental) + generate embeddings
 *
 * Data stored at: ~/.pi/agent/.data/session-rag/sessions.sqlite
 */

import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import type BetterSqlite3 from "better-sqlite3";

import { getEmbeddedCount, getTotalSessionCount, openDb } from "./db.ts";
import { embedMissingSessions } from "./embeddings.ts";
import { indexSessions } from "./indexer.ts";
import { hybridSearch } from "./search.ts";

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const PI_DIR = join(homedir(), ".pi", "agent");
const SESSIONS_DIR = join(PI_DIR, "sessions");
const DATA_DIR = join(PI_DIR, ".data", "session-rag");
const DB_PATH = join(DATA_DIR, "sessions.sqlite");

// ---------------------------------------------------------------------------
// Lazy DB singleton
// ---------------------------------------------------------------------------

let _db: BetterSqlite3.Database | null = null;
function getDb(): BetterSqlite3.Database {
	if (!_db) _db = openDb(DB_PATH);
	return _db;
}

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

export default function sessionRagExtension(pi: ExtensionAPI): void {
	// --- search_session tool ---
	pi.registerTool({
		name: "search_session",
		label: "Search Sessions",
		description:
			"Search past Pi coding sessions using hybrid BM25 keyword + vector semantic search. " +
			"Finds sessions by matching user messages. Returns session ID, name, date, working directory, " +
			"and a snippet of matching messages. Use this when the user wants to find a previous session.",
		promptSnippet: "search_session — Find past Pi sessions by keyword/semantic search over user messages",
		parameters: Type.Object({
			query: Type.String({
				description:
					"Search query — natural language or keywords. Examples: 'CC 온보딩 자료', 'refund stripe bug fix', 'admin editor 작업'",
			}),
			limit: Type.Optional(
				Type.Number({
					description: "Max results to return (default: 10)",
					default: 10,
				}),
			),
			after: Type.Optional(
				Type.String({
					description: "Only sessions after this ISO date (e.g. '2026-04-01')",
				}),
			),
			before: Type.Optional(
				Type.String({
					description: "Only sessions before this ISO date (e.g. '2026-04-07')",
				}),
			),
			bm25_only: Type.Optional(
				Type.Boolean({
					description: "Skip vector search for faster results (BM25 keyword only). Default: false",
					default: false,
				}),
			),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const {
				query,
				limit = 10,
				after,
				before,
				bm25_only: bm25Only = false,
			} = params as {
				query: string;
				limit?: number;
				after?: string;
				before?: string;
				bm25_only?: boolean;
			};

			try {
				const db = getDb();

				// Auto-index if empty
				const count = getTotalSessionCount(db);
				if (count === 0) {
					const idxResult = indexSessions(db, SESSIONS_DIR);
					if (ctx.hasUI) {
						ctx.ui.notify(`Auto-indexed ${idxResult.indexed} sessions`, "info");
					}
				}

				const results = await hybridSearch(db, {
					query,
					limit,
					after,
					before,
					bm25Only,
				});

				if (results.length === 0) {
					return {
						content: [
							{
								type: "text" as const,
								text: `No sessions found for "${query}"`,
							},
						],
						details: { results: [], total: count },
					};
				}

				const lines: string[] = [`Found ${results.length} session(s) for "${query}":`, ""];

				for (const r of results) {
					const date = r.started_at
						? new Date(r.started_at).toLocaleDateString("ko-KR", {
								year: "numeric",
								month: "2-digit",
								day: "2-digit",
								weekday: "short",
							})
						: "unknown";
					const name = r.name || "(unnamed)";
					const cwdShort = r.cwd.replace(homedir(), "~");
					const score = Math.round(r.score * 1000) / 1000;
					const sources = r.sources.join("+");

					lines.push(`### ${name}`);
					lines.push(`- ID: ${r.id} | Date: ${date} | Score: ${score} (${sources})`);
					lines.push(`- CWD: ${cwdShort}`);
					lines.push(`- Snippet: ${r.snippet}`);
					lines.push("");
				}

				return {
					content: [{ type: "text" as const, text: lines.join("\n") }],
					details: {
						results: results.map((r) => ({
							id: r.id,
							name: r.name,
							cwd: r.cwd,
							started_at: r.started_at,
							score: r.score,
							sources: r.sources,
						})),
					},
				};
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				return {
					content: [
						{
							type: "text" as const,
							text: `Search error: ${msg}`,
						},
					],
					details: { error: msg },
				};
			}
		},
	});

	// --- index_sessions tool ---
	pi.registerTool({
		name: "index_sessions",
		label: "Index Sessions",
		description:
			"Re-index Pi session files and generate embeddings for vector search. " +
			"Incremental — only processes new or changed sessions. " +
			"Run this to update the search index after new sessions are created.",
		parameters: Type.Object({
			embed: Type.Optional(
				Type.Boolean({
					description: "Generate vector embeddings after indexing (slower but enables semantic search). Default: true",
					default: true,
				}),
			),
		}),
		async execute(_toolCallId, params, _signal, onUpdate, ctx) {
			const { embed = true } = params as { embed?: boolean };

			try {
				const db = getDb();

				// 1. Index JSONL files
				const idxResult = indexSessions(db, SESSIONS_DIR, {
					onProgress: (current, total) => {
						if (current % 200 === 0 || current === total) {
							onUpdate?.({
								content: [{ type: "text" as const, text: `Indexing: ${current}/${total} files...` }],
								details: { phase: "indexing", current, total },
							});
						}
					},
				});

				const totalCount = getTotalSessionCount(db);
				const lines: string[] = [
					`Indexing complete:`,
					`- Total files scanned: ${idxResult.total}`,
					`- Newly indexed: ${idxResult.indexed}`,
					`- Skipped (unchanged): ${idxResult.skipped}`,
					`- Errors: ${idxResult.errors}`,
					`- Total sessions in DB: ${totalCount}`,
				];

				// 2. Embed if requested
				if (embed) {
					onUpdate?.({
						content: [{ type: "text" as const, text: "Generating embeddings (first run downloads ~250MB model)..." }],
						details: { phase: "embedding_start" },
					});

					const embedResult = await embedMissingSessions(db, {
						onProgress: (current, total) => {
							if (current % 50 === 0 || current === total) {
								onUpdate?.({
									content: [{ type: "text" as const, text: `Embedding: ${current}/${total} sessions...` }],
									details: { phase: "embedding", current, total },
								});
							}
						},
					});

					const embeddedTotal = getEmbeddedCount(db);
					lines.push("");
					lines.push("Embedding:");
					lines.push(`- Newly embedded: ${embedResult.embedded}`);
					lines.push(`- Errors: ${embedResult.errors}`);
					lines.push(`- Total with embeddings: ${embeddedTotal}/${totalCount}`);
				}

				if (ctx.hasUI) {
					ctx.ui.notify(`Indexed ${idxResult.indexed} new sessions`, "info");
				}

				return {
					content: [{ type: "text" as const, text: lines.join("\n") }],
					details: {
						indexResult: idxResult,
						totalSessions: totalCount,
					},
				};
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				return {
					content: [
						{
							type: "text" as const,
							text: `Indexing error: ${msg}`,
						},
					],
					details: { error: msg },
				};
			}
		},
	});

	// Cleanup on shutdown
	pi.on("session_shutdown", () => {
		if (_db) {
			try {
				_db.close();
			} catch {}
			_db = null;
		}
	});
}
