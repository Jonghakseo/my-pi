/**
 * Pure string utility functions extracted from various extension modules.
 * No side effects, no pi SDK dependencies.
 */

import crypto from "node:crypto";
import { basename } from "node:path";
import { fileURLToPath } from "node:url";

// ── Topic / Text Sanitization ────────────────────────────────────────────────

/**
 * Sanitize a topic name into a safe filesystem slug.
 * Strips path traversal sequences, path separators, and non-slug characters.
 * Throws on empty result.
 *
 * Source: memory-layer/storage.ts
 */
export function sanitizeTopic(topic: string): string {
	const slug = topic
		.replace(/\.\./g, "") // strip traversal
		.replace(/[/\\]/g, "") // strip path separators
		.toLowerCase()
		.replace(/[^a-z0-9\uAC00-\uD7AF\u3131-\u3163-]/g, "-")
		.replace(/-+/g, "-")
		.replace(/^-|-$/g, "")
		.slice(0, 50);

	if (!slug) {
		throw new Error(`Invalid topic name: "${topic}"`);
	}
	return slug;
}

/**
 * Normalize text for consistent key generation.
 * Trims whitespace and canonicalizes line endings (\r\n → \n).
 *
 * Source: memory-layer/storage.ts
 */
export function normalizeText(s: string): string {
	return s.replace(/\r\n/g, "\n").trim();
}

/**
 * Normalize a git remote URL to a slug.
 *   https://github.com/creatrip/product.git → github-creatrip-product
 *   git@github.com:creatrip/product.git     → github-creatrip-product
 *
 * Source: memory-layer/project-id.ts
 */
