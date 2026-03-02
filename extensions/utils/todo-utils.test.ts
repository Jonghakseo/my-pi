import { describe, expect, it } from "vitest";
import {
	buildRefinePrompt,
	buildTodoSearchText,
	getTodoStatus,
	getTodoTitle,
	inferMetadataFromText,
	isTodoClosed,
	normalizeDueDate,
	normalizeEstimate,
	normalizePriority,
	normalizeTodoId,
	normalizeTodoSettings,
	normalizeTodoTags,
	parseStructuredTag,
	parseTodoFrontMatter,
	resolveTodoMetadataOverrides,
	sortTodos,
	splitFrontMatter,
	splitTodosByAssignment,
	TODO_ID_PREFIX,
	type TodoFrontMatter,
	validateTodoId,
} from "./todo-utils.ts";

// ── Helper ───────────────────────────────────────────────────────────────────

function mkTodo(overrides: Partial<TodoFrontMatter> = {}): TodoFrontMatter {
	return {
		id: "deadbeef",
		title: "Test todo",
		tags: [],
		status: "open",
		created_at: "2026-01-01T00:00:00Z",
		...overrides,
	};
}

// ── normalizeTodoId ──────────────────────────────────────────────────────────

describe("normalizeTodoId", () => {
	it("should strip TODO- prefix", () => {
		expect(normalizeTodoId("TODO-deadbeef")).toBe("deadbeef");
	});

	it("should strip # prefix", () => {
		expect(normalizeTodoId("#TODO-deadbeef")).toBe("deadbeef");
	});

	it("should handle raw hex", () => {
		expect(normalizeTodoId("deadbeef")).toBe("deadbeef");
	});

	it("should trim whitespace", () => {
		expect(normalizeTodoId("  TODO-deadbeef  ")).toBe("deadbeef");
	});

	it("should handle case-insensitive prefix", () => {
		expect(normalizeTodoId("todo-DEADBEEF")).toBe("DEADBEEF");
	});
});

// ── validateTodoId ───────────────────────────────────────────────────────────

describe("validateTodoId", () => {
	it("should accept valid 8-char hex", () => {
		const result = validateTodoId("TODO-deadbeef");
		expect("id" in result).toBe(true);
		if ("id" in result) expect(result.id).toBe("deadbeef");
	});

	it("should reject non-hex characters", () => {
		const result = validateTodoId("TODO-zzzzzzzz");
		expect("error" in result).toBe(true);
	});

	it("should reject too-short id", () => {
		const result = validateTodoId("TODO-abc");
		expect("error" in result).toBe(true);
	});

	it("should reject empty id", () => {
		const result = validateTodoId("");
		expect("error" in result).toBe(true);
	});

	it("should lowercase the result", () => {
		const result = validateTodoId("DEADBEEF");
		expect("id" in result).toBe(true);
		if ("id" in result) expect(result.id).toBe("deadbeef");
	});
});

// ── isTodoClosed ─────────────────────────────────────────────────────────────

describe("isTodoClosed", () => {
	it("should return true for 'closed'", () => {
		expect(isTodoClosed("closed")).toBe(true);
	});

	it("should return true for 'done'", () => {
		expect(isTodoClosed("done")).toBe(true);
	});

	it("should return true case-insensitively", () => {
		expect(isTodoClosed("Closed")).toBe(true);
		expect(isTodoClosed("DONE")).toBe(true);
	});

	it("should return false for 'open'", () => {
		expect(isTodoClosed("open")).toBe(false);
	});

	it("should return false for empty string", () => {
		expect(isTodoClosed("")).toBe(false);
	});
});

// ── normalizeTodoTags ────────────────────────────────────────────────────────

describe("normalizeTodoTags", () => {
	it("should trim and filter empty tags", () => {
		expect(normalizeTodoTags(["  tag1  ", "", "  ", "tag2"])).toEqual(["tag1", "tag2"]);
	});

	it("should deduplicate", () => {
		expect(normalizeTodoTags(["a", "b", "a"])).toEqual(["a", "b"]);
	});

	it("should return empty for undefined", () => {
		expect(normalizeTodoTags(undefined)).toEqual([]);
	});

	it("should return empty for non-array", () => {
		expect(normalizeTodoTags("not-array" as unknown as string[])).toEqual([]);
	});
});

