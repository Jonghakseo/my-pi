/**
 * Pure path/filename utility functions extracted from various extensions.
 *
 * All functions are deterministic and depend only on their arguments
 * and Node built-in `path` / `os` modules.
 */

import { homedir } from "node:os";
import path from "node:path";

// ─── Constants (from upload-image-url.ts) ────────────────────────────────────

export const ALLOWED_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".bmp", ".ico"]);

export const MIME_TO_EXT: Record<string, string> = {
	"image/png": ".png",
	"image/jpeg": ".jpg",
	"image/gif": ".gif",
	"image/webp": ".webp",
	"image/svg+xml": ".svg",
	"image/bmp": ".bmp",
	"image/x-icon": ".ico",
};

// ─── File Reference Sanitization (from files.ts) ────────────────────────────

/**
 * Strip leading/trailing quote, bracket, and punctuation characters
 * from a raw file reference string.
 */
export function sanitizeReference(raw: string): string {
	let value = raw.trim();
	value = value.replace(/^["'`(<[]+/, "");
	value = value.replace(/[>"'`,;).\]]+$/, "");
	value = value.replace(/[.,;:]+$/, "");
	return value;
}

/** Check if a reference looks like a comment (starts with `//`). */
export function isCommentLikeReference(value: string): boolean {
	return value.startsWith("//");
}

/**
 * Strip line-number suffixes from a file path.
 *
 * Handles `file.ts#L42`, `file.ts:42`, `file.ts:42:10`, etc.
 */
export function stripLineSuffix(value: string): string {
	let result = value.replace(/#L\d+(C\d+)?$/i, "");
	const lastSeparator = Math.max(result.lastIndexOf("/"), result.lastIndexOf("\\"));
	const segmentStart = lastSeparator >= 0 ? lastSeparator + 1 : 0;
	const segment = result.slice(segmentStart);
	const colonIndex = segment.indexOf(":");
	if (colonIndex >= 0 && /\d/.test(segment[colonIndex + 1] ?? "")) {
		result = result.slice(0, segmentStart + colonIndex);
		return result;
	}

	const lastColon = result.lastIndexOf(":");
	if (lastColon > lastSeparator) {
		const suffix = result.slice(lastColon + 1);
		if (/^\d+(?::\d+)?$/.test(suffix)) {
			result = result.slice(0, lastColon);
		}
	}
	return result;
}

// ─── Display Path (from files.ts) ───────────────────────────────────────────

/**
 * Format an absolute path for display:
 * - relative to `cwd` if it's a descendant
 * - absolute path otherwise
 */
export function formatDisplayPath(absolutePath: string, cwd: string): string {
	const normalizedCwd = path.resolve(cwd);
	if (absolutePath.startsWith(normalizedCwd + path.sep)) {
		return path.relative(normalizedCwd, absolutePath);
	}
	return absolutePath;
}

// ─── Shorten Path (from context.ts) ─────────────────────────────────────────

/**
 * Shorten a path relative to `cwd`.
 *
 * - Returns `"."` if the path is the cwd itself.
 * - Returns `"./relative"` if it's a descendant.
 * - Returns the resolved absolute path otherwise.
 */
export function shortenPath(p: string, cwd: string): string {
	const rp = path.resolve(p);
	const rc = path.resolve(cwd);
	if (rp === rc) return ".";
	if (rp.startsWith(rc + path.sep)) return `./${rp.slice(rc.length + 1)}`;
	return rp;
}

// ─── Folder Name (from pipi-footer.ts) ──────────────────────────────────────

/** Extract the last folder name from a path (e.g. "/a/b/c" → "c"). */
export function getFolderName(cwd: string): string {
	const parts = cwd.split(/[\\/]/).filter(Boolean);
	return parts.length > 0 ? parts[parts.length - 1] : cwd || "unknown";
}

// ─── Resolve to Absolute (from dynamic-agents-md.ts) ────────────────────────

/**
 * Resolve a file path to an absolute path.
 *
 * Handles `~`, `~/…`, relative paths (resolved against `cwd`),
 * and already-absolute paths.
 */
export function toAbsolute(filePath: string, cwd: string): string {
	if (path.isAbsolute(filePath)) return path.resolve(filePath);
	if (filePath === "~") return homedir();
	if (filePath.startsWith("~/")) return path.resolve(path.join(homedir(), filePath.slice(2)));
	return path.resolve(cwd, filePath);
}

// ─── Tool Input Path Extraction (from dynamic-agents-md.ts) ─────────────────

/**
 * Extract file path(s) from a tool input's `path` value.
 *
 * The Read tool accepts `path` as either a single string or an array of strings
 * (parallel read). This normalises both forms into a flat string array.
 */
export function extractPathsFromInput(pathValue: unknown): string[] {
	if (typeof pathValue === "string" && pathValue.length > 0) return [pathValue];
	if (Array.isArray(pathValue)) return pathValue.filter((x): x is string => typeof x === "string" && x.length > 0);
	return [];
}

// ─── Filename Sanitization (from upload-image-url.ts) ────────────────────────

/**
 * Strip path separators and shell-unsafe characters from a filename.
 * Prevents directory traversal and command injection.
 */
export function sanitizeFilename(raw: string): string {
	return raw.replace(/[/\\:*?"<>|`$!&;#{}()'\s]/g, "_").replace(/\.{2,}/g, "_");
}

/**
 * Infer a file extension from a URL or content-type header.
 *
 * Checks the URL pathname extension first, then falls back to
 * MIME type mapping. Defaults to `.png` if nothing matches.
 */
export function inferExtension(url: string, contentType?: string): string {
	try {
		const parts = path.extname(new URL(url).pathname).toLowerCase().split("?");
		const ext = parts[0] ?? "";
		if (ext && ALLOWED_EXTENSIONS.has(ext)) return ext;
	} catch {
		/* ignore invalid URLs */
	}

	if (contentType) {
		for (const [mime, ext] of Object.entries(MIME_TO_EXT)) {
			if (contentType.includes(mime)) return ext;
		}
	}

	return ".png";
}
