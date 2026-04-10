/**
 * Pure parsing utilities extracted from various extensions.
 *
 * All functions are deterministic with no pi SDK dependencies.
 * Only Node built-in modules (path) are used.
 */

import path from "node:path";

// ─── Types ─────────────────────────────────────────────────────────────────

export interface AgentFrontmatter {
	description: string;
	body: string;
	fields: Record<string, string>;
}

export interface ParsedReminder {
	task: string;
	delayMs: number;
	delayLabel: string;
}

// ─── Constants ─────────────────────────────────────────────────────────────

export const BUILTIN_TOOL_ALIASES: Record<string, string> = {
	bash: "Bash",
	read: "Read",
	edit: "Edit",
	write: "Write",
	grep: "Grep",
	find: "Find",
	ls: "LS",
};

const DEFAULT_SOON_DELAY_MS = 10 * 60 * 1000;
const MAX_DELAY_MS = 7 * 24 * 60 * 60 * 1000;

const EXPLICIT_DELAY_RE = /^(\d+)\s*(초|분|시간)\s*(?:있다가|후(?:에)?|뒤(?:에)?)\s*[,，:]?\s*(.+)$/i;
const SOON_DELAY_RE = /^(?:좀|조금|잠깐|잠시)\s*(?:있다가|후(?:에)?|뒤(?:에)?)\s*[,，:]?\s*(.+)$/i;

// ─── Agent frontmatter parsing (from cross-agent.ts) ──────────────────────

