/**
 * Pure text manipulation utilities extracted from various extensions.
 *
 * All functions are deterministic, side-effect free, and have no pi SDK dependencies.
 * Functions that depend on pi-tui (visibleWidth, truncateToWidth) are clearly marked.
 */

import { truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";

// ─── Constants ─────────────────────────────────────────────────────────────

/** Global subagent rule appended to system prompts. */
export const COMMON_SUBAGENT_NO_RECURSION_RULE = [
	"Global Runtime Rule (subagent):",
	"- Never invoke the `subagent` tool.",
	"- Never trigger subagent commands/shorthands such as `/sub:*`, `>>`, `>`, or `>>>`.",
	"- If delegation is requested, explain that recursive subagent invocation is disabled and continue with available tools.",
].join("\n");

// ─── Basic string transforms ──────────────────────────────────────────────

/** Replace carriage returns and convert tabs to double spaces (preserves newlines). */
function normalizeControlChars(text: string): string {
	return text.replace(/\r/g, "").replace(/\t/g, "  ");
}

/** Split a long token into chunks of at most `maxWidth` characters. */
export function splitLongToken(token: string, maxWidth: number): string[] {
	if (token.length <= maxWidth) return [token];
	const out: string[] = [];
	for (let index = 0; index < token.length; index += maxWidth) {
		out.push(token.slice(index, index + maxWidth));
	}
	return out;
}

/** Wrap text to fit within `maxWidth`, splitting on whitespace and long tokens. */
export function wrapText(text: string, maxWidth: number): string[] {
	if (maxWidth <= 1) return [text];
	const normalized = normalizeControlChars(text);
	const lines = normalized.split("\n");
	const wrapped: string[] = [];

	for (const rawLine of lines) {
		const line = rawLine.trimEnd();
		if (!line.trim()) {
			wrapped.push("");
			continue;
		}

		const words = line.split(/\s+/).flatMap((word) => splitLongToken(word, maxWidth));
		let current = "";

		for (const word of words) {
			if (!current) {
				current = word;
				continue;
			}

			if (`${current} ${word}`.length <= maxWidth) {
				current = `${current} ${word}`;
			} else {
				wrapped.push(current);
				current = word;
			}
		}

		if (current) {
			wrapped.push(current);
		}
	}

	if (!wrapped.length) {
		wrapped.push("");
	}

	return wrapped;
}

/** Collapse text to a single line, truncating with ellipsis if necessary. */
export function toSingleLinePreview(text: string, maxLength: number): string {
	const normalized = normalizeControlChars(text).replace(/\n+/g, " ").replace(/\s+/g, " ").trim();
	if (!normalized) return "(empty)";
	if (normalized.length <= maxLength) return normalized;
	return `${normalized.slice(0, Math.max(0, maxLength - 1))}…`;
}

// ─── Markdown / speech helpers ─────────────────────────────────────────────

/** Strip markdown formatting from text for speech synthesis. */
export function stripMarkdownForSpeech(text: string): string {
	return text
		.replace(/```[\s\S]*?```/g, " ")
		.replace(/`([^`]+)`/g, "$1")
		.replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
		.replace(/^\s{0,3}#{1,6}\s+/gm, "")
		.replace(/^\s*[-*+]\s+/gm, "")
		.replace(/^\s*\d+\.\s+/gm, "")
		.replace(/\s+/g, " ")
		.trim();
}

/** Normalize transcript whitespace: collapse all runs of whitespace to single space. */
export function normalizeTranscript(text: string): string {
	return text.replace(/\s+/g, " ").trim();
}

/** Produce a short speech-friendly summary. */
export function summarizeForSpeech(text: string, maxChars: number): string {
	const normalized = stripMarkdownForSpeech(normalizeTranscript(text));
	if (!normalized) return "";

	const sentences =
		normalized
			.match(/[^.!?。！？]+[.!?。！？]?/gu)
			?.map((sentence) => sentence.trim())
			.filter(Boolean) ?? [];

	let summary = sentences[0] ?? normalized;
	if (summary.length < 18 && sentences.length > 1) {
		summary = `${summary} ${sentences[1]}`.trim();
	}

	if (summary.length > maxChars) {
		summary = `${summary.slice(0, maxChars - 1).trimEnd()}…`;
	}

	return summary;
}

/** Extract raw transcript text from whisper.cpp stdout. */
export function extractTranscriptFromStdout(stdout: string): string {
	const lines = stdout
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter(Boolean);

	const timestamped = lines
		.map((line) => {
			const match = line.match(/^\[[^\]]+\]\s*(.+)$/);
			return match?.[1]?.trim() ?? "";
		})
		.filter(Boolean);

	if (timestamped.length > 0) {
		return normalizeTranscript(timestamped.join(" "));
	}

	const filtered = lines.filter((line) => {
		if (/^(whisper_|system_info:|main:|ggml_|metal_|encode:|decode:|sampling:)/i.test(line)) return false;
		if (/^(\d+\.?\d*%|progress =)/i.test(line)) return false;
		return true;
	});

	return normalizeTranscript(filtered.join(" "));
}

// ─── Line-level utilities ──────────────────────────────────────────────────

/** Get the last non-empty trimmed line from text. */
export function getLastNonEmptyLine(text: string): string {
	return (
		text
			.split("\n")
			.map((line) => line.trim())
			.filter(Boolean)
			.pop() ?? ""
	);
}

/** Truncate a single line. If max ≤ 3, simply slice. Otherwise append "...". */
export function truncateSingleLine(value: string, max: number): string {
	if (value.length <= max) return value;
	if (max <= 3) return value.slice(0, max);
	return `${value.slice(0, max - 3)}...`;
}

/** Summarize a JSON value to a short string. */
export function summarizeJson(value: unknown, max = 140): string {
	if (value === undefined || value === null) return "";
	let text = "";
	try {
		text = JSON.stringify(value);
	} catch {
		text = String(value);
	}
	if (!text || text === "{}") return "";
	return truncateSingleLine(text, max);
}

// ─── Display-width aware utilities (pi-tui dependent) ──────────────────────

const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/**
 * Slice a string to fit a maximum display width, respecting grapheme clusters.
 * Uses Intl.Segmenter for proper emoji/CJK handling.
 */
export function sliceToDisplayWidth(value: string, maxWidth: number): string {
	if (maxWidth <= 0 || value.length === 0) return "";

	let result = "";
	let width = 0;

	for (const { segment } of graphemeSegmenter.segment(value)) {
		const segmentWidth = visibleWidth(segment);
		if (segmentWidth <= 0) {
			result += segment;
			continue;
		}
		if (width + segmentWidth > maxWidth) break;
		result += segment;
		width += segmentWidth;
	}

	return result;
}

/**
 * Truncate text to a maximum display width, appending "..." if truncated.
 * Uses pi-tui's visibleWidth for accurate CJK/emoji width.
 */
export function truncateText(value: string, max: number): string {
	if (max <= 0 || value.length === 0) return "";
	if (visibleWidth(value) <= max) return value;
	if (max <= 3) return sliceToDisplayWidth(value, max);
	return `${sliceToDisplayWidth(value, max - 3)}...`;
}

/**
 * Center-pad text within a given width.
 * Uses pi-tui's visibleWidth/truncateToWidth for CJK awareness.
 */
export function centerPad(text: string, width: number): string {
	const vis = visibleWidth(text);
	if (vis >= width) return truncateToWidth(text, width);
	return `${" ".repeat(Math.floor((width - vis) / 2))}${text}`;
}

// ─── Prompt / injection builders ───────────────────────────────────────────

/** Clamp text to a maximum number of lines, adding a truncation indicator. */
export function clampLines(text: string, maxLines: number): string {
	const lines = text.split("\n");
	if (lines.length <= maxLines) return text;
	const hidden = lines.length - maxLines;
	const visible = lines.slice(0, maxLines);
	const lastIndex = visible.length - 1;
	visible[lastIndex] = `${visible[lastIndex]} … (+${hidden} lines)`;
	return visible.join("\n");
}

/** Build a prompt string from a question and optional context. */
export function buildPrompt(question: string, context?: string): string {
	const ctx = typeof context === "string" ? context.trim() : "";
	if (!ctx) return question;
	return `${question}\n\n${ctx}`;
}

/** Format dynamic context injection blocks for LLM consumption. */
export function formatInjection(files: { path: string; content: string }[]): string {
	const parts = files.map((f) => `\n\n---\n📋 [Dynamic scope context: ${f.path}]\n\n${f.content}\n---`);
	return parts.join("");
}

/** Build a tool_call block reason for edit/write gating. */
export function formatBlockReason(targetPath: string, files: { path: string }[]): string {
	const list = files.map((f) => `- read path: ${f.path}`).join("\n");
	return [
		"Blocked: scoped AGENTS context must be loaded before edit/write.",
		`Target: ${targetPath}`,
		"",
		"Read these context files first:",
		list,
		"",
		"Then retry the same edit/write.",
	].join("\n");
}

/** Append the common subagent no-recursion rule to a system prompt if not present. */
export function attachCommonSubagentRule(systemPrompt: string): string {
	const trimmed = systemPrompt.trimEnd();
	if (trimmed.includes("Global Runtime Rule (subagent):")) return trimmed;
	return trimmed ? `${trimmed}\n\n${COMMON_SUBAGENT_NO_RECURSION_RULE}` : COMMON_SUBAGENT_NO_RECURSION_RULE;
}
