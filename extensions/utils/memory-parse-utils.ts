/**
 * Pure utility functions extracted from the memory-layer module.
 * These handle markdown-based memory index/topic file parsing and building.
 */

import { normalizeText } from "./string-utils.ts";

// ── Constants ────────────────────────────────────────────────────────────────

export const ENTRY_MARKER_PREFIX = "<!-- @entry: ";
export const ENTRY_MARKER_SUFFIX = " -->";

// ── Types ────────────────────────────────────────────────────────────────────

export interface IndexSection {
	topic: string; // filename without .md
	entries: string[]; // memory titles (bullets)
}

export interface TopicEntry {
	title: string;
	content: string;
}

export type MemoryScope = "user" | "project";

export interface SearchResultLike {
	scope: MemoryScope;
	projectId?: string;
	topic: string;
	title: string;
	content: string;
}

// ── Index Parsing / Building ─────────────────────────────────────────────────

/**
 * Parse a MEMORY.md index file into structured sections.
 * Each section is a `## <topic>.md` heading followed by `- <entry>` bullets.
 */
export function parseIndex(content: string): IndexSection[] {
	const sections: IndexSection[] = [];
	let currentTopic: string | null = null;
	let currentEntries: string[] = [];

	for (const line of content.split("\n")) {
		const topicMatch = line.match(/^## (.+)\.md\s*$/);
		if (topicMatch) {
			if (currentTopic) sections.push({ topic: currentTopic, entries: currentEntries });
			currentTopic = topicMatch[1];
			currentEntries = [];
			continue;
		}
		const bullet = line.match(/^- (.+)$/);
		if (bullet && currentTopic) {
			currentEntries.push(bullet[1]);
		}
	}

	if (currentTopic) sections.push({ topic: currentTopic, entries: currentEntries });
	return sections;
}

/**
 * Build a MEMORY.md index string from structured sections.
 */
export function buildIndex(sections: IndexSection[]): string {
	const lines = ["# Memory Index", ""];
	for (const section of sections) {
		lines.push(`## ${section.topic}.md`);
		for (const entry of section.entries) {
			lines.push(`- ${entry}`);
		}
		lines.push("");
	}
	return lines.join("\n");
}

// ── Entry Title Encoding / Decoding ──────────────────────────────────────────

/**
 * Encode an entry title to base64 for marker format.
 */
export function encodeEntryTitle(title: string): string {
	return Buffer.from(title, "utf8").toString("base64");
}

/**
 * Decode a base64-encoded entry title back to string.
 */
export function decodeEntryTitle(encoded: string): string {
	return Buffer.from(encoded, "base64").toString("utf8");
}

/**
 * Check if raw topic file content uses the new marker entry format.
 */
export function isNewEntryFormat(raw: string): boolean {
	return raw.includes(ENTRY_MARKER_PREFIX);
}

// ── Topic File Parsing ───────────────────────────────────────────────────────

/**
 * Parse topic file using new marker format.
 */
export function parseTopicFileMarker(raw: string): { heading: string; entries: TopicEntry[] } {
	const lines = raw.split("\n");
	let heading = "";
	const entries: TopicEntry[] = [];
	let curTitle: string | null = null;
	let curBody: string[] = [];

	for (const line of lines) {
		if (!heading) {
			const h1 = line.match(/^# (.+)$/);
			if (h1) {
				heading = h1[1];
				continue;
			}
		}

		if (line.startsWith(ENTRY_MARKER_PREFIX) && line.endsWith(ENTRY_MARKER_SUFFIX)) {
			if (curTitle !== null) {
				entries.push({ title: curTitle, content: curBody.join("\n").trim() });
			}
			const b64 = line.slice(ENTRY_MARKER_PREFIX.length, -ENTRY_MARKER_SUFFIX.length).trim();
			try {
				curTitle = decodeEntryTitle(b64);
			} catch {
				curTitle = b64;
			}
			curBody = [];
			continue;
		}

		if (curTitle !== null) curBody.push(line);
	}

	if (curTitle !== null) entries.push({ title: curTitle, content: curBody.join("\n").trim() });
	return { heading, entries };
}

/**
 * Parse topic file using legacy ## heading format (backward compatibility).
 */
export function parseTopicFileLegacy(raw: string): { heading: string; entries: TopicEntry[] } {
	const lines = raw.split("\n");
	let heading = "";
	const entries: TopicEntry[] = [];
	let curTitle: string | null = null;
	let curBody: string[] = [];
	let headingResolved = false;

	for (const line of lines) {
		if (!headingResolved) {
			if (line.trim() === "") continue;
			const h1 = line.match(/^# (.+)$/);
			if (h1) {
				heading = h1[1];
				headingResolved = true;
				continue;
			}
			headingResolved = true;
		}

		const h2 = line.match(/^## (.+)$/);
		if (h2) {
			if (curTitle) entries.push({ title: curTitle, content: curBody.join("\n").trim() });
			curTitle = h2[1];
			curBody = [];
			continue;
		}
		if (curTitle !== null) curBody.push(line);
	}
	if (curTitle) entries.push({ title: curTitle, content: curBody.join("\n").trim() });

	return { heading, entries };
}

/**
 * Parse a topic file, auto-detecting format.
 * New marker format takes priority; falls back to legacy ## format.
 */
export function parseTopicFile(raw: string): { heading: string; entries: TopicEntry[] } {
	if (isNewEntryFormat(raw)) return parseTopicFileMarker(raw);
	return parseTopicFileLegacy(raw);
}

/**
 * Build topic file content always using new marker format (## safe).
 */
export function buildTopicFile(heading: string, entries: TopicEntry[]): string {
	const lines = [`# ${heading}`, ""];
	for (const entry of entries) {
		lines.push(`${ENTRY_MARKER_PREFIX}${encodeEntryTitle(entry.title)}${ENTRY_MARKER_SUFFIX}`);
		lines.push(entry.content);
		lines.push("");
	}
	return lines.join("\n");
}

// ── Dedup Key Helpers ────────────────────────────────────────────────────────

/**
 * Build a dedup key from title + content with consistent normalization.
 */
export function makeEntryKey(title: string, content: string): string {
	return `${normalizeText(title)}\0${normalizeText(content)}`;
}

// ── Argument Parsing ─────────────────────────────────────────────────────────

/**
 * Parse `/remember` args: `/remember [user|project] <content>`
 * Returns { scope, content }. Defaults scope to "project" if not specified.
 */
export function parseRememberArgs(raw: string): { scope: MemoryScope; content: string } {
	const scopeMatch = raw.match(/^(user|project)\s+([\s\S]+)$/);
	if (scopeMatch) {
		return { scope: scopeMatch[1] as MemoryScope, content: scopeMatch[2].trim() };
	}
	return { scope: "project", content: raw };
}

// ── Search Text Builder ──────────────────────────────────────────────────────

/**
 * Build a lowercased search text from a memory search result.
 */
export function buildSearchText(entry: SearchResultLike): string {
	return [entry.scope, entry.topic, entry.title, entry.content, entry.projectId ?? ""].join(" ").toLowerCase();
}
