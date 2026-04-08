/**
 * session-rag/indexer.ts — Parse Pi session JSONL files and index into SQLite
 *
 * Session JSONL format:
 *   Line 1: { type: "session", id, timestamp, cwd }
 *   ...     { type: "session_info", name }
 *   ...     { type: "message", message: { role: "user"|"assistant", content: [{type:"text",text}] } }
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { getSessionMtimes, type SessionInsert, upsertSession } from "./db.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface SessionMeta {
	type: "session";
	id: string;
	timestamp: string;
	cwd: string;
}

interface SessionInfo {
	type: "session_info";
	name: string;
}

interface MessageEntry {
	type: "message";
	timestamp: string;
	message: {
		role: string;
		content: string | { type: string; text: string }[];
	};
}

type JsonlEntry = SessionMeta | SessionInfo | MessageEntry | { type: string };

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

function extractTextFromContent(content: string | { type: string; text: string }[]): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((c) => c.type === "text" && c.text)
		.map((c) => c.text)
		.join("\n");
}

export interface ParsedSession {
	id: string;
	name: string | null;
	cwd: string;
	started_at: string;
	user_messages: string;
}

export function parseSessionFile(filePath: string): ParsedSession | null {
	let raw: string;
	try {
		raw = readFileSync(filePath, "utf-8");
	} catch {
		return null;
	}

	const lines = raw.split("\n").filter((l) => l.trim());
	if (lines.length === 0) return null;

	let id: string | null = null;
	let cwd = "";
	let started_at = "";
	let name: string | null = null;
	const userTexts: string[] = [];

	for (const line of lines) {
		let entry: JsonlEntry;
		try {
			entry = JSON.parse(line);
		} catch {
			continue;
		}

		if (entry.type === "session") {
			const s = entry as SessionMeta;
			id = s.id;
			cwd = s.cwd || "";
			started_at = s.timestamp || "";
		} else if (entry.type === "session_info") {
			const s = entry as SessionInfo;
			if (s.name) name = s.name;
		} else if (entry.type === "message") {
			const m = entry as MessageEntry;
			if (m.message?.role === "user") {
				const text = extractTextFromContent(m.message.content);
				if (text.trim()) userTexts.push(text.trim());
			}
		}
	}

	// Skip sessions with no user messages or no ID
	if (!id || userTexts.length === 0) return null;

	return {
		id,
		name,
		cwd,
		started_at,
		user_messages: userTexts.join("\n---\n"),
	};
}

// ---------------------------------------------------------------------------
// Indexer
// ---------------------------------------------------------------------------

export interface IndexResult {
	total: number;
	indexed: number;
	skipped: number;
	errors: number;
}

/**
 * Scan all session directories and index new/changed sessions.
 * Returns stats about what was processed.
 */
export function indexSessions(
	db: Database.Database,
	sessionsDir: string,
	opts: { onProgress?: (current: number, total: number) => void } = {},
): IndexResult {
	const result: IndexResult = { total: 0, indexed: 0, skipped: 0, errors: 0 };

	// Get existing mtimes for incremental indexing
	const existingMtimes = getSessionMtimes(db);

	// Collect all JSONL files
	const files: { dirName: string; fileName: string; fullPath: string; mtime: number }[] = [];

	let dirs: string[];
	try {
		dirs = readdirSync(sessionsDir);
	} catch {
		return result;
	}

	for (const dirName of dirs) {
		const dirPath = join(sessionsDir, dirName);
		let stat: ReturnType<typeof statSync> | undefined;
		try {
			stat = statSync(dirPath);
		} catch {
			continue;
		}
		if (!stat.isDirectory()) continue;

		let jsonlFiles: string[];
		try {
			jsonlFiles = readdirSync(dirPath).filter((f) => f.endsWith(".jsonl"));
		} catch {
			continue;
		}

		for (const fileName of jsonlFiles) {
			const fullPath = join(dirPath, fileName);
			let fileStat: ReturnType<typeof statSync> | undefined;
			try {
				fileStat = statSync(fullPath);
			} catch {
				continue;
			}
			files.push({
				dirName,
				fileName,
				fullPath,
				mtime: fileStat.mtimeMs,
			});
		}
	}

	result.total = files.length;

	// Process in a transaction for performance
	const transaction = db.transaction(
		(items: { dirName: string; fileName: string; fullPath: string; mtime: number }[]) => {
			for (let i = 0; i < items.length; i++) {
				const file = items[i];
				opts.onProgress?.(i + 1, items.length);

				// Extract session ID from filename (format: timestamp_uuid.jsonl)
				// We'll get the actual ID from parsing
				const parsed = parseSessionFile(file.fullPath);
				if (!parsed) {
					result.skipped++;
					continue;
				}

				// Check if already indexed with same mtime
				const existingMtime = existingMtimes.get(parsed.id);
				if (existingMtime !== undefined && Math.abs(existingMtime - file.mtime) < 1) {
					result.skipped++;
					continue;
				}

				try {
					const session: SessionInsert = {
						id: parsed.id,
						name: parsed.name,
						cwd: parsed.cwd,
						started_at: parsed.started_at,
						dir_name: file.dirName,
						file_name: file.fileName,
						user_messages: parsed.user_messages,
						file_mtime: file.mtime,
					};
					upsertSession(db, session);
					result.indexed++;
				} catch {
					result.errors++;
				}
			}
		},
	);

	transaction(files);
	return result;
}
