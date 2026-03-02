import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { MemoryRecord, MemoryScope } from "./types.ts";

// ── Paths ────────────────────────────────────────────────────────────────────

const MEMORY_BASE = path.join(os.homedir(), ".pi", "memory");
const USER_FILE = path.join(MEMORY_BASE, "user.json");
const PROJECTS_DIR = path.join(MEMORY_BASE, "projects");

function projectFilePath(projectId: string): string {
	// Sanitize projectId for use as filename
	const safe = projectId.replace(/[^a-zA-Z0-9_-]/g, "-");
	return path.join(PROJECTS_DIR, `${safe}.json`);
}

function filePath(scope: MemoryScope, projectId?: string): string {
	if (scope === "project" && projectId) return projectFilePath(projectId);
	return USER_FILE;
}

// ── Directory Setup ──────────────────────────────────────────────────────────

export async function ensureDir(): Promise<void> {
	await fs.mkdir(MEMORY_BASE, { recursive: true });
	await fs.mkdir(PROJECTS_DIR, { recursive: true });
}

// ── ID Generation ────────────────────────────────────────────────────────────

export function generateId(): string {
	return `mem_${crypto.randomBytes(4).toString("hex")}`;
}

// ── File Locking ─────────────────────────────────────────────────────────────

const LOCK_TTL_MS = 30_000; // 30 seconds — memory ops are fast
const LOCK_RETRY_MS = 50;
const LOCK_MAX_RETRIES = 10;

function lockPath(fp: string): string {
	return `${fp}.lock`;
}

/**
 * Acquire an exclusive file lock using O_EXCL (matches todos.ts pattern).
 * Stale locks (older than LOCK_TTL_MS) are automatically removed and retried.
 * Returns an async release function on success; throws on failure.
 */
async function acquireFileLock(fp: string): Promise<() => Promise<void>> {
	const lp = lockPath(fp);

	for (let attempt = 0; attempt < LOCK_MAX_RETRIES; attempt++) {
		try {
			const handle = await fs.open(lp, "wx");
			const info = { pid: process.pid, created_at: new Date().toISOString() };
			await handle.writeFile(JSON.stringify(info), "utf8");
			await handle.close();

			return async () => {
				await fs.unlink(lp).catch(() => {});
			};
		} catch (err: unknown) {
			const code = (err as NodeJS.ErrnoException)?.code;
			if (code !== "EEXIST") {
				throw new Error(`Failed to acquire memory lock: ${err instanceof Error ? err.message : "unknown"}`);
			}

			// Check if lock is stale
			const stats = await fs.stat(lp).catch(() => null);
			const lockAge = stats ? Date.now() - stats.mtimeMs : LOCK_TTL_MS + 1;

			if (lockAge > LOCK_TTL_MS) {
				// Stale lock — remove and retry immediately
				await fs.unlink(lp).catch(() => {});
				continue;
			}

			// Lock is fresh — wait before retrying
			await new Promise((r) => setTimeout(r, LOCK_RETRY_MS));
		}
	}

	throw new Error("Failed to acquire memory file lock after retries. Another process may be writing to the same file.");
}

/**
 * Execute fn while holding an exclusive file lock on fp.
 */
async function withFileLock<T>(fp: string, fn: () => Promise<T>): Promise<T> {
	const release = await acquireFileLock(fp);
	try {
		return await fn();
	} finally {
		await release();
	}
}

// ── Read/Write ───────────────────────────────────────────────────────────────

export async function loadMemories(scope: MemoryScope, projectId?: string): Promise<MemoryRecord[]> {
	const fp = filePath(scope, projectId);
	try {
		const raw = await fs.readFile(fp, "utf8");
		const parsed = JSON.parse(raw);
		if (!Array.isArray(parsed)) return [];
		return parsed as MemoryRecord[];
	} catch {
		return [];
	}
}

/**
 * Atomic write: write to temp file, then rename.
 */
async function atomicWrite(fp: string, data: MemoryRecord[]): Promise<void> {
	const dir = path.dirname(fp);
	await fs.mkdir(dir, { recursive: true });
	const tmpFile = path.join(dir, `.tmp_${crypto.randomBytes(4).toString("hex")}.json`);
	try {
		await fs.writeFile(tmpFile, JSON.stringify(data, null, 2), "utf8");
		await fs.rename(tmpFile, fp);
	} catch (err) {
		// Clean up temp file on failure
		await fs.unlink(tmpFile).catch(() => {});
		throw err;
	}
}