// ── normalizePriority ────────────────────────────────────────────────────────

describe("normalizePriority", () => {
	it("should normalize Korean priorities", () => {
		expect(normalizePriority("상")).toBe("high");
		expect(normalizePriority("중")).toBe("medium");
		expect(normalizePriority("하")).toBe("low");
	});

	it("should normalize English priorities", () => {
		expect(normalizePriority("high")).toBe("high");
		expect(normalizePriority("medium")).toBe("medium");
		expect(normalizePriority("low")).toBe("low");
	});

	it("should handle case insensitivity", () => {
		expect(normalizePriority("HIGH")).toBe("high");
		expect(normalizePriority("Medium")).toBe("medium");
	});

	it("should handle P-prefix format", () => {
		expect(normalizePriority("P-상")).toBe("high");
		expect(normalizePriority("p:중")).toBe("medium");
	});

	it("should handle numeric priorities", () => {
		expect(normalizePriority("0")).toBe("high");
		expect(normalizePriority("1")).toBe("high");
		expect(normalizePriority("2")).toBe("medium");
		expect(normalizePriority("3")).toBe("low");
	});

	it("should handle urgent/긴급", () => {
		expect(normalizePriority("urgent")).toBe("high");
		expect(normalizePriority("긴급")).toBe("high");
	});

	it("should return undefined for unknown values", () => {
		expect(normalizePriority("critical")).toBeUndefined();
		expect(normalizePriority("")).toBeUndefined();
		expect(normalizePriority(undefined)).toBeUndefined();
	});
});

// ── normalizeDueDate ─────────────────────────────────────────────────────────

describe("normalizeDueDate", () => {
	it("should normalize YYYY-MM-DD", () => {
		expect(normalizeDueDate("2026-03-15")).toBe("2026-03-15");
	});

	it("should accept dots as separator", () => {
		expect(normalizeDueDate("2026.03.15")).toBe("2026-03-15");
	});

	it("should accept slashes as separator", () => {
		expect(normalizeDueDate("2026/03/15")).toBe("2026-03-15");
	});

	it("should zero-pad single-digit months/days", () => {
		expect(normalizeDueDate("2026-3-5")).toBe("2026-03-05");
	});

	it("should reject invalid dates", () => {
		expect(normalizeDueDate("2026-02-30")).toBeUndefined(); // Feb 30 doesn't exist
		expect(normalizeDueDate("2026-13-01")).toBeUndefined(); // month 13
		expect(normalizeDueDate("2026-00-01")).toBeUndefined(); // month 0
	});

	it("should return undefined for non-date strings", () => {
		expect(normalizeDueDate("tomorrow")).toBeUndefined();
		expect(normalizeDueDate("")).toBeUndefined();
		expect(normalizeDueDate(undefined)).toBeUndefined();
	});
});

// ── normalizeEstimate ────────────────────────────────────────────────────────

describe("normalizeEstimate", () => {
	it("should trim and normalize spaces", () => {
		expect(normalizeEstimate("  2   hours  ")).toBe("2 hours");
	});

	it("should return undefined for empty", () => {
		expect(normalizeEstimate("")).toBeUndefined();
		expect(normalizeEstimate("   ")).toBeUndefined();
	});

	it("should return undefined for undefined", () => {
		expect(normalizeEstimate(undefined)).toBeUndefined();
	});

	it("should keep Korean estimates", () => {
		expect(normalizeEstimate("반나절")).toBe("반나절");
		expect(normalizeEstimate("하루")).toBe("하루");
	});
});

// ── parseStructuredTag ───────────────────────────────────────────────────────

