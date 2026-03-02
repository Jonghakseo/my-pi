import { getAllActiveMemories } from "./storage.ts";

// ── Catalog Hint ─────────────────────────────────────────────────────────────

/**
 * Build a catalog listing all active memories (title + ID + scope).
 * Appended to systemPrompt every turn so the LLM knows what's available.
 * Detailed content is accessed via the `recall` tool.
 */
export async function buildCatalogHint(projectId?: string): Promise<string | null> {
	const allActive = await getAllActiveMemories(projectId);
	if (!allActive.length) return null;

	const lines = [`\n\n[Memory Layer] 접근 가능한 기억 ${allActive.length}건:`];

	for (const mem of allActive) {
		lines.push(`- [${mem.id}] ${mem.title} (${mem.scope})`);
	}

	lines.push("세부 내용이 필요하면 recall 도구를 사용하세요.");

	return lines.join("\n");
}
