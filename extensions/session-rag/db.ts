/**
 * session-rag/db.ts — SQLite schema + CRUD for session search index
 *
 * Uses better-sqlite3 with FTS5 for BM25 keyword search.
 * Embeddings stored as BLOBs for vector cosine similarity.
 */

import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SCHEMA_VERSION = 1;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SessionRow {
	id: string;
	name: string | null;
	cwd: string;
	started_at: string;
	dir_name: string;
	file_name: string;
	user_messages: string;
	file_mtime: number;
	embedding: Buffer | null;
}

export interface SessionInsert {
	id: string;
	name: string | null;
	cwd: string;
	started_at: string;
	dir_name: string;
	file_name: string;
	user_messages: string;
	file_mtime: number;
}

// ---------------------------------------------------------------------------
// Database initialization
// ---------------------------------------------------------------------------

export function openDb(dbPath: string): Database.Database {
	mkdirSync(dirname(dbPath), { recursive: true });
	const db = new Database(dbPath);

	db.pragma("journal_mode = WAL");
	db.pragma("foreign_keys = ON");

	// Schema version check
	const versionRow = (() => {
		try {
			return db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as { value: string } | undefined;
		} catch {
			return undefined;
		}
	})();

	const currentVersion = versionRow ? Number.parseInt(versionRow.value, 10) : 0;

	if (currentVersion < SCHEMA_VERSION) {
		createSchema(db);
	}

	return db;
}

function createSchema(db: Database.Database): void {
	db.exec(`
    CREATE TABLE IF NOT EXISTS meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    )
  `);

	db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      name TEXT,
      cwd TEXT NOT NULL,
      started_at TEXT NOT NULL,
      dir_name TEXT NOT NULL,
      file_name TEXT NOT NULL,
      user_messages TEXT NOT NULL,
      file_mtime REAL NOT NULL,
      embedding BLOB
    )
  `);

	db.exec(`CREATE INDEX IF NOT EXISTS idx_sessions_started ON sessions(started_at)`);
	db.exec(`CREATE INDEX IF NOT EXISTS idx_sessions_dir ON sessions(dir_name)`);

	// FTS5 for BM25 keyword search
	// tokenize: unicode61 handles Korean/CJK, porter adds stemming for English
	db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS sessions_fts USING fts5(
      name, user_messages, cwd,
      content=sessions,
      content_rowid=rowid,
      tokenize='unicode61'
    )
  `);

	// Triggers to keep FTS in sync
	db.exec(`
    CREATE TRIGGER IF NOT EXISTS sessions_ai AFTER INSERT ON sessions
    BEGIN
      INSERT INTO sessions_fts(rowid, name, user_messages, cwd)
      VALUES (new.rowid, COALESCE(new.name, ''), new.user_messages, new.cwd);
    END
  `);

	db.exec(`
    CREATE TRIGGER IF NOT EXISTS sessions_ad AFTER DELETE ON sessions
    BEGIN
      INSERT INTO sessions_fts(sessions_fts, rowid, name, user_messages, cwd)
      VALUES ('delete', old.rowid, COALESCE(old.name, ''), old.user_messages, old.cwd);
    END
  `);

	db.exec(`
    CREATE TRIGGER IF NOT EXISTS sessions_au AFTER UPDATE ON sessions
    BEGIN
      INSERT INTO sessions_fts(sessions_fts, rowid, name, user_messages, cwd)
      VALUES ('delete', old.rowid, COALESCE(old.name, ''), old.user_messages, old.cwd);
      INSERT INTO sessions_fts(rowid, name, user_messages, cwd)
      VALUES (new.rowid, COALESCE(new.name, ''), new.user_messages, new.cwd);
    END
  `);

	db.prepare("INSERT OR REPLACE INTO meta(key, value) VALUES ('schema_version', ?)").run(String(SCHEMA_VERSION));
}

// ---------------------------------------------------------------------------
// CRUD operations
// ---------------------------------------------------------------------------

