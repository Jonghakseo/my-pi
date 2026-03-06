import { describe, expect, it } from "vitest";
import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
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
		const result = applyTodoWriteOps({ phases: [] }, [
			{
				op: "replace",
				phases: [
					{
						name: "Planning",
						tasks: [
							{ content: "Read source", status: "completed" },
							{ content: "Map callsites", status: "in_progress" },
						],
					},
				],
			},
		]);

		expect(result.errors).toEqual([]);
		expect(result.state.phases[0]?.id).toBe("phase-1");
		expect(result.state.phases[0]?.tasks[0]?.id).toBe("task-1");
		expect(result.state.phases[0]?.tasks[1]?.id).toBe("task-2");
	});

	it("adds phase and task with incrementing ids", () => {
		const start = {
			phases: [
				{
					id: "phase-1",
					name: "P1",
					tasks: [{ id: "task-1", content: "A", status: "pending" as const, notes: "" }],
				},
			],
		};
		const result = applyTodoWriteOps(start, [
			{ op: "add_phase", name: "P2", tasks: [{ content: "B", status: "pending" }] },
			{ op: "add_task", phase: "phase-1", content: "C" },
		]);

		expect(result.errors).toEqual([]);
		expect(result.state.phases[1]?.id).toBe("phase-2");
		expect(result.state.phases[1]?.tasks[0]?.id).toBe("task-2");
		expect(result.state.phases[0]?.tasks[1]?.id).toBe("task-3");
	});

	it("normalizes multiple in_progress tasks instead of erroring", () => {
		const start = {
			phases: [
				{
					id: "phase-1",
					name: "P1",
					tasks: [
						{ id: "task-1", content: "A", status: "in_progress" as const, notes: "" },
						{ id: "task-2", content: "B", status: "pending" as const, notes: "" },
					],
				},
			],
		};
		const result = applyTodoWriteOps(start, [{ op: "update", id: "task-2", status: "in_progress" }]);

		expect(result.errors).toEqual([]);
		expect(result.state.phases[0]?.tasks[0]?.status).toBe("in_progress");
		expect(result.state.phases[0]?.tasks[1]?.status).toBe("pending");
	});

	it("promotes first pending task to in_progress when none exists", () => {
		const start = {
			phases: [
				{
					id: "phase-1",
					name: "P1",
					tasks: [
						{ id: "task-1", content: "A", status: "pending" as const, notes: "" },
						{ id: "task-2", content: "B", status: "pending" as const, notes: "" },
					],
				},
			],
		};
		const result = applyTodoWriteOps(start, []);

		expect(result.errors).toEqual([]);
		expect(result.state.phases[0]?.tasks[0]?.status).toBe("in_progress");
		expect(result.state.phases[0]?.tasks[1]?.status).toBe("pending");
	});

	it("removes task and renders summary", () => {
		const start = {
			phases: [
				{
					id: "phase-1",
					name: "P1",
					tasks: [
						{ id: "task-1", content: "A", status: "completed" as const, notes: "" },
						{ id: "task-2", content: "B", status: "pending" as const, notes: "" },
					],
				},
			],
		};
		const result = applyTodoWriteOps(start, [{ op: "remove_task", id: "task-1" }]);
		const summary = renderTodoWriteSummary(result.state, result.errors);

		expect(result.errors).toEqual([]);
		expect(summary).toContain("Remaining items (1):");
		expect(summary).toContain("task-2 B [in_progress]");
	});

	it("accumulates add_task error when phase is missing", () => {
		const start = {
			phases: [{ id: "phase-1", name: "P1", tasks: [] }],
		};
		const result = applyTodoWriteOps(start, [{ op: "add_task", phase: "phase-999", content: "X" }]);

		expect(result.errors).toContain('Phase "phase-999" not found');
		expect(result.state.phases).toHaveLength(1);
	});

	it("accumulates update error when task does not exist", () => {
		const start = {
			phases: [{ id: "phase-1", name: "P1", tasks: [] }],
		};
		const result = applyTodoWriteOps(start, [{ op: "update", id: "task-404", status: "completed" }]);

		expect(result.errors).toContain('Task "task-404" not found');
		expect(result.state.phases).toHaveLength(1);
	});

	it("accumulates remove_task error when task does not exist", () => {
		const start = {
			phases: [{ id: "phase-1", name: "P1", tasks: [] }],
		};
		const result = applyTodoWriteOps(start, [{ op: "remove_task", id: "task-404" }]);

		expect(result.errors).toContain('Task "task-404" not found');
		expect(result.state.phases).toHaveLength(1);
	});

	it("renders empty summary when no tasks remain", () => {
		const state = { phases: [] };
		expect(renderTodoWriteSummary(state)).toBe("Todo list cleared.");
	});

	it("renders widget lines when todos exist", () => {
		const state = {
			phases: [
				{
					id: "phase-1",
					name: "Planning",
					tasks: [
						{ id: "task-1", content: "Read source", status: "completed" as const },
						{ id: "task-2", content: "Map callsites", status: "in_progress" as const },
						{ id: "task-3", content: "Write patch", status: "pending" as const },
					],
				},
			],
		};

		const lines = renderTodoWidgetLines(state);
		expect(lines).toEqual(["Planning", "  → Map callsites", "  ○ Write patch"]);
	});

	it("keeps completed widget visible during grace period", () => {
		const state = {
			phases: [
				{
					id: "phase-1",
					name: "Planning",
					tasks: [{ id: "task-1", content: "Done", status: "completed" as const }],
				},
			],
		};

		const visibility = getTodoWidgetVisibility(state, undefined, 3, 1_000);
		expect(visibility.hidden).toBe(false);
		expect(visibility.completionGraceActive).toBe(true);
		expect(visibility.meta).toEqual({ completedAt: 1_000, completedTurn: 3 });
	});

	it("hides completed widget after grace period by time", () => {
		const state = {
			phases: [
				{
					id: "phase-1",
					name: "Planning",
					tasks: [{ id: "task-1", content: "Done", status: "completed" as const }],
				},
			],
		};

		const visibility = getTodoWidgetVisibility(state, { completedAt: 1_000, completedTurn: 3 }, 3, 91_500);
		expect(visibility.hidden).toBe(true);
	});

	it("hides completed widget after grace period by turns", () => {
		const state = {
			phases: [
				{
					id: "phase-1",
					name: "Planning",
					tasks: [{ id: "task-1", content: "Done", status: "completed" as const }],
				},
			],
		};

		const visibility = getTodoWidgetVisibility(state, { completedAt: 1_000, completedTurn: 3 }, 5, 5_000);
		expect(visibility.hidden).toBe(true);
	});

	it("hides widget when todo state is empty", () => {
		expect(renderTodoWidgetLines({ phases: [] })).toEqual([]);
	});
});

