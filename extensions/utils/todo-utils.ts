/**
 * Pure utility functions extracted from todos.ts.
 * These handle todo ID normalization, metadata parsing, sorting, and classification.
 *
 * NOTE: format-related functions (formatTodoId, formatPriority, formatTodoHeading,
 * formatTodoMetadataParts, formatTodoMetadataSuffix, formatTodoList) are in
 * format-utils.ts to avoid duplication.
 */

import { findJsonObjectEnd } from "./parse-utils.ts";

// ── Constants ────────────────────────────────────────────────────────────────

export const TODO_ID_PREFIX = "TODO-";
export const TODO_ID_PATTERN = /^[a-f0-9]{8}$/i;

export const DEFAULT_TODO_SETTINGS = {
	gc: true,
	gcDays: 7,
};

// ── Types ────────────────────────────────────────────────────────────────────

export type TodoPriority = "high" | "medium" | "low";

export interface TodoFrontMatter {
	id: string;
	title: string;
	tags: string[];
	status: string;
	created_at: string;
	assigned_to_session?: string;
	priority?: TodoPriority;
	due_date?: string;
	estimate?: string;
}

export interface TodoRecord extends TodoFrontMatter {
	body: string;
}

export interface TodoSettings {
	gc: boolean;
	gcDays: number;
}

export interface TodoMetadataOverrides {
	priorityProvided: boolean;
	priority?: TodoPriority;
	dueDateProvided: boolean;
	due_date?: string;
	estimateProvided: boolean;
	estimate?: string;
	error?: string;
}

// ── ID Normalization / Validation ────────────────────────────────────────────

/**
 * Normalize a todo ID by stripping prefix characters (#, TODO-).
 */
export function normalizeTodoId(id: string): string {
	let trimmed = id.trim();
	if (trimmed.startsWith("#")) {
		trimmed = trimmed.slice(1);
	}
	if (trimmed.toUpperCase().startsWith(TODO_ID_PREFIX)) {
		trimmed = trimmed.slice(TODO_ID_PREFIX.length);
	}
	return trimmed;
}

/**
 * Validate a todo ID format. Returns normalized id or error.
 */
export function validateTodoId(id: string): { id: string } | { error: string } {
	const normalized = normalizeTodoId(id);
	if (!normalized || !TODO_ID_PATTERN.test(normalized)) {
		return { error: "Invalid todo id. Expected TODO-<hex>." };
	}
	return { id: normalized.toLowerCase() };
}

/**
 * Check if a todo status indicates it's closed.
 */
export function isTodoClosed(status: string): boolean {
	return ["closed", "done"].includes(status.toLowerCase());
}

// ── Tag Normalization ────────────────────────────────────────────────────────

/**
 * Normalize an array of tags: trim, deduplicate, filter empties.
 */
export function normalizeTodoTags(tags: string[] | undefined): string[] {
	if (!Array.isArray(tags)) return [];
	const normalized: string[] = [];
	for (const rawTag of tags) {
		if (typeof rawTag !== "string") continue;
		const tag = rawTag.trim();
		if (!tag || normalized.includes(tag)) continue;
		normalized.push(tag);
	}
	return normalized;
}

// ── Priority ─────────────────────────────────────────────────────────────────

/**
 * Normalize a priority string to a TodoPriority or undefined.
 * Accepts: 상/중/하, high/medium/low, urgent, P-상, priority:high, etc.
 */
export function normalizePriority(value: string | undefined): TodoPriority | undefined {
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim().toLowerCase();
	if (!trimmed) return undefined;

	const compact = trimmed.replace(/\s+/g, "");
	const candidate = compact
		.replace(/^priority[:=]/, "")
		.replace(/^우선순위[:=]/, "")
		.replace(/^p[-_:]/, "")
		.replace(/^p([0-3])$/, "$1");

	if (["상", "high", "highest", "urgent", "긴급", "0", "1"].includes(candidate)) {
		return "high";
	}
	if (["중", "medium", "normal", "2"].includes(candidate)) {
		return "medium";
	}
	if (["하", "low", "lowest", "3"].includes(candidate)) {
		return "low";
	}
	return undefined;
}

