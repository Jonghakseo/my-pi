#!/usr/bin/env node --experimental-strip-types

/**
 * Standalone script to generate embeddings for all indexed sessions.
 * Run: node --experimental-strip-types extensions/session-rag/embed-all.ts
 *
 * This can take 30+ minutes for ~4000 sessions on first run.
 */

import { homedir } from "node:os";
import { join } from "node:path";
import { getEmbeddedCount, getTotalSessionCount, openDb } from "./db.ts";
import { embedMissingSessions } from "./embeddings.ts";
import { indexSessions } from "./indexer.ts";

const PI_DIR = join(homedir(), ".pi", "agent");
const SESSIONS_DIR = join(PI_DIR, "sessions");
const DB_PATH = join(PI_DIR, ".data", "session-rag", "sessions.sqlite");

async function main() {
	const db = openDb(DB_PATH);
	const _idxResult = indexSessions(db, SESSIONS_DIR, {
		onProgress: (c, t) => {
			if (c % 500 === 0 || c === t) process.stdout.write(`\r  ${c}/${t}`);
		},
	});

	// Step 2: Generate embeddings
	const embeddedBefore = getEmbeddedCount(db);
	const total = getTotalSessionCount(db);

	if (embeddedBefore >= total) {
		db.close();
		return;
	}

	const startTime = Date.now();
	const _result = await embedMissingSessions(db, {
		onProgress: (current, t) => {
			const elapsed = ((Date.now() - startTime) / 1000).toFixed(0);
			const rate = current > 0 ? (current / ((Date.now() - startTime) / 1000)).toFixed(1) : "0";
			process.stdout.write(`\r  ${current}/${t} (${elapsed}s, ${rate}/s)`);
		},
	});

	const _totalTime = ((Date.now() - startTime) / 1000).toFixed(1);

	db.close();
}

main().catch((_e) => {
	process.exit(1);
});