export function upsertSession(db: Database.Database, session: SessionInsert): void {
	db.prepare(`
    INSERT INTO sessions (id, name, cwd, started_at, dir_name, file_name, user_messages, file_mtime)
    VALUES (@id, @name, @cwd, @started_at, @dir_name, @file_name, @user_messages, @file_mtime)
    ON CONFLICT(id) DO UPDATE SET
      name = excluded.name,
      cwd = excluded.cwd,
      user_messages = excluded.user_messages,
      file_mtime = excluded.file_mtime
  `).run(session);
}

export function getSessionMtimes(db: Database.Database): Map<string, number> {
	const rows = db.prepare("SELECT id, file_mtime FROM sessions").all() as {
		id: string;
		file_mtime: number;
	}[];
	return new Map(rows.map((r) => [r.id, r.file_mtime]));
}

export function getSessionsWithoutEmbedding(
	db: Database.Database,
): { id: string; user_messages: string; name: string | null }[] {
	return db.prepare("SELECT id, user_messages, name FROM sessions WHERE embedding IS NULL").all() as {
		id: string;
		user_messages: string;
		name: string | null;
	}[];
}

export function updateEmbedding(db: Database.Database, id: string, embedding: Buffer): void {
	db.prepare("UPDATE sessions SET embedding = ? WHERE id = ?").run(embedding, id);
}

export function updateEmbeddingsBatch(db: Database.Database, updates: { id: string; embedding: Buffer }[]): void {
	const stmt = db.prepare("UPDATE sessions SET embedding = ? WHERE id = ?");
	const run = db.transaction((items: { id: string; embedding: Buffer }[]) => {
		for (const { id, embedding } of items) {
			stmt.run(embedding, id);
		}
	});
	run(updates);
}

export function getTotalSessionCount(db: Database.Database): number {
	return (db.prepare("SELECT COUNT(*) as count FROM sessions").get() as { count: number }).count;
}

export function getEmbeddedCount(db: Database.Database): number {
	return (
		db.prepare("SELECT COUNT(*) as count FROM sessions WHERE embedding IS NOT NULL").get() as {
			count: number;
		}
	).count;
}

// ---------------------------------------------------------------------------
// BM25 search
// ---------------------------------------------------------------------------

export interface BM25Result {
	id: string;
	name: string | null;
	cwd: string;
	started_at: string;
	user_messages: string;
	bm25_score: number;
}

export function searchBM25(
	db: Database.Database,
	query: string,
	opts: { limit?: number; after?: string; before?: string } = {},
): BM25Result[] {
	const { limit = 20, after, before } = opts;

	let sql = `
    SELECT
      s.id, s.name, s.cwd, s.started_at, s.user_messages,
      bm25(sessions_fts, 4.0, 1.0, 0.5) as bm25_score
    FROM sessions_fts f
    JOIN sessions s ON s.rowid = f.rowid
    WHERE sessions_fts MATCH ?
  `;

	const params: (string | number)[] = [query];

	if (after) {
		sql += " AND s.started_at >= ?";
		params.push(after);
	}
	if (before) {
		sql += " AND s.started_at <= ?";
		params.push(before);
	}

	sql += " ORDER BY bm25_score ASC LIMIT ?";
	params.push(limit);

	return db.prepare(sql).all(...params) as BM25Result[];
}

// ---------------------------------------------------------------------------
// Vector search (cosine similarity in JS)
// ---------------------------------------------------------------------------

export interface VectorCandidate {
	id: string;
	name: string | null;
	cwd: string;
	started_at: string;
	user_messages: string;
	embedding: Buffer;
}

export function getAllEmbeddings(
	db: Database.Database,
	opts: { after?: string; before?: string } = {},
): VectorCandidate[] {
	const { after, before } = opts;

	let sql = "SELECT id, name, cwd, started_at, user_messages, embedding FROM sessions WHERE embedding IS NOT NULL";
	const params: string[] = [];

	if (after) {
		sql += " AND started_at >= ?";
		params.push(after);
	}
	if (before) {
		sql += " AND started_at <= ?";
		params.push(before);
	}

	return db.prepare(sql).all(...params) as VectorCandidate[];
}