// ── Due Date ─────────────────────────────────────────────────────────────────

/**
 * Normalize a due date string to YYYY-MM-DD format.
 * Accepts various separators (-, ., /) and validates the date.
 */
export function normalizeDueDate(value: string | undefined): string | undefined {
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	if (!trimmed) return undefined;
	const normalized = trimmed.replace(/[./]/g, "-");
	const match = normalized.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
	if (!match) return undefined;

	const year = Number(match[1]);
	const month = Number(match[2]);
	const day = Number(match[3]);
	if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day)) {
		return undefined;
	}
	if (month < 1 || month > 12 || day < 1 || day > 31) {
		return undefined;
	}

	const date = new Date(Date.UTC(year, month - 1, day));
	if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
		return undefined;
	}

	const monthText = String(month).padStart(2, "0");
	const dayText = String(day).padStart(2, "0");
	return `${year}-${monthText}-${dayText}`;
}

// ── Estimate ─────────────────────────────────────────────────────────────────

/**
 * Normalize an estimate string: trim whitespace, collapse internal spaces.
 */
export function normalizeEstimate(value: string | undefined): string | undefined {
	if (typeof value !== "string") return undefined;
	const normalized = value.trim().replace(/\s+/g, " ");
	return normalized || undefined;
}

// ── Structured Tag Parsing ───────────────────────────────────────────────────

/**
 * Parse a tag string to see if it encodes a structured field (priority, due_date, estimate).
 */
export function parseStructuredTag(
	tag: string,
):
	| { field: "priority"; value: string }
	| { field: "due_date"; value: string }
	| { field: "estimate"; value: string }
	| null {
	const trimmed = tag.trim();
	if (!trimmed) return null;

	const priorityShort = trimmed.match(/^p[-_:]?(상|중|하)$/i);
	if (priorityShort) {
		return { field: "priority", value: priorityShort[1] };
	}

	const priorityMatch = trimmed.match(/^(?:priority|prio|우선순위)\s*[:=]\s*(.+)$/i);
	if (priorityMatch) {
		return { field: "priority", value: priorityMatch[1] };
	}

	const dueMatch = trimmed.match(/^(?:due|deadline|마감(?:일)?)\s*[:=]\s*(.+)$/i);
	if (dueMatch) {
		return { field: "due_date", value: dueMatch[1] };
	}

	const estimateMatch = trimmed.match(
		/^(?:est|estimate|eta|duration|소요(?:시간)?|예상\s*소요(?:시간)?)\s*[:=]\s*(.+)$/i,
	);
	if (estimateMatch) {
		return { field: "estimate", value: estimateMatch[1] };
	}

	return null;
}

/**
 * Infer priority, due_date, estimate from natural text.
 */
export function inferMetadataFromText(
	text: string,
): Partial<Pick<TodoFrontMatter, "priority" | "due_date" | "estimate">> {
	const metadata: Partial<Pick<TodoFrontMatter, "priority" | "due_date" | "estimate">> = {};

	const dueMatch = text.match(/(?:마감(?:일)?|due(?:\s*date)?|deadline)\s*[:=]\s*(\d{4}[./-]\d{1,2}[./-]\d{1,2})/i);
	if (dueMatch) {
		const normalized = normalizeDueDate(dueMatch[1]);
		if (normalized) metadata.due_date = normalized;
	}

	const priorityMatch = text.match(/(?:우선순위|priority)\s*[:=]\s*(상|중|하|high|medium|low)/i);
	if (priorityMatch) {
		const normalized = normalizePriority(priorityMatch[1]);
		if (normalized) metadata.priority = normalized;
	}

	if (!metadata.priority) {
		const compactPriority = text.match(/\bP[-_:]?(상|중|하|0|1|2|3)\b/i);
		if (compactPriority) {
			const normalized = normalizePriority(compactPriority[1]);
			if (normalized) metadata.priority = normalized;
		}
	}

	const estimateMatch = text.match(/(?:예상\s*소요(?:시간)?|소요(?:시간)?|estimate|est)\s*[:=]\s*([^\n,;]+)/i);
	if (estimateMatch) {
		const normalized = normalizeEstimate(estimateMatch[1]);
		if (normalized) metadata.estimate = normalized;
	}

	return metadata;
}