export async function saveMemory(record: MemoryRecord): Promise<void> {
	const fp = filePath(record.scope, record.projectId);
	await withFileLock(fp, async () => {
		const memories = await loadMemories(record.scope, record.projectId);
		memories.push(record);
		await atomicWrite(fp, memories);
	});
}

export async function archiveMemory(id: string, scope: MemoryScope, projectId?: string): Promise<MemoryRecord | null> {
	const fp = filePath(scope, projectId);
	return withFileLock(fp, async () => {
		const memories = await loadMemories(scope, projectId);
		const target = memories.find((m) => m.id === id);
		if (!target) return null;
		target.status = "archived";
		target.updatedAt = new Date().toISOString();
		await atomicWrite(fp, memories);
		return target;
	});
}

export async function purgeMemory(id: string, scope: MemoryScope, projectId?: string): Promise<MemoryRecord | null> {
	const fp = filePath(scope, projectId);
	return withFileLock(fp, async () => {
		const memories = await loadMemories(scope, projectId);
		const target = memories.find((m) => m.id === id);
		if (!target) return null;
		const filtered = memories.filter((m) => m.id !== id);
		await atomicWrite(fp, filtered);
		return target;
	});
}

// ── Search ───────────────────────────────────────────────────────────────────

/**
 * Score a memory against search keywords.
 * Returns the number of matching keywords (0 = no match).
 */
function scoreMemory(memory: MemoryRecord, searchWords: string[]): number {
	if (memory.status !== "active") return 0;

	let score = 0;
	const memoryKeywords = memory.keywords.map((k) => k.toLowerCase());
	const titleLower = memory.title.toLowerCase();
	const contentLower = memory.content.toLowerCase();

	for (const word of searchWords) {
		const wordLower = word.toLowerCase();
		// Keyword exact match (highest weight)
		if (memoryKeywords.some((k) => k === wordLower)) {
			score += 3;
			continue;
		}
		// Keyword partial match
		if (memoryKeywords.some((k) => k.includes(wordLower) || wordLower.includes(k))) {
			score += 2;
			continue;
		}
		// Content/title match
		if (titleLower.includes(wordLower) || contentLower.includes(wordLower)) {
			score += 1;
		}
	}

	return score;
}

export interface ScoredMemory {
	memory: MemoryRecord;
	score: number;
}

/**
 * Search memories by keyword matching.
 * Returns scored results sorted by relevance (highest first).
 */
export async function searchMemories(
	keywords: string[],
	scope?: MemoryScope,
	projectId?: string,
): Promise<ScoredMemory[]> {
	if (!keywords.length) return [];

	const results: ScoredMemory[] = [];

	const searchScopes: Array<{ scope: MemoryScope; projectId?: string }> = [];
	if (!scope || scope === "user") searchScopes.push({ scope: "user" });
	if ((!scope || scope === "project") && projectId) searchScopes.push({ scope: "project", projectId });

	for (const s of searchScopes) {
		const memories = await loadMemories(s.scope, s.projectId);
		for (const memory of memories) {
			const score = scoreMemory(memory, keywords);
			if (score > 0) results.push({ memory, score });
		}
	}

	return results.sort((a, b) => b.score - a.score);
}

/**
 * Get all active memories for the given scopes.
 */
export async function getAllActiveMemories(projectId?: string): Promise<MemoryRecord[]> {
	const userMemories = await loadMemories("user");
	const projectMemories = projectId ? await loadMemories("project", projectId) : [];
	return [...userMemories, ...projectMemories].filter((m) => m.status === "active");
}

/**
 * Find a memory by ID across both scopes.
 */
export async function findMemoryById(
	id: string,
	projectId?: string,
): Promise<{ memory: MemoryRecord; scope: MemoryScope } | null> {
	for (const scope of ["user", "project"] as MemoryScope[]) {
		const pid = scope === "project" ? projectId : undefined;
		if (scope === "project" && !projectId) continue;
		const memories = await loadMemories(scope, pid);
		const found = memories.find((m) => m.id === id);
		if (found) return { memory: found, scope };
	}
	return null;
}
