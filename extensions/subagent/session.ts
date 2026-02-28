/**
 * Session file management and context helpers for the Subagent tool.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const SUBAGENT_SESSION_DIR = path.join(os.homedir(), ".pi", "agent", "sessions", "subagents");

export function makeSubagentSessionFile(runId: number): string {
	fs.mkdirSync(SUBAGENT_SESSION_DIR, { recursive: true });
	return path.join(SUBAGENT_SESSION_DIR, `subagent-${runId}-${Date.now()}.jsonl`);
}

export function makeToolSessionFile(prefix: string): string {
	fs.mkdirSync(SUBAGENT_SESSION_DIR, { recursive: true });
	const rand = Math.random().toString(36).slice(2, 8);
	return path.join(SUBAGENT_SESSION_DIR, `${prefix}-${Date.now()}-${rand}.jsonl`);
}

export function makeInheritedSessionCopy(sourceSessionFile: string, prefix: string): string {
	const destination = makeToolSessionFile(prefix);
	fs.copyFileSync(sourceSessionFile, destination);
	return destination;
}

/**
 * Extract text content from a message's content field.
 * Handles both string content and array of TextContent/ImageContent objects.
 */
export function extractTextFromContent(content: any): string {
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		return content
			.filter((c: any) => c.type === "text" && c.text)
			.map((c: any) => c.text)
			.join("\n");
	}
	return "";
}

const SUBAGENT_RESULT_MAX_CHARS = 500;

function stringifyToolCallArguments(args: unknown): string {
	if (args === undefined || args === null) return "";
	if (typeof args === "string") return args;
	try {
		return JSON.stringify(args);
	} catch {
		return String(args);
	}
}

/**
 * Build a text representation of the main session context for injection into subagent tasks.
 * Instead of copying the entire session file (which causes persona confusion),
 * this extracts context text: compaction summary + last 10 messages (+ assistant tool calls).
 */
export function buildMainContextText(ctx: any): string {
	try {
		const entries = ctx.sessionManager.getEntries();
		if (!entries || entries.length === 0) return "";

		// 1. Find the last compaction summary (most recent compaction)
		let compactionSummary = "";
		for (let i = entries.length - 1; i >= 0; i--) {
			if (entries[i].type === "compaction" && (entries[i] as any).summary) {
				compactionSummary = (entries[i] as any).summary;
				break;
			}
		}

		// 2. Collect last 10 message entries and extract text/tool-calls
		const messageEntries = entries.filter((e: any) => e.type === "message");
		const recentMessages = messageEntries.slice(-10);

		const messageParts: string[] = [];
		for (const entry of recentMessages) {
			const msg = (entry as any).message;
			if (!msg) continue;

			const role = msg.role;
			if (role === "user") {
				const text = extractTextFromContent(msg.content);
				if (text) messageParts.push(`User: ${text}`);
				continue;
			}

			if (role === "assistant") {
				const content = msg.content;
				if (typeof content === "string") {
					if (content) messageParts.push(`Assistant: ${content}`);
					continue;
				}

				if (Array.isArray(content)) {
					for (const part of content) {
						if (!part || typeof part !== "object") continue;
						if (part.type === "text" && typeof (part as any).text === "string" && (part as any).text) {
							messageParts.push(`Assistant: ${(part as any).text}`);
							continue;
						}
						if (part.type === "toolCall") {
							const toolName = typeof (part as any).name === "string" ? (part as any).name : "tool";
							const argsText = stringifyToolCallArguments((part as any).arguments);
							messageParts.push(
								argsText ? `Assistant ToolCall (${toolName}): ${argsText}` : `Assistant ToolCall (${toolName})`,
							);
						}
					}
					continue;
				}

				const text = extractTextFromContent(content);
				if (text) messageParts.push(`Assistant: ${text}`);
			}
			// Skip toolResult, custom, and other role types
		}

		// 3. Collect subagent completion results from custom_message entries
		const subagentParts: string[] = [];
		for (const entry of entries) {
			if (entry.type !== "custom_message") continue;
			const cm = entry as any;
			if (cm.customType !== "subagent-command") continue;
			// Only include displayed entries (completed/failed/error — not "started" noise)
			if (!cm.display) continue;

			const raw = extractTextFromContent(cm.content);
			if (!raw) continue;

			// Truncate overly long results
			const text =
				raw.length > SUBAGENT_RESULT_MAX_CHARS ? `${raw.slice(0, SUBAGENT_RESULT_MAX_CHARS)}\n... [truncated]` : raw;
			subagentParts.push(text);
		}

		// 4. Combine compaction summary + recent messages + subagent results
		const parts: string[] = [];
		if (compactionSummary) {
			parts.push(compactionSummary);
		}
		if (messageParts.length > 0) {
			parts.push("[Recent Conversation]\n" + messageParts.join("\n\n"));
		}
		if (subagentParts.length > 0) {
			parts.push("[Subagent Results]\n" + subagentParts.join("\n\n---\n\n"));
		}

		return parts.join("\n\n");
	} catch {
		return "";
	}
}

/**
 * Wrap a task string with main session context text.
 *
 * When available, also provides the main session JSONL path so subagents can
 * inspect deeper history on demand (instead of receiving the entire log inline).
 */
export function wrapTaskWithMainContext(
	task: string,
	contextText: string,
	options?: { mainSessionFile?: string },
): string {
	const rawSessionFile = options?.mainSessionFile;
	const sessionFile =
		typeof rawSessionFile === "string"
			? rawSessionFile.replace(/[\r\n\t]+/g, "").trim() || undefined
			: undefined;

	if (!contextText && !sessionFile) return task;

	const sections: string[] = [];
	if (contextText) {
		sections.push(`[Main Session Context]\n${contextText}`);
	}
	if (sessionFile) {
		sections.push(
			[
				"[Main Session Log Access]",
				`Main agent session JSONL path: ${sessionFile}`,
				"If deeper history is needed, inspect this file on demand.",
				"Use targeted reads first (search keywords, then read with offset/limit).",
				"Avoid dumping entire logs into context; summarize only relevant parts.",
			].join("\n"),
		);
	}
	sections.push(`[Request]\n${task}`);

	return sections.join("\n\n");
}

export function writePromptToTempFile(agentName: string, prompt: string): { dir: string; filePath: string } {
	const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-"));
	const safeName = agentName.replace(/[^\w.-]+/g, "_");
	const filePath = path.join(tmpDir, `prompt-${safeName}.md`);
	fs.writeFileSync(filePath, prompt, { encoding: "utf-8", mode: 0o600 });
	return { dir: tmpDir, filePath };
}
