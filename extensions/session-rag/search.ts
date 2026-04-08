/**
 * session-rag/search.ts — Hybrid BM25 + vector search with RRF fusion
 *
 * Inspired by qmd's reciprocal rank fusion approach.
 */

import type Database from "better-sqlite3";
import { getAllEmbeddings, searchBM25, type VectorCandidate } from "./db.ts";
import { cosineSimilarity, EMBEDDING_DIM, embedQuery } from "./embeddings.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SearchResult {
	id: string;
	name: string | null;
	cwd: string;
	started_at: string;
	score: number;
	snippet: string;
	sources: string[]; // which backends contributed: "bm25" | "vector"
}

export interface SearchOptions {
	query: string;
	limit?: number;
	after?: string;
	before?: string;
	/** Skip vector search (faster, BM25 only) */
	bm25Only?: boolean;
}

// ---------------------------------------------------------------------------
// RRF (Reciprocal Rank Fusion) — adapted from qmd
// ---------------------------------------------------------------------------

interface RankedItem {
	id: string;
	name: string | null;
	cwd: string;
	started_at: string;
	user_messages: string;
	backendScore: number;
}

function reciprocalRankFusion(
	resultLists: RankedItem[][],
	weights: number[] = [],
	k = 60,
): { id: string; rrfScore: number; item: RankedItem; sources: number[] }[] {
	const scores = new Map<string, { item: RankedItem; rrfScore: number; topRank: number; sources: number[] }>();

	for (let listIdx = 0; listIdx < resultLists.length; listIdx++) {
		const list = resultLists[listIdx];
		if (!list) continue;
		const weight = weights[listIdx] ?? 1.0;

		for (let rank = 0; rank < list.length; rank++) {
			const item = list[rank];
			if (!item) continue;
			const rrfContribution = weight / (k + rank + 1);
			const existing = scores.get(item.id);

			if (existing) {
				existing.rrfScore += rrfContribution;
				existing.topRank = Math.min(existing.topRank, rank);
				existing.sources.push(listIdx);
			} else {
				scores.set(item.id, {
					item,
					rrfScore: rrfContribution,
					topRank: rank,
					sources: [listIdx],
				});
			}
		}
	}

	// Top-rank bonus (qmd pattern)
	for (const entry of scores.values()) {
		if (entry.topRank === 0) entry.rrfScore += 0.05;
		else if (entry.topRank <= 2) entry.rrfScore += 0.02;
	}

	return Array.from(scores.values())
		.sort((a, b) => b.rrfScore - a.rrfScore)
		.map((e) => ({
			id: e.item.id,
			rrfScore: e.rrfScore,
			item: e.item,
			sources: e.sources,
		}));
}

// ---------------------------------------------------------------------------
// Name derivation for unnamed sessions
// ---------------------------------------------------------------------------

/** Extract a short display name from the first user message. */
function deriveNameFromMessages(userMessages: string, maxLen = 60): string {
	// user_messages are joined by "\n---\n"; take the first message
	const first = userMessages.split("\n---\n")[0] ?? "";
	// Take first line only
	const line = first.split("\n")[0]?.trim() ?? "";
	if (!line) return "(unnamed)";
	if (line.length <= maxLen) return line;
	return `${line.slice(0, maxLen - 1)}…`;
}

// ---------------------------------------------------------------------------
// Snippet extraction
// ---------------------------------------------------------------------------

function extractSnippet(text: string, query: string, maxLen = 200): string {
	const lower = text.toLowerCase();
	const queryTerms = query.toLowerCase().split(/\s+/).filter(Boolean);

	// Find the best matching region
	let bestPos = 0;
	let bestScore = 0;
	const windowSize = maxLen;

	for (let i = 0; i < lower.length - windowSize; i += 50) {
		const window = lower.slice(i, i + windowSize);
		let score = 0;
		for (const term of queryTerms) {
			if (window.includes(term)) score++;
		}
		if (score > bestScore) {
			bestScore = score;
			bestPos = i;
		}
	}

	const start = Math.max(0, bestPos);
	const end = Math.min(text.length, start + maxLen);
	let snippet = text.slice(start, end).trim();

	if (start > 0) snippet = `…${snippet}`;
	if (end < text.length) snippet = `${snippet}…`;

	// Replace internal newlines with spaces for display
	snippet = snippet.replace(/\n---\n/g, " | ").replace(/\n+/g, " ");

	return snippet;
}