// ── Metadata Override Resolution ─────────────────────────────────────────────

/**
 * Resolve metadata overrides from tool params (priority, dueDate, estimate).
 */
export function resolveTodoMetadataOverrides(params: Record<string, unknown>): TodoMetadataOverrides {
	const overrides: TodoMetadataOverrides = {
		priorityProvided: false,
		dueDateProvided: false,
		estimateProvided: false,
	};

	if (Object.hasOwn(params, "priority")) {
		overrides.priorityProvided = true;
		if (typeof params.priority !== "string") {
			return { ...overrides, error: "priority must be a string" };
		}
		if (params.priority.trim()) {
			const normalized = normalizePriority(params.priority);
			if (!normalized) {
				return { ...overrides, error: "Invalid priority. Use high/medium/low or 상/중/하." };
			}
			overrides.priority = normalized;
		}
	}

	let dueDateProvided = false;
	let dueDateRaw: unknown;
	for (const key of ["dueDate", "due_date", "duedate"]) {
		if (Object.hasOwn(params, key)) {
			dueDateProvided = true;
			dueDateRaw = params[key];
			break;
		}
	}
	if (dueDateProvided) {
		overrides.dueDateProvided = true;
		if (typeof dueDateRaw !== "string") {
			return { ...overrides, error: "dueDate must be a string (YYYY-MM-DD)" };
		}
		if (dueDateRaw.trim()) {
			const normalized = normalizeDueDate(dueDateRaw);
			if (!normalized) {
				return { ...overrides, error: "Invalid dueDate. Expected YYYY-MM-DD." };
			}
			overrides.due_date = normalized;
		}
	}

	if (Object.hasOwn(params, "estimate")) {
		overrides.estimateProvided = true;
		if (typeof params.estimate !== "string") {
			return { ...overrides, error: "estimate must be a string" };
		}
		overrides.estimate = normalizeEstimate(params.estimate);
	}

	return overrides;
}

// ── Sorting ──────────────────────────────────────────────────────────────────

/**
 * Sort todos: open (assigned first) → closed, within groups by created_at.
 */
export function sortTodos(todos: TodoFrontMatter[]): TodoFrontMatter[] {
	return [...todos].sort((a, b) => {
		const aClosed = isTodoClosed(a.status);
		const bClosed = isTodoClosed(b.status);
		if (aClosed !== bClosed) return aClosed ? 1 : -1;
		const aAssigned = !aClosed && Boolean(a.assigned_to_session);
		const bAssigned = !bClosed && Boolean(b.assigned_to_session);
		if (aAssigned !== bAssigned) return aAssigned ? -1 : 1;
		return (a.created_at || "").localeCompare(b.created_at || "");
	});
}

// ── Search Text ──────────────────────────────────────────────────────────────

/**
 * Build a searchable text string from a todo's fields.
 */
export function buildTodoSearchText(todo: TodoFrontMatter): string {
	const tags = todo.tags.join(" ");
	const assignment = todo.assigned_to_session ? `assigned:${todo.assigned_to_session}` : "";
	const priorityKorMap: Record<TodoPriority, "상" | "중" | "하"> = {
		high: "상",
		medium: "중",
		low: "하",
	};
	const priorityKor = todo.priority ? priorityKorMap[todo.priority] : "";
	const priorityTokens = todo.priority ? `P:${todo.priority} P:${priorityKor} ${priorityKor}` : "";
	const dueDateLabel = todo.due_date ? `due:${todo.due_date}` : "";
	const estimateLabel = todo.estimate ? `est:${todo.estimate}` : "";
	const rawMetadata = `${todo.priority ?? ""} ${priorityKor} ${todo.due_date ?? ""} ${todo.estimate ?? ""}`;
	return `${TODO_ID_PREFIX}${todo.id} ${todo.id} ${todo.title} ${tags} ${priorityTokens} ${dueDateLabel} ${estimateLabel} ${rawMetadata} ${todo.status} ${assignment}`.trim();
}