describe("todo-write persistence", () => {
	it("restores the latest persisted state from custom session entries", () => {
		const ctx = {
			cwd: "/tmp/project",
			sessionManager: {
				getSessionFile: () => "session.jsonl",
				getBranch: () => [
					{ type: "custom", customType: "todo-write-state", data: { phases: [{ id: "phase-1", name: "Old", tasks: [] }], updatedAt: 1 } },
					{
						type: "custom",
						customType: "todo-write-state",
						data: {
							phases: [
								{
									id: "phase-2",
									name: "Current",
									tasks: [{ id: "task-1", content: "Finish patch", status: "in_progress" as const }],
								},
							],
							updatedAt: 2,
						},
					},
				],
			},
		} as unknown as Pick<ExtensionContext, "cwd" | "sessionManager">;

		const restored = restoreTodoWriteState(ctx);

		expect(restored).toEqual({
			phases: [
				{
					id: "phase-2",
					name: "Current",
					tasks: [{ id: "task-1", content: "Finish patch", status: "in_progress" }],
				},
			],
		});
	});

	it("returns null compaction reminder when no remaining tasks exist", () => {
		const state = {
			phases: [
				{ id: "phase-1", name: "Done", tasks: [{ id: "task-1", content: "Ship", status: "completed" as const }] },
			],
		};

		expect(buildPostCompactionTodoReminder(state)).toBeNull();
	});

	it("builds a compaction reminder when remaining tasks exist", () => {
		const state = {
			phases: [
				{
					id: "phase-1",
					name: "Verify",
					tasks: [{ id: "task-1", content: "Check logs", status: "in_progress" as const }],
				},
			],
		};

		const reminder = buildPostCompactionTodoReminder(state);

		expect(reminder).toContain("after compaction");
		expect(reminder).toContain("Remaining items (1):");
		expect(reminder).toContain("task-1 Check logs [in_progress]");
	});
});