describe("parseStructuredTag", () => {
	it("should parse priority short form", () => {
		expect(parseStructuredTag("P-상")).toEqual({ field: "priority", value: "상" });
		expect(parseStructuredTag("p:중")).toEqual({ field: "priority", value: "중" });
	});

	it("should parse priority long form", () => {
		expect(parseStructuredTag("priority: high")).toEqual({ field: "priority", value: "high" });
		expect(parseStructuredTag("우선순위=상")).toEqual({ field: "priority", value: "상" });
	});

	it("should parse due date", () => {
		expect(parseStructuredTag("due:2026-03-15")).toEqual({ field: "due_date", value: "2026-03-15" });
		expect(parseStructuredTag("마감일=2026-03-15")).toEqual({ field: "due_date", value: "2026-03-15" });
	});

	it("should parse estimate", () => {
		expect(parseStructuredTag("est:2h")).toEqual({ field: "estimate", value: "2h" });
		expect(parseStructuredTag("소요시간=반나절")).toEqual({ field: "estimate", value: "반나절" });
	});

	it("should return null for non-structured tags", () => {
		expect(parseStructuredTag("frontend")).toBeNull();
		expect(parseStructuredTag("urgent")).toBeNull();
		expect(parseStructuredTag("")).toBeNull();
	});
});

// ── inferMetadataFromText ────────────────────────────────────────────────────

describe("inferMetadataFromText", () => {
	it("should infer due date from text", () => {
		const result = inferMetadataFromText("마감일: 2026-03-15");
		expect(result.due_date).toBe("2026-03-15");
	});

	it("should infer priority from text", () => {
		const result = inferMetadataFromText("우선순위: 상");
		expect(result.priority).toBe("high");
	});

	it("should infer estimate from text", () => {
		const result = inferMetadataFromText("소요시간: 2시간");
		expect(result.estimate).toBe("2시간");
	});

	it("should infer compact priority with numeric format", () => {
		const result = inferMetadataFromText("Task title P-1 needs work");
		expect(result.priority).toBe("high");
	});

	it("should infer compact priority P-상 only at word boundary (known regex limitation with Korean)", () => {
		// \b word boundary doesn't work with Korean chars so "P-상" in mid-sentence
		// won't match. This tests the actual behavior from the original code.
		const result = inferMetadataFromText("Task title P-상 needs work");
		// Korean chars after \b don't trigger word boundary match
		expect(result.priority).toBeUndefined();
	});

	it("should return empty for no metadata", () => {
		const result = inferMetadataFromText("just a plain title");
		expect(result).toEqual({});
	});
});

// ── resolveTodoMetadataOverrides ─────────────────────────────────────────────

describe("resolveTodoMetadataOverrides", () => {
	it("should resolve priority", () => {
		const result = resolveTodoMetadataOverrides({ priority: "high" });
		expect(result.priorityProvided).toBe(true);
		expect(result.priority).toBe("high");
		expect(result.error).toBeUndefined();
	});

	it("should resolve Korean priority", () => {
		const result = resolveTodoMetadataOverrides({ priority: "상" });
		expect(result.priority).toBe("high");
	});

	it("should error for invalid priority", () => {
		const result = resolveTodoMetadataOverrides({ priority: "critical" });
		expect(result.error).toContain("Invalid priority");
	});

	it("should resolve dueDate", () => {
		const result = resolveTodoMetadataOverrides({ dueDate: "2026-03-15" });
		expect(result.dueDateProvided).toBe(true);
		expect(result.due_date).toBe("2026-03-15");
	});

	it("should accept due_date alias", () => {
		const result = resolveTodoMetadataOverrides({ due_date: "2026-03-15" });
		expect(result.dueDateProvided).toBe(true);
		expect(result.due_date).toBe("2026-03-15");
	});

	it("should resolve estimate", () => {
		const result = resolveTodoMetadataOverrides({ estimate: "2h" });
		expect(result.estimateProvided).toBe(true);
		expect(result.estimate).toBe("2h");
	});

	it("should clear fields with empty strings", () => {
		const result = resolveTodoMetadataOverrides({ priority: "", dueDate: "", estimate: "" });
		expect(result.priorityProvided).toBe(true);
		expect(result.priority).toBeUndefined();
		expect(result.dueDateProvided).toBe(true);
		expect(result.due_date).toBeUndefined();
		expect(result.estimateProvided).toBe(true);
		expect(result.estimate).toBeUndefined();
	});

	it("should return no overrides when no params", () => {
		const result = resolveTodoMetadataOverrides({});
		expect(result.priorityProvided).toBe(false);
		expect(result.dueDateProvided).toBe(false);
		expect(result.estimateProvided).toBe(false);
	});
});