/** Parse YAML-like frontmatter from a markdown file. */
export function parseAgentFrontmatter(raw: string): AgentFrontmatter {
	const match = raw.match(/^---\s*\n([\s\S]*?)\n---\s*\n([\s\S]*)$/);
	if (!match) return { description: "", body: raw, fields: {} };

	const front = match[1];
	const body = match[2];
	const fields: Record<string, string> = {};
	for (const line of front.split("\n")) {
		const idx = line.indexOf(":");
		if (idx > 0) fields[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
	}
	return { description: fields.description || "", body, fields };
}

/** Expand argument placeholders in a template string. */
export function expandArgs(template: string, args: string): string {
	const parts = args.split(/\s+/).filter(Boolean);
	let result = template;
	result = result.replace(/\$ARGUMENTS|\$@/g, args);
	for (let i = 0; i < parts.length; i++) {
		result = result.replaceAll(`$${i + 1}`, parts[i]);
	}
	return result;
}

// ─── Todo frontmatter parsing (from todos.ts) ─────────────────────────────

/**
 * Find the closing brace of a top-level JSON object, handling strings and nesting.
 * Returns the index of the closing `}`, or -1 if not found.
 */
export function findJsonObjectEnd(content: string): number {
	let depth = 0;
	let inString = false;
	let escaped = false;

	for (let i = 0; i < content.length; i += 1) {
		const char = content[i];

		if (inString) {
			if (escaped) {
				escaped = false;
				continue;
			}
			if (char === "\\") {
				escaped = true;
				continue;
			}
			if (char === '"') {
				inString = false;
			}
			continue;
		}

		if (char === '"') {
			inString = true;
			continue;
		}

		if (char === "{") {
			depth += 1;
			continue;
		}

		if (char === "}") {
			depth -= 1;
			if (depth === 0) return i;
		}
	}

	return -1;
}

/** Split todo content into JSON frontmatter and markdown body. */
export function splitTodoFrontMatter(content: string): { frontMatter: string; body: string } {
	if (!content.startsWith("{")) {
		return { frontMatter: "", body: content };
	}

	const endIndex = findJsonObjectEnd(content);
	if (endIndex === -1) {
		return { frontMatter: "", body: content };
	}

	const frontMatter = content.slice(0, endIndex + 1);
	const body = content.slice(endIndex + 1).replace(/^\r?\n+/, "");
	return { frontMatter, body };
}

// ─── Claude hooks bridge parsers (from claude-hooks-bridge.ts) ─────────────

// ─── Claude hooks bridge parsers (from claude-hooks-bridge.ts) ─────────────

/** Parse JSON from stdout, trying the whole string first, then individual lines. */
export function parseJsonFromStdout(stdout: string): unknown | null {
	const trimmed = stdout.trim();
	if (!trimmed) return null;

	try {
		return JSON.parse(trimmed);
	} catch {
		// pass
	}

	const lines = trimmed
		.split("\n")
		.map((line) => line.trim())
		.filter(Boolean);

	for (let i = lines.length - 1; i >= 0; i -= 1) {
		try {
			return JSON.parse(lines[i]);
		} catch {
			// pass
		}
	}

	return null;
}

/** Normalize tool input, resolving relative paths to absolute. */
export function normalizeToolInput(toolName: string, rawInput: unknown, cwd: string): Record<string, unknown> {
	const input: Record<string, unknown> =
		rawInput && typeof rawInput === "object" ? { ...(rawInput as Record<string, unknown>) } : {};

	const pathCandidate =
		typeof input.path === "string"
			? input.path
			: typeof input.file_path === "string"
				? input.file_path
				: typeof input.filePath === "string"
					? input.filePath
					: undefined;

	if (pathCandidate) {
		const absolute = path.isAbsolute(pathCandidate) ? path.normalize(pathCandidate) : path.resolve(cwd, pathCandidate);
		input.path = absolute;
		input.file_path = absolute;
		input.filePath = absolute;
	}

	if (toolName === "bash" && typeof input.command !== "string") {
		input.command = "";
	}

	return input;
}

/** Get the Claude-canonical tool name from a pi tool name. */
export function getClaudeToolName(toolName: string): string {
	return BUILTIN_TOOL_ALIASES[toolName] || toolName;
}

/** Get all candidate names for matcher comparison. */
export function getMatcherCandidates(toolName: string): string[] {
	const canonical = getClaudeToolName(toolName);
	const set = new Set<string>([toolName, toolName.toLowerCase(), canonical, canonical.toLowerCase()]);
	return Array.from(set);
}

/** Check if a matcher pattern matches a tool name. */
export function matcherMatches(matcher: string | undefined, toolName: string): boolean {
	if (!matcher || matcher.trim() === "") return true;

	const candidates = getMatcherCandidates(toolName);

	try {
		const re = new RegExp(`^(?:${matcher})$`);
		if (candidates.some((name) => re.test(name))) return true;
	} catch {
		// matcher not valid regex — fallback
	}

	const tokens = matcher
		.split("|")
		.map((token) => token.trim())
		.filter(Boolean);

	if (tokens.length === 0) return false;
	return tokens.some((token) =>
		candidates.some((name) => name === token || name.toLowerCase() === token.toLowerCase()),
	);
}

/** Build a fallback reason string from stderr/stdout, truncated. */
export function fallbackReason(stderr: string, stdout: string): string | undefined {
	const text = stderr.trim() || stdout.trim();
	if (!text) return undefined;
	return text.length > 2000 ? `${text.slice(0, 2000)}...` : text;
}

/** Build a block reason string, with fallback and truncation. */
export function toBlockReason(reason: string | undefined, fallback: string): string {
	const text = (reason || "").trim();
	if (!text) return fallback;
	if (text.length <= 2000) return text;
	return `${text.slice(0, 2000)}...`;
}

// ─── Reminder parsing (from former delayed-action extension) ───────────────
// Note: this function could also live in time-utils; placed here due to its parsing nature.

function toDelayMs(amount: number, unit: "초" | "분" | "시간"): number {
	if (unit === "초") return amount * 1000;
	if (unit === "시간") return amount * 60 * 60 * 1000;
	return amount * 60 * 1000;
}

function formatKoreanDuration(ms: number): string {
	if (ms < 60_000) return `${Math.max(1, Math.round(ms / 1000))}초`;
	if (ms < 3_600_000) return `${Math.max(1, Math.round(ms / 60_000))}분`;
	const hours = Math.floor(ms / 3_600_000);
	const minutes = Math.floor((ms % 3_600_000) / 60_000);
	if (minutes === 0) return `${hours}시간`;
	return `${hours}시간 ${minutes}분`;
}

/** Parse Korean-style reminder request text into a structured reminder. */
export function parseReminderRequest(text: string): ParsedReminder | null {
	const trimmed = text.trim();
	if (!trimmed) return null;

	const explicit = trimmed.match(EXPLICIT_DELAY_RE);
	if (explicit) {
		const amount = Number(explicit[1]);
		const unit = explicit[2] as "초" | "분" | "시간";
		const task = explicit[3]?.trim() ?? "";
		if (!Number.isFinite(amount) || amount <= 0 || !task) return null;

		const delayMs = toDelayMs(amount, unit);
		if (delayMs > MAX_DELAY_MS) return null;

		return {
			task,
			delayMs,
			delayLabel: `${amount}${unit}`,
		};
	}

	const soon = trimmed.match(SOON_DELAY_RE);
	if (soon) {
		const task = soon[1]?.trim() ?? "";
		if (!task) return null;
		return {
			task,
			delayMs: DEFAULT_SOON_DELAY_MS,
			delayLabel: formatKoreanDuration(DEFAULT_SOON_DELAY_MS),
		};
	}

	return null;
}
