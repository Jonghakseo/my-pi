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

/**
 * Build a text representation of the main session context for injection into subagent tasks.
 * Instead of copying the entire session file (which causes persona confusion),
 * this extracts a concise text summary: compaction summary + last 10 messages.
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

		// 2. Collect last 10 message entries and extract text
		const messageEntries = entries.filter((e: any) => e.type === "message");
		const recentMessages = messageEntries.slice(-10);

		const messageParts: string[] = [];
		for (const entry of recentMessages) {
			const msg = (entry as any).message;
			if (!msg) continue;

			const role = msg.role;
			if (role === "user") {
				const text = extractTextFromContent(msg.content);
				if (text) {
					const truncated = text.length > 500 ? `${text.slice(0, 500)}...` : text;
					messageParts.push(`User: ${truncated}`);
				}
			} else if (role === "assistant") {
				const text = extractTextFromContent(msg.content);
				if (text) {
					const truncated = text.length > 500 ? `${text.slice(0, 500)}...` : text;
					messageParts.push(`Assistant: ${truncated}`);
				}
			}
			// Skip toolResult, custom, and other role types
		}

		// 3. Combine compaction summary + recent messages
		const parts: string[] = [];
		if (compactionSummary) {
			parts.push(compactionSummary);
		}
		if (messageParts.length > 0) {
			parts.push("[Recent Conversation]\n" + messageParts.join("\n\n"));
		}

		let result = parts.join("\n\n");

		// 4. Truncate to 8000 chars
		if (result.length > 8000) {
			result = result.slice(0, 8000) + "\n... [truncated]";
		}

		return result;
	} catch {
		return "";
	}
}

/**
 * Wrap a task string with main session context text.
 * Returns the original task if contextText is empty.
 */
export function wrapTaskWithMainContext(task: string, contextText: string): string {
	if (!contextText) return task;
	return `[Main Session Context]\n${contextText}\n\n[Your Task]\n${task}`;
}

export function writePromptToTempFile(agentName: string, prompt: string): { dir: string; filePath: string } {
	const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-"));
	const safeName = agentName.replace(/[^\w.-]+/g, "_");
	const filePath = path.join(tmpDir, `prompt-${safeName}.md`);
	fs.writeFileSync(filePath, prompt, { encoding: "utf-8", mode: 0o600 });
	return { dir: tmpDir, filePath };
}
