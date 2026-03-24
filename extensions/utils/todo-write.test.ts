import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { describe, expect, it } from "vitest";
import {
	applyTodoWriteOps,
	buildPostCompactionTodoReminder,
	getTodoWidgetVisibility,
	renderTodoWidgetLines,
	renderTodoWriteSummary,
	restoreTodoWriteState,
} from "../todo-write.js";

describe("todo-write ops", () => {
	it("replaces full state and assigns deterministic ids", () => {
		const result = applyTodoWriteOps({ tasks: [] }, [
			{
				op: "replace",
				tasks: [
					{ content: "Read source", status: "completed" },
					{ content: "Map callsites", status: "in_progress" },
				],
			},
		]);

		expect(result.errors).toEqual([]);
		expect(result.state.tasks[0]?.id).toBe("task-1");
		expect(result.state.tasks[1]?.id).toBe("task-2");
	});

	it("adds task with incrementing ids", () => {
		const start = {
			tasks: [{ id: "task-1", content: "A", status: "pending" as const, notes: "" }],
		};
		const result = applyTodoWriteOps(start, [
			{ op: "add_task", content: "B" },
			{ op: "add_task", content: "C" },
		]);

		expect(result.errors).toEqual([]);
		expect(result.state.tasks[1]?.id).toBe("task-2");
		expect(result.state.tasks[2]?.id).toBe("task-3");
	});

	it("normalizes multiple in_progress tasks instead of erroring", () => {
		const start = {
			tasks: [
				{ id: "task-1", content: "A", status: "in_progress" as const, notes: "" },
				{ id: "task-2", content: "B", status: "pending" as const, notes: "" },
			],
		};
		const result = applyTodoWriteOps(start, [{ op: "update", id: "task-2", status: "in_progress" }]);

		expect(result.errors).toEqual([]);
		expect(result.state.tasks[0]?.status).toBe("in_progress");
		expect(result.state.tasks[1]?.status).toBe("pending");
	});

	it("promotes first pending task to in_progress when none exists", () => {
		const start = {
			tasks: [
				{ id: "task-1", content: "A", status: "pending" as const, notes: "" },
				{ id: "task-2", content: "B", status: "pending" as const, notes: "" },
			],
		};
		const result = applyTodoWriteOps(start, []);

		expect(result.errors).toEqual([]);
		expect(result.state.tasks[0]?.status).toBe("in_progress");
		expect(result.state.tasks[1]?.status).toBe("pending");
	});

	it("removes task and renders summary", () => {
		const start = {
			tasks: [
				{ id: "task-1", content: "A", status: "completed" as const, notes: "" },
				{ id: "task-2", content: "B", status: "pending" as const, notes: "" },
			],
		};
		const result = applyTodoWriteOps(start, [{ op: "remove_task", id: "task-1" }]);
		const summary = renderTodoWriteSummary(result.state, result.errors);

		expect(result.errors).toEqual([]);
		expect(summary).toContain("Remaining items (1):");
		expect(summary).toContain("task-2 B [in_progress]");
	});

	it("accumulates update error when task does not exist", () => {
		const start = {
			tasks: [] as Array<{
				id: string;
				content: string;
				status: "pending" | "in_progress" | "completed" | "abandoned";
			}>,
		};
		const result = applyTodoWriteOps(start, [{ op: "update", id: "task-404", status: "completed" }]);

		expect(result.errors).toContain('Task "task-404" not found');
	});

	it("accumulates remove_task error when task does not exist", () => {
		const start = {
			tasks: [] as Array<{
				id: string;
				content: string;
				status: "pending" | "in_progress" | "completed" | "abandoned";
			}>,
		};
		const result = applyTodoWriteOps(start, [{ op: "remove_task", id: "task-404" }]);

		expect(result.errors).toContain('Task "task-404" not found');
	});

	it("renders empty summary when no tasks remain", () => {
		const state = {
			tasks: [] as Array<{
				id: string;
				content: string;
				status: "pending" | "in_progress" | "completed" | "abandoned";
			}>,
		};
		expect(renderTodoWriteSummary(state)).toBe("Todo list cleared.");
	});

	it("renders widget lines when todos exist", () => {
		const state = {
			tasks: [
				{ id: "task-1", content: "Read source", status: "completed" as const },
				{ id: "task-2", content: "Map callsites", status: "in_progress" as const },
				{ id: "task-3", content: "Write patch", status: "pending" as const },
			],
		};

		const lines = renderTodoWidgetLines(state);
		expect(lines).toEqual(["~~● Read source", "→ Map callsites", "○ Write patch"]);
	});

	it("keeps completed widget visible during grace period", () => {
		const state = {
			tasks: [{ id: "task-1", content: "Done", status: "completed" as const }],
		};

		const visibility = getTodoWidgetVisibility(state, undefined, 3, 1_000);
		expect(visibility.hidden).toBe(false);
		expect(visibility.completionGraceActive).toBe(true);
		expect(visibility.meta).toEqual({ completedAt: 1_000, completedTurn: 3 });
	});

	it("hides completed widget after grace period by time", () => {
		const state = {
			tasks: [{ id: "task-1", content: "Done", status: "completed" as const }],
		};

		const visibility = getTodoWidgetVisibility(state, { completedAt: 1_000, completedTurn: 3 }, 3, 91_500);
		expect(visibility.hidden).toBe(true);
	});

	it("hides completed widget after grace period by turns", () => {
		const state = {
			tasks: [{ id: "task-1", content: "Done", status: "completed" as const }],
		};

		const visibility = getTodoWidgetVisibility(state, { completedAt: 1_000, completedTurn: 3 }, 5, 5_000);
		expect(visibility.hidden).toBe(true);
	});

	it("hides widget when todo state is empty", () => {
		expect(renderTodoWidgetLines({ tasks: [] })).toEqual([]);
	});
});

describe("todo-write persistence", () => {
	it("restores the latest persisted state from custom session entries", () => {
		const ctx = {
			cwd: "/tmp/project",
			sessionManager: {
				getSessionFile: () => "session.jsonl",
				getBranch: () => [
					{
						type: "custom",
						customType: "todo-write-state",
						data: { tasks: [{ id: "task-1", content: "Old", status: "completed" }], updatedAt: 1 },
					},
					{
						type: "custom",
						customType: "todo-write-state",
						data: {
							tasks: [{ id: "task-1", content: "Finish patch", status: "in_progress" as const }],
							updatedAt: 2,
						},
					},
				],
			},
		} as unknown as Pick<ExtensionContext, "cwd" | "sessionManager">;

		const restored = restoreTodoWriteState(ctx);

		expect(restored).toEqual({
			tasks: [{ id: "task-1", content: "Finish patch", status: "in_progress" }],
		});
	});

	it("returns null compaction reminder when no remaining tasks exist", () => {
		const state = {
			tasks: [{ id: "task-1", content: "Ship", status: "completed" as const }],
		};

		expect(buildPostCompactionTodoReminder(state)).toBeNull();
	});

	it("builds a compaction reminder when remaining tasks exist", () => {
		const state = {
			tasks: [{ id: "task-1", content: "Check logs", status: "in_progress" as const }],
		};

		const reminder = buildPostCompactionTodoReminder(state);

		expect(reminder).toContain("after compaction");
		expect(reminder).toContain("Remaining items (1):");
		expect(reminder).toContain("task-1 Check logs [in_progress]");
	});
});