// ── sortTodos ────────────────────────────────────────────────────────────────

describe("sortTodos", () => {
	it("should put open todos before closed", () => {
		const todos = [mkTodo({ status: "closed" }), mkTodo({ status: "open" })];
		const sorted = sortTodos(todos);
		expect(sorted[0].status).toBe("open");
		expect(sorted[1].status).toBe("closed");
	});

	it("should put assigned open todos first", () => {
		const todos = [
			mkTodo({ status: "open", assigned_to_session: undefined }),
			mkTodo({ status: "open", assigned_to_session: "session1" }),
		];
		const sorted = sortTodos(todos);
		expect(sorted[0].assigned_to_session).toBe("session1");
	});

	it("should sort by created_at within groups", () => {
		const todos = [
			mkTodo({ status: "open", created_at: "2026-02-01T00:00:00Z" }),
			mkTodo({ status: "open", created_at: "2026-01-01T00:00:00Z" }),
		];
		const sorted = sortTodos(todos);
		expect(sorted[0].created_at).toBe("2026-01-01T00:00:00Z");
	});

	it("should not mutate original array", () => {
		const todos = [mkTodo({ status: "closed" }), mkTodo({ status: "open" })];
		const sorted = sortTodos(todos);
		expect(sorted).not.toBe(todos);
		expect(todos[0].status).toBe("closed"); // unchanged
	});
});

// ── buildTodoSearchText ──────────────────────────────────────────────────────

describe("buildTodoSearchText", () => {
	it("should include id, title, status", () => {
		const text = buildTodoSearchText(mkTodo({ id: "abcd1234", title: "my task", status: "open" }));
		expect(text).toContain("TODO-abcd1234");
		expect(text).toContain("my task");
		expect(text).toContain("open");
	});

	it("should include tags", () => {
		const text = buildTodoSearchText(mkTodo({ tags: ["frontend", "urgent"] }));
		expect(text).toContain("frontend urgent");
	});

	it("should include metadata", () => {
		const text = buildTodoSearchText(mkTodo({ priority: "high", due_date: "2026-03-15", estimate: "2h" }));
		expect(text).toContain("P:high");
		expect(text).toContain("due:2026-03-15");
		expect(text).toContain("est:2h");
	});
});

// ── splitTodosByAssignment ───────────────────────────────────────────────────

describe("splitTodosByAssignment", () => {
	it("should split into three groups", () => {
		const todos = [
			mkTodo({ status: "open", assigned_to_session: "s1" }),
			mkTodo({ status: "open" }),
			mkTodo({ status: "closed" }),
		];
		const { assignedTodos, openTodos, closedTodos } = splitTodosByAssignment(todos);
		expect(assignedTodos).toHaveLength(1);
		expect(openTodos).toHaveLength(1);
		expect(closedTodos).toHaveLength(1);
	});

	it("should put closed+assigned into closed (not assigned)", () => {
		const todos = [mkTodo({ status: "done", assigned_to_session: "s1" })];
		const { assignedTodos, closedTodos } = splitTodosByAssignment(todos);
		expect(assignedTodos).toHaveLength(0);
		expect(closedTodos).toHaveLength(1);
	});

	it("should handle empty array", () => {
		const { assignedTodos, openTodos, closedTodos } = splitTodosByAssignment([]);
		expect(assignedTodos).toHaveLength(0);
		expect(openTodos).toHaveLength(0);
		expect(closedTodos).toHaveLength(0);
	});
});

