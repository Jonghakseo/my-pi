import { StringEnum } from "@mariozechner/pi-ai";
import { Type } from "@sinclair/typebox";

// ── Memory Scope & Status ────────────────────────────────────────────────────

export type MemoryScope = "user" | "project";
export type MemoryStatus = "active" | "archived";

// ── Memory Record ────────────────────────────────────────────────────────────

export interface MemoryRecord {
	id: string;
	title: string;
	content: string;
	keywords: string[];
	scope: MemoryScope;
	projectId?: string;
	status: MemoryStatus;
	createdAt: string;
	updatedAt: string;
}

// ── Project ID Resolution ────────────────────────────────────────────────────

export type ProjectIdBasis = "remote" | "commit" | "path";

export interface ProjectIdResult {
	id: string;
	basis: ProjectIdBasis;
}

// ── Tool Parameter Schemas ───────────────────────────────────────────────────

export const RememberParams = Type.Object({
	content: Type.String({ description: "Content to remember (the fact, rule, or lesson to store in long-term memory)" }),
	title: Type.Optional(Type.String({ description: "Short title/summary for the memory (auto-generated if omitted)" })),
});

export const RecallParams = Type.Object({
	query: Type.Optional(
		Type.String({ description: "Search query (keywords or natural language) to find relevant memories" }),
	),
	id: Type.Optional(Type.String({ description: "Retrieve a specific memory by ID" })),
});

export const ForgetParams = Type.Object({
	id: Type.String({ description: "ID of the memory to archive (e.g. 'mem_abc12345')" }),
});

export const MemoryListParams = Type.Object({
	scope: Type.Optional(StringEnum(["user", "project"] as const, { description: "Filter by scope" })),
});