// ---------------------------------------------------------------------------
// FTS5 query sanitization
// ---------------------------------------------------------------------------

/**
 * Sanitize a user query for FTS5 MATCH.
 * FTS5 has special syntax (AND, OR, NOT, NEAR, quotes, parentheses, etc.)
 * that can cause errors if the user's natural-language query happens to
 * contain them.  We escape by:
 *   1. Stripping characters that are FTS5 operators/punctuation.
 *   2. Quoting each remaining token so terms like "OR" are literals.
 *   3. Joining with implicit AND (space in FTS5 = AND).
 *
 * If *every* token is empty after sanitization we return `null` to signal
 * "skip BM25 entirely" rather than throwing.
 */
function sanitizeFtsQuery(raw: string): string | null {
	// Remove characters that have special meaning in FTS5
	const cleaned = raw.replace(/[*"(){}[\]:^~!@#$%&\\]/g, " ");
	const tokens = cleaned
		.split(/\s+/)
		.filter(Boolean)
		// Wrap each token in double-quotes → treated as literal phrase token
		.map((t) => `"${t}"`);
	return tokens.length > 0 ? tokens.join(" ") : null;
}

// ---------------------------------------------------------------------------
// Main search
// ---------------------------------------------------------------------------

export async function hybridSearch(db: Database.Database, opts: SearchOptions): Promise<SearchResult[]> {
	const { query, limit = 10, after, before, bm25Only = false } = opts;
	const sourceLabels = ["bm25", "vector"];

	// 1. BM25 search
	const bm25Results: RankedItem[] = [];
	const ftsQuery = sanitizeFtsQuery(query);
	if (ftsQuery) {
		try {
			const raw = searchBM25(db, ftsQuery, { limit: limit * 3, after, before });
			for (const r of raw) {
				bm25Results.push({
					id: r.id,
					name: r.name,
					cwd: r.cwd,
					started_at: r.started_at,
					user_messages: r.user_messages,
					backendScore: Math.abs(r.bm25_score) / (1 + Math.abs(r.bm25_score)),
				});
			}
		} catch {
			// FTS5 query syntax error — skip BM25
		}
	}

	// 2. Vector search (if enabled)
	const vectorResults: RankedItem[] = [];
	if (!bm25Only) {
		try {
			const queryEmbedding = await embedQuery(query);
			const candidates = getAllEmbeddings(db, { after, before });

			const scored: { candidate: VectorCandidate; similarity: number }[] = [];
			for (const c of candidates) {
				const vec = new Float32Array(c.embedding.buffer, c.embedding.byteOffset, c.embedding.byteLength / 4);
				if (vec.length !== EMBEDDING_DIM) continue;
				const sim = cosineSimilarity(queryEmbedding, vec);
				scored.push({ candidate: c, similarity: sim });
			}

			scored.sort((a, b) => b.similarity - a.similarity);

			for (const s of scored.slice(0, limit * 3)) {
				vectorResults.push({
					id: s.candidate.id,
					name: s.candidate.name,
					cwd: s.candidate.cwd,
					started_at: s.candidate.started_at,
					user_messages: s.candidate.user_messages,
					backendScore: s.similarity,
				});
			}
		} catch {
			// Embedding model not ready — fall back to BM25 only
		}
	}

	// 3. RRF fusion
	const resultLists = [bm25Results, vectorResults].filter((l) => l.length > 0);
	const weights = resultLists.length === 2 ? [1.0, 1.0] : [1.0];

	if (resultLists.length === 0) return [];

	const fused = reciprocalRankFusion(resultLists, weights);

	return fused.slice(0, limit).map((f) => ({
		id: f.item.id,
		name: f.item.name ?? deriveNameFromMessages(f.item.user_messages),
		cwd: f.item.cwd,
		started_at: f.item.started_at,
		score: f.rrfScore,
		snippet: extractSnippet(f.item.user_messages, query),
		sources: f.sources.map((i) => sourceLabels[i] || "unknown"),
	}));
}
