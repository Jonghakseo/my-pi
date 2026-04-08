/**
 * session-rag/embeddings.ts — Local embedding via fastembed (ONNX)
 *
 * Uses intfloat/multilingual-e5-large for Korean+English support.
 * Model downloads on first use (~250MB quantized ONNX).
 * Embeddings are 1024-dimensional.
 */

import type Database from "better-sqlite3";
import { EmbeddingModel, FlagEmbedding } from "fastembed";
import { getSessionsWithoutEmbedding, updateEmbeddingsBatch } from "./db.ts";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const EMBEDDING_DIM = 1024;
export const EMBEDDING_MODEL = EmbeddingModel.MLE5Large;
const BATCH_SIZE = 32;

// ---------------------------------------------------------------------------
// Singleton model instance (lazy init)
// ---------------------------------------------------------------------------

let _model: FlagEmbedding | null = null;

async function getModel(): Promise<FlagEmbedding> {
	if (!_model) {
		_model = await FlagEmbedding.init({
			model: EMBEDDING_MODEL,
			maxLength: 512,
			showDownloadProgress: true,
		});
	}
	return _model;
}

// ---------------------------------------------------------------------------
// Embed a single query
// ---------------------------------------------------------------------------

export async function embedQuery(text: string): Promise<Float32Array> {
	const model = await getModel();
	const embedding = await model.queryEmbed(text);
	return new Float32Array(embedding);
}

// ---------------------------------------------------------------------------
// Embed all sessions that don't have embeddings yet
// ---------------------------------------------------------------------------

export interface EmbedResult {
	total: number;
	embedded: number;
	errors: number;
}

export async function embedMissingSessions(
	db: Database.Database,
	opts: { onProgress?: (current: number, total: number) => void } = {},
): Promise<EmbedResult> {
	const missing = getSessionsWithoutEmbedding(db);
	const result: EmbedResult = { total: missing.length, embedded: 0, errors: 0 };

	if (missing.length === 0) return result;

	const model = await getModel();

	// Process in batches
	for (let i = 0; i < missing.length; i += BATCH_SIZE) {
		const batch = missing.slice(i, i + BATCH_SIZE);
		opts.onProgress?.(i, missing.length);

		// Prepare texts for embedding: combine name + user messages
		const texts = batch.map((s) => {
			const parts: string[] = [];
			if (s.name) parts.push(s.name);
			// Truncate user_messages to ~2000 chars for embedding
			const msg = s.user_messages.length > 2000 ? s.user_messages.slice(0, 2000) : s.user_messages;
			parts.push(msg);
			return `passage: ${parts.join("\n")}`;
		});

		try {
			const embeddings: number[][] = [];
			const embeddingGen = model.embed(texts, BATCH_SIZE);
			for await (const batchResult of embeddingGen) {
				embeddings.push(...batchResult);
			}

			const updates: { id: string; embedding: Buffer }[] = [];
			for (let j = 0; j < batch.length; j++) {
				const embedding = embeddings[j];
				if (!embedding) {
					result.errors++;
					continue;
				}
				const buf = Buffer.from(new Float32Array(embedding).buffer);
				updates.push({ id: batch[j].id, embedding: buf });
			}

			updateEmbeddingsBatch(db, updates);
			result.embedded += updates.length;
		} catch {
			result.errors += batch.length;
		}
	}

	opts.onProgress?.(missing.length, missing.length);
	return result;
}

// ---------------------------------------------------------------------------
// Cosine similarity
// ---------------------------------------------------------------------------

export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
	let dot = 0;
	let normA = 0;
	let normB = 0;
	for (let i = 0; i < a.length; i++) {
		dot += a[i] * b[i];
		normA += a[i] * a[i];
		normB += b[i] * b[i];
	}
	const denom = Math.sqrt(normA) * Math.sqrt(normB);
	if (denom === 0) return 0;
	return dot / denom;
}