export function normalizeRemoteUrl(url: string): string {
	let normalized = url.trim();

	// SSH: git@github.com:org/repo.git → github.com/org/repo.git
	const sshMatch = normalized.match(/^[\w-]+@([\w.-]+):(.*)/);
	if (sshMatch) {
		normalized = `${sshMatch[1]}/${sshMatch[2]}`;
	}

	// Strip protocol
	normalized = normalized.replace(/^https?:\/\//, "");
	normalized = normalized.replace(/^ssh:\/\//, "");

	// Strip trailing .git
	normalized = normalized.replace(/\.git$/, "");

	// Strip trailing slashes
	normalized = normalized.replace(/\/+$/, "");

	// Strip user@ prefix (e.g. git@)
	normalized = normalized.replace(/^[\w-]+@/, "");

	// Replace non-alphanumeric with hyphens, collapse, trim
	return normalized
		.replace(/[^a-zA-Z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.toLowerCase();
}

/**
 * Generate a short SHA-256 hash (first 8 hex chars).
 *
 * Source: memory-layer/project-id.ts
 */
export function shortHash(input: string): string {
	return crypto.createHash("sha256").update(input).digest("hex").slice(0, 8);
}

/**
 * Truncate content to its first line, clipped to maxLen characters.
 *
 * Source: memory-layer/index.ts
 */
export function truncateTitle(content: string, maxLen = 60): string {
	const firstLine = content.split("\n")[0]?.trim() ?? content.trim();
	if (firstLine.length <= maxLen) return firstLine;
	return `${firstLine.slice(0, maxLen - 1)}…`;
}

/**
 * Convert a slug to a human-readable heading (Title Case).
 *
 * Source: memory-layer/index.ts
 */
export function slugToHeading(slug: string): string {
	return slug
		.split("-")
		.map((w) => w.charAt(0).toUpperCase() + w.slice(1))
		.join(" ");
}

// ── String Splitting / Encoding ──────────────────────────────────────────────

/**
 * Split a null-separated string into an array, filtering empty entries.
 *
 * Source: files.ts
 */
export function splitNullSeparated(value: string): string[] {
	return value.split("\0").filter(Boolean);
}

/**
 * Encode text to base64 (UTF-8).
 *
 * Source: former clipboard extension
 */
export function toBase64(text: string): string {
	return Buffer.from(text, "utf-8").toString("base64");
}

// ── Name / Label Normalization ───────────────────────────────────────────────

/**
 * Normalize a skill name by stripping the "skill:" prefix if present.
 *
 * Source: context.ts
 */
export function normalizeSkillName(name: string): string {
	return name.startsWith("skill:") ? name.slice("skill:".length) : name;
}

/**
 * Join an array of strings with ", ".
 *
 * Source: context.ts
 */
export function joinComma(items: string[]): string {
	return items.join(", ");
}

/**
 * Join items with a custom render function and separator.
 *
 * Source: context.ts
 */
export function joinCommaStyled(items: string[], renderItem: (item: string) => string, sep: string): string {
	return items.map(renderItem).join(sep);
}

// ── Distance / Matching ──────────────────────────────────────────────────────

/**
 * Compute the Levenshtein distance between two strings.
 * Uses single-row DP for efficiency.
 *
 * Source: command-typo-assist.ts
 */
export function levenshtein(a: string, b: string): number {
	const m = a.length;
	const n = b.length;
	if (m === 0) return n;
	if (n === 0) return m;

	// Single-row DP
	const row = Array.from({ length: n + 1 }, (_, i) => i);
	for (let i = 1; i <= m; i++) {
		let prev = i;
		for (let j = 1; j <= n; j++) {
			const cost = a[i - 1] === b[j - 1] ? 0 : 1;
			const val = Math.min(
				row[j] + 1, // deletion
				prev + 1, // insertion
				row[j - 1] + cost, // substitution
			);
			row[j - 1] = prev;
			prev = val;
		}
		row[n] = prev;
	}
	return row[n];
}

/**
 * Threshold heuristic for Levenshtein distance.
 * Scales with command length: short commands need closer matches.
 *   len 1–3 → max 1,  len 4–6 → max 2,  len 7+ → max 3
 *
 * Source: command-typo-assist.ts
 */
export function maxDistance(len: number): number {
	return Math.min(3, Math.max(1, Math.ceil(len / 3)));
}

// ── Whitespace / Tab ─────────────────────────────────────────────────────────

/**
 * Expand tabs to spaces.
 *
 * Source: diff-overlay.ts
 */
export function expandTabs(s: string, tabSize = 4): string {
	return s.replace(/\t/g, " ".repeat(tabSize));
}

/**
 * Derive the extension name (e.g. "minimal") from its import.meta.url or file path.
 *
 * Source: shared extension-name parsing helper
 */
export function extensionName(fileUrl: string): string {
	const filePath = fileUrl.startsWith("file://") ? fileURLToPath(fileUrl) : fileUrl;
	return basename(filePath).replace(/\.[^.]+$/, "");
}

/**
 * Normalize whitespace in a string: collapse consecutive spaces/tabs/newlines
 * into a single space and trim.
 *
 * Unifies normalizeLine (former idle-screensaver extension) and
 * normalizePurpose (former auto-name extension) under the same
 * whitespace-normalization logic.
 *
 * Source: former idle-screensaver / auto-name extensions
 */
export function normalizeWhitespace(raw: unknown): string {
	if (typeof raw !== "string") return "";
	return raw.replace(/\s+/g, " ").trim();
}

/**
 * Sanitize status text: replace newlines/tabs with spaces, collapse, trim.
 *
 * Source: footer.ts
 */
export function sanitizeStatusText(text: string): string {
	return text
		.replace(/[\r\n\t]/g, " ")
		.replace(/ +/g, " ")
		.trim();
}

// ── Session ID Detection ─────────────────────────────────────────────────────

/**
 * Check if a string looks like an auto-generated session ID
 * (hex-based or "session-NNN" pattern).
 *
 * Source: former idle-screensaver extension
 */
export function isLikelySessionId(text: string): boolean {
	const s = normalizeWhitespace(text);
	if (!s) return true;

	const compact = s.replace(/[-_]/g, "");
	if (/^[0-9a-f]{16,}$/i.test(compact)) return true;
	if (/^session[-_]?\d+$/i.test(s)) return true;
	if (/^session[-_]?[0-9a-f-]{8,}$/i.test(s)) return true;
	return false;
}
