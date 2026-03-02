/**
 * Pure utility functions for extracting and processing message content.
 * Extracted from subagent/session.ts, subagent/runner.ts, subagent/store.ts,
 * subagent/tool-execute.ts, voice-input.ts, and claude-hooks-bridge.ts.
 */

// ── Types ────────────────────────────────────────────────────────────────────

/** Minimal content part interface used by message processing functions. */
export interface ContentPart {
	type: string;
	text?: string;
	name?: string;
	arguments?: unknown;
	[key: string]: unknown;
}

/** Minimal message interface compatible with pi-ai Message. */
export interface MessageLike {
	role: string;
	content: string | ContentPart[] | unknown;
}

/** A display item extracted from assistant messages. */
export interface DisplayItem {
	type: "text" | "toolCall";
	text: string;
	name: string;
	args: unknown;
}

// ── Content Extraction ───────────────────────────────────────────────────────

/**
 * Extract text content from a message's content field.
 * Handles both string content and array of TextContent/ImageContent objects.
 */
export function extractTextFromContent(content: unknown): string {
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		return content
			.filter(
				(c: unknown) => c && typeof c === "object" && (c as ContentPart).type === "text" && (c as ContentPart).text,
			)
			.map((c: unknown) => (c as ContentPart).text)
			.join("\n");
	}
	return "";
}

/**
 * Extract text from content blocks (Claude hooks style).
 * Joins text blocks without separator.
 */
export function extractTextFromBlocks(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";

	const lines: string[] = [];
	for (const block of content) {
		if (!block || typeof block !== "object") continue;
		const text = (block as Record<string, unknown>).text;
		if (typeof text === "string") lines.push(text);
	}
	return lines.join("");
}

// ── Tool Call Serialization ──────────────────────────────────────────────────

/**
 * Stringify tool call arguments to a JSON string.
 * Handles undefined, null, string, and object types.
 */
export function stringifyToolCallArguments(args: unknown): string {
	if (args === undefined || args === null) return "";
	if (typeof args === "string") return args;
	try {
		return JSON.stringify(args);
	} catch {
		return String(args);
	}
}

// ── Message Analysis ─────────────────────────────────────────────────────────

/**
 * Get the final assistant text output from a list of messages.
 * Scans from the end to find the last assistant message with text.
 */
export function getFinalOutput(messages: MessageLike[]): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (msg.role === "assistant") {
			const content = msg.content;
			if (typeof content === "string") return content;
			if (Array.isArray(content)) {
				for (const part of content) {
					if (part && typeof part === "object" && (part as ContentPart).type === "text") {
						return (part as ContentPart).text ?? "";
					}
				}
			}
		}
	}
	return "";
}

/**
 * Collect display items (text + tool calls) from assistant messages.
 */
export function getDisplayItems(messages: MessageLike[]): DisplayItem[] {
	const items: DisplayItem[] = [];
	for (const msg of messages) {
		if (msg.role === "assistant") {
			const content = msg.content;
			if (!Array.isArray(content)) continue;
			for (const part of content) {
				if (!part || typeof part !== "object") continue;
				const p = part as ContentPart;
				if (p.type === "text") items.push({ type: "text", text: p.text ?? "", name: "", args: undefined });
				else if (p.type === "toolCall")
					items.push({ type: "toolCall", text: "", name: p.name ?? "", args: p.arguments });
			}
		}
	}
	return items;
}

/**
 * Count tool calls across all assistant messages.
 */
export function collectToolCallCount(messages: MessageLike[]): number {
	return getDisplayItems(messages).filter((item) => item.type === "toolCall").length;
}

/**
 * Extract the latest assistant text from messages.
 * Scans backward and returns the first non-empty text found in an assistant message.
 */
export function extractLatestAssistantText(messages: unknown[]): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i];
		if (!message || typeof message !== "object") continue;
		if ((message as { role?: unknown }).role !== "assistant") continue;

		const content = (message as { content?: unknown }).content;
		if (!Array.isArray(content)) continue;

		const textParts: string[] = [];
		for (const part of content) {
			if (!part || typeof part !== "object") continue;
			if ((part as { type?: unknown }).type !== "text") continue;
			const text = (part as { text?: unknown }).text;
			if (typeof text === "string" && text.trim()) {
				textParts.push(text.trim());
			}
		}

		const merged = textParts.join(" ").replace(/\s+/g, " ").trim();
		if (merged) return merged;
	}

	return "";
}

// ── Task Wrapping ────────────────────────────────────────────────────────────

/**
 * Wrap a task string with main session context text.
 *
 * When available, also provides the main session JSONL path so subagents can
 * inspect deeper history on demand.
 */
export function wrapTaskWithMainContext(
	task: string,
	contextText: string,
	options?: { mainSessionFile?: string; totalMessageCount?: number },
): string {
	const rawSessionFile = options?.mainSessionFile;
	const sessionFile =
		typeof rawSessionFile === "string" ? rawSessionFile.replace(/[\r\n\t]+/g, "").trim() || undefined : undefined;
	const totalMessageCount = options?.totalMessageCount;

	if (!contextText && !sessionFile) return task;

	const sections: string[] = [];
	if (contextText) {
		sections.push(`[Main Session Context]\n${contextText}`);
	}
	if (sessionFile) {
		const logLines = ["[Main Session Log Access]", `Main agent session JSONL path: ${sessionFile}`];
		if (totalMessageCount !== undefined && totalMessageCount > 0) {
			logLines.push(`Total messages in main session: ${totalMessageCount} (only the last 20 are included above)`);
		}
		logLines.push(
			"If deeper history is needed, inspect this file on demand.",
			"Use targeted reads first (search keywords, then read with offset/limit).",
			"Avoid dumping entire logs into context; summarize only relevant parts.",
		);
		sections.push(logLines.join("\n"));
	}
	sections.push(`[Request]\n${task}`);

	return sections.join("\n\n");
}