// ── normalizeTodoSettings ────────────────────────────────────────────────────

describe("normalizeTodoSettings", () => {
	it("should return defaults for empty object", () => {
		const result = normalizeTodoSettings({});
		expect(result.gc).toBe(true);
		expect(result.gcDays).toBe(7);
	});

	it("should respect provided values", () => {
		const result = normalizeTodoSettings({ gc: false, gcDays: 14 });
		expect(result.gc).toBe(false);
		expect(result.gcDays).toBe(14);
	});

	it("should floor gcDays", () => {
		const result = normalizeTodoSettings({ gcDays: 7.5 });
		expect(result.gcDays).toBe(7);
	});

	it("should clamp negative gcDays to 0", () => {
		const result = normalizeTodoSettings({ gcDays: -5 });
		expect(result.gcDays).toBe(0);
	});
});

// ── getTodoTitle / getTodoStatus ─────────────────────────────────────────────

describe("getTodoTitle", () => {
	it("should return title", () => {
		expect(getTodoTitle(mkTodo({ title: "My Task" }))).toBe("My Task");
	});

	it("should return (untitled) for empty title", () => {
		expect(getTodoTitle(mkTodo({ title: "" }))).toBe("(untitled)");
	});
});

describe("getTodoStatus", () => {
	it("should return status", () => {
		expect(getTodoStatus(mkTodo({ status: "in-progress" }))).toBe("in-progress");
	});

	it("should return 'open' for empty status", () => {
		expect(getTodoStatus(mkTodo({ status: "" }))).toBe("open");
	});
});

// ── buildRefinePrompt ────────────────────────────────────────────────────────

describe("buildRefinePrompt", () => {
	it("should include todo id and title", () => {
		const result = buildRefinePrompt("deadbeef", "Add tests");
		expect(result).toContain("TODO-deadbeef");
		expect(result).toContain("Add tests");
	});

	it("should include instruction keywords", () => {
		const result = buildRefinePrompt("abcd1234", "task");
		expect(result).toContain("refine");
		expect(result).toContain("priority");
		expect(result).toContain("due date");
	});
});

// ── splitFrontMatter ─────────────────────────────────────────────────────────

describe("splitFrontMatter", () => {
	it("should split JSON front matter from body", () => {
		const content = '{"id":"abc"}\n\nBody text here';
		const { frontMatter, body } = splitFrontMatter(content);
		expect(frontMatter).toBe('{"id":"abc"}');
		expect(body).toBe("Body text here");
	});

	it("should return empty front matter for non-JSON content", () => {
		const { frontMatter, body } = splitFrontMatter("Just plain text");
		expect(frontMatter).toBe("");
		expect(body).toBe("Just plain text");
	});

	it("should handle content with only front matter", () => {
		const { frontMatter, body } = splitFrontMatter('{"id":"abc"}');
		expect(frontMatter).toBe('{"id":"abc"}');
		expect(body).toBe("");
	});
});

// ── parseTodoFrontMatter ─────────────────────────────────────────────────────

describe("parseTodoFrontMatter", () => {
	it("should parse valid JSON", () => {
		const json = JSON.stringify({ id: "abc", title: "Test", status: "open", tags: ["tag1"] });
		const result = parseTodoFrontMatter(json, "fallback");
		expect(result.id).toBe("abc");
		expect(result.title).toBe("Test");
		expect(result.tags).toEqual(["tag1"]);
	});

	it("should use fallback id for empty input", () => {
		const result = parseTodoFrontMatter("", "fallback");
		expect(result.id).toBe("fallback");
		expect(result.status).toBe("open");
	});

	it("should handle malformed JSON", () => {
		const result = parseTodoFrontMatter("not json", "fallback");
		expect(result.id).toBe("fallback");
	});

	it("should normalize priority and due_date", () => {
		const json = JSON.stringify({ priority: "상", due_date: "2026.03.15" });
		const result = parseTodoFrontMatter(json, "id");
		expect(result.priority).toBe("high");
		expect(result.due_date).toBe("2026-03-15");
	});
});
