import { getAllActiveMemories, searchMemories } from "./storage.ts";

// ── First Turn State ─────────────────────────────────────────────────────────

let _isFirstTurn = true;

export function resetFirstTurn(): void {
	_isFirstTurn = true;
}

export function isFirstTurn(): boolean {
	return _isFirstTurn;
}

export function markFirstTurnDone(): void {
	_isFirstTurn = false;
}

// ── Prompt Tokenization ──────────────────────────────────────────────────────

function extractPromptWords(prompt: string): string[] {
	return prompt
		.toLowerCase()
		.replace(/[^\w\uAC00-\uD7AF\u3131-\u3163@.-]/g, " ")
		.split(/\s+/)
		.filter((w) => w.length >= 2);
}

// ── First Turn Injection ─────────────────────────────────────────────────────

const MAX_FIRST_TURN_MEMORIES = 3;

/**
 * Build injection content for the first turn.
 * Matches prompt words against stored keywords.
 *
 * @returns null if no matching memories found.
 */
export async function buildFirstTurnInjection(
	prompt: string,
	projectId?: string,
): Promise<{ content: string; count: number } | null> {
	const promptWords = extractPromptWords(prompt);
	if (!promptWords.length) return null;

	const scored = await searchMemories(promptWords, undefined, projectId);
	if (!scored.length) return null;

	const topMemories = scored.slice(0, MAX_FIRST_TURN_MEMORIES);

	const lines = ["📝 The following memories from previous sessions are relevant to your current task:", ""];

	for (const { memory } of topMemories) {
		lines.push(`**[${memory.id}]** ${memory.title}`);
		lines.push(memory.content);
		lines.push(`  _scope: ${memory.scope} | keywords: ${memory.keywords.join(", ")}_`);
		lines.push("");
	}

	lines.push("Use these memories as context. If additional memories are needed, use the `recall` tool.");

	return { content: lines.join("\n"), count: topMemories.length };
}

// ── Catalog Hint ─────────────────────────────────────────────────────────────

/**
 * Build a compact catalog hint for the system prompt.
 * Lists memory count and top keywords so the LLM knows memories exist.
 */
export async function buildCatalogHint(projectId?: string): Promise<string | null> {
	const allActive = await getAllActiveMemories(projectId);
	if (!allActive.length) return null;

	// Collect keyword frequencies
	const freq = new Map<string, number>();
	for (const mem of allActive) {
		for (const kw of mem.keywords) {
			const lower = kw.toLowerCase();
			freq.set(lower, (freq.get(lower) ?? 0) + 1);
		}
	}

	// Top 15 keywords by frequency
	const topKeywords = [...freq.entries()]
		.sort((a, b) => b[1] - a[1])
		.slice(0, 15)
		.map(([kw]) => kw);

	return (
		`\n\n[Memory Layer] You have access to ${allActive.length} stored memories. ` +
		`Key topics: ${topKeywords.join(", ")}. ` +
		"Use the `recall` tool to search for relevant memories when the user's request relates to these topics."
	);
}