// ── Classification ───────────────────────────────────────────────────────────

/**
 * Split todos into assigned, open, and closed groups.
 */
export function splitTodosByAssignment(todos: TodoFrontMatter[]): {
	assignedTodos: TodoFrontMatter[];
	openTodos: TodoFrontMatter[];
	closedTodos: TodoFrontMatter[];
} {
	const assignedTodos: TodoFrontMatter[] = [];
	const openTodos: TodoFrontMatter[] = [];
	const closedTodos: TodoFrontMatter[] = [];
	for (const todo of todos) {
		if (isTodoClosed(todo.status)) {
			closedTodos.push(todo);
			continue;
		}
		if (todo.assigned_to_session) {
			assignedTodos.push(todo);
		} else {
			openTodos.push(todo);
		}
	}
	return { assignedTodos, openTodos, closedTodos };
}

// ── Settings ─────────────────────────────────────────────────────────────────

/**
 * Normalize partial todo settings to full settings with defaults.
 */
export function normalizeTodoSettings(raw: Partial<TodoSettings>): TodoSettings {
	const gc = raw.gc ?? DEFAULT_TODO_SETTINGS.gc;
	const gcDays =
		(Number.isFinite(raw.gcDays) ? raw.gcDays : DEFAULT_TODO_SETTINGS.gcDays) ?? DEFAULT_TODO_SETTINGS.gcDays;
	return {
		gc: Boolean(gc),
		gcDays: Math.max(0, Math.floor(gcDays)),
	};
}

// ── Display Helpers ──────────────────────────────────────────────────────────

/**
 * Get todo title, defaulting to "(untitled)".
 */
export function getTodoTitle(todo: TodoFrontMatter): string {
	return todo.title || "(untitled)";
}

/**
 * Get todo status, defaulting to "open".
 */
export function getTodoStatus(todo: TodoFrontMatter): string {
	return todo.status || "open";
}

/**
 * Build the refine prompt for a todo.
 */
export function buildRefinePrompt(todoId: string, title: string): string {
	return (
		`let's refine task ${TODO_ID_PREFIX}${normalizeTodoId(todoId)} "${title}": ` +
		"Ask me for the missing details needed to refine the todo together. Do not rewrite the todo yet and do not make assumptions. " +
		"Make sure to clarify priority, due date, and estimate as structured fields. " +
		"Ask clear, concrete questions and wait for my answers before drafting any structured description.\n\n"
	);
}

// ── Front Matter Parsing ─────────────────────────────────────────────────────

/**
 * Split todo file content into JSON front matter and markdown body.
 */
export function splitFrontMatter(content: string): { frontMatter: string; body: string } {
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

/**
 * Parse a JSON front matter string into a TodoFrontMatter object.
 */
export function parseTodoFrontMatter(text: string, idFallback: string): TodoFrontMatter {
	const data: TodoFrontMatter = {
		id: idFallback,
		title: "",
		tags: [],
		status: "open",
		created_at: "",
		assigned_to_session: undefined,
		priority: undefined,
		due_date: undefined,
		estimate: undefined,
	};

	const trimmed = text.trim();
	if (!trimmed) return data;

	try {
		const parsed = JSON.parse(trimmed) as Partial<TodoFrontMatter> | null;
		if (!parsed || typeof parsed !== "object") return data;
		if (typeof parsed.id === "string" && parsed.id) data.id = parsed.id;
		if (typeof parsed.title === "string") data.title = parsed.title;
		if (typeof parsed.status === "string" && parsed.status) data.status = parsed.status;
		if (typeof parsed.created_at === "string") data.created_at = parsed.created_at;
		if (typeof parsed.assigned_to_session === "string" && parsed.assigned_to_session.trim()) {
			data.assigned_to_session = parsed.assigned_to_session;
		}
		if (Array.isArray(parsed.tags)) {
			data.tags = parsed.tags.filter((tag): tag is string => typeof tag === "string");
		}
		if (typeof parsed.priority === "string") {
			data.priority = normalizePriority(parsed.priority);
		}
		if (typeof parsed.due_date === "string") {
			data.due_date = normalizeDueDate(parsed.due_date);
		}
		if (typeof parsed.estimate === "string") {
			data.estimate = normalizeEstimate(parsed.estimate);
		}
	} catch {
		return data;
	}

	return data;
}

export function clearAssignmentIfClosed(todo: TodoFrontMatter): void {
	if (isTodoClosed(getTodoStatus(todo))) {
		todo.assigned_to_session = undefined;
	}
}

function sameStringArray(a: string[], b: string[]): boolean {
	if (a.length !== b.length) return false;
	for (let i = 0; i < a.length; i += 1) {
		if (a[i] !== b[i]) return false;
	}
	return true;
}

function applyNormalizedTodoScalars(todo: TodoFrontMatter): boolean {
	let changed = false;
	const normalizedTags = normalizeTodoTags(todo.tags);
	if (!sameStringArray(todo.tags, normalizedTags)) {
		todo.tags = normalizedTags;
		changed = true;
	}
	const normalizedPriority = normalizePriority(todo.priority);
	if (todo.priority !== normalizedPriority) {
		todo.priority = normalizedPriority;
		changed = true;
	}
	const normalizedDueDate = normalizeDueDate(todo.due_date);
	if (todo.due_date !== normalizedDueDate) {
		todo.due_date = normalizedDueDate;
		changed = true;
	}
	const normalizedEstimate = normalizeEstimate(todo.estimate);
	if (todo.estimate !== normalizedEstimate) {
		todo.estimate = normalizedEstimate;
		changed = true;
	}
	return changed;
}

function extractMetadataFromTags(todo: TodoFrontMatter): boolean {
	const remainingTags: string[] = [];
	let extractedPriority: TodoPriority | undefined;
	let extractedDueDate: string | undefined;
	let extractedEstimate: string | undefined;

	for (const tag of todo.tags) {
		const parsed = parseStructuredTag(tag);
		if (!parsed) {
			remainingTags.push(tag);
			continue;
		}
		if (parsed.field === "priority" && !extractedPriority) {
			extractedPriority = normalizePriority(parsed.value);
			continue;
		}
		if (parsed.field === "due_date" && !extractedDueDate) {
			extractedDueDate = normalizeDueDate(parsed.value);
			continue;
		}
		if (parsed.field === "estimate" && !extractedEstimate) {
			extractedEstimate = normalizeEstimate(parsed.value);
		}
	}

	let changed = false;
	if (!sameStringArray(todo.tags, remainingTags)) {
		todo.tags = remainingTags;
		changed = true;
	}
	if (!todo.priority && extractedPriority) {
		todo.priority = extractedPriority;
		changed = true;
	}
	if (!todo.due_date && extractedDueDate) {
		todo.due_date = extractedDueDate;
		changed = true;
	}
	if (!todo.estimate && extractedEstimate) {
		todo.estimate = extractedEstimate;
		changed = true;
	}
	return changed;
}

function applyInferredTodoMetadata(todo: TodoFrontMatter, bodyText?: string): boolean {
	const inferred = inferMetadataFromText(`${todo.title ?? ""}\n${bodyText ?? ""}`);
	let changed = false;
	if (!todo.priority && inferred.priority) {
		todo.priority = inferred.priority;
		changed = true;
	}
	if (!todo.due_date && inferred.due_date) {
		todo.due_date = inferred.due_date;
		changed = true;
	}
	if (!todo.estimate && inferred.estimate) {
		todo.estimate = inferred.estimate;
		changed = true;
	}
	return changed;
}

export function normalizeTodoMetadata(
	todo: TodoFrontMatter,
	options: { inferFromText?: boolean; bodyText?: string; extractFromTags?: boolean } = {},
): boolean {
	let changed = applyNormalizedTodoScalars(todo);
	if (options.extractFromTags ?? true) {
		changed = extractMetadataFromTags(todo) || changed;
	}
	if (options.inferFromText) {
		changed = applyInferredTodoMetadata(todo, options.bodyText) || changed;
	}
	return changed;
}

export function applyTodoMetadataOverrides(todo: TodoFrontMatter, overrides: TodoMetadataOverrides): void {
	if (overrides.priorityProvided) {
		todo.priority = overrides.priority;
	}
	if (overrides.dueDateProvided) {
		todo.due_date = overrides.due_date;
	}
	if (overrides.estimateProvided) {
		todo.estimate = overrides.estimate;
	}
}

export function parseTodoContent(content: string, idFallback: string): TodoRecord {
	const { frontMatter, body } = splitFrontMatter(content);
	const parsed = parseTodoFrontMatter(frontMatter, idFallback);
	const todo: TodoRecord = {
		id: idFallback,
		title: parsed.title,
		tags: parsed.tags ?? [],
		status: parsed.status,
		created_at: parsed.created_at,
		assigned_to_session: parsed.assigned_to_session,
		priority: parsed.priority,
		due_date: parsed.due_date,
		estimate: parsed.estimate,
		body: body ?? "",
	};
	normalizeTodoMetadata(todo, { inferFromText: true, bodyText: todo.body });
	return todo;
}

export function serializeTodo(todo: TodoRecord): string {
	normalizeTodoMetadata(todo, { inferFromText: true, bodyText: todo.body });
	const frontMatter = JSON.stringify(
		{
			id: todo.id,
			title: todo.title,
			tags: todo.tags ?? [],
			status: todo.status,
			created_at: todo.created_at,
			assigned_to_session: todo.assigned_to_session || undefined,
			priority: todo.priority || undefined,
			due_date: todo.due_date || undefined,
			estimate: todo.estimate || undefined,
		},
		null,
		2,
	);

	const body = todo.body ?? "";
	const trimmedBody = body.replace(/^\n+/, "").replace(/\s+$/, "");
	if (!trimmedBody) return `${frontMatter}\n`;
	return `${frontMatter}\n\n${trimmedBody}\n`;
}

export interface FuzzyMatchResult {
	matches: boolean;
	score: number;
}

export type TodoMatcher = (token: string, text: string) => FuzzyMatchResult;

export function filterTodos(todos: TodoFrontMatter[], query: string, matcher: TodoMatcher): TodoFrontMatter[] {
	const trimmed = query.trim();
	if (!trimmed) return todos;

	const tokens = trimmed
		.split(/\s+/)
		.map((token) => token.trim())
		.filter(Boolean);

	if (tokens.length === 0) return todos;

	const matches: Array<{ todo: TodoFrontMatter; score: number }> = [];
	for (const todo of todos) {
		const text = buildTodoSearchText(todo);
		let totalScore = 0;
		let matched = true;
		for (const token of tokens) {
			const result = matcher(token, text);
			if (!result.matches) {
				matched = false;
				break;
			}
			totalScore += result.score;
		}
		if (matched) {
			matches.push({ todo, score: totalScore });
		}
	}

	return matches
		.sort((a, b) => {
			const aClosed = isTodoClosed(a.todo.status);
			const bClosed = isTodoClosed(b.todo.status);
			if (aClosed !== bClosed) return aClosed ? 1 : -1;
			const aAssigned = !aClosed && Boolean(a.todo.assigned_to_session);
			const bAssigned = !bClosed && Boolean(b.todo.assigned_to_session);
			if (aAssigned !== bAssigned) return aAssigned ? -1 : 1;
			return a.score - b.score;
		})
		.map((match) => match.todo);
}
