import { describe, expect, it } from "vitest";
import { applyTodoWriteOps, renderTodoWriteSummary } from "../todo-write.js";

describe("todo-write ops", () => {
	it("replaces full state and assigns deterministic ids", () => {
		const result = applyTodoWriteOps(
			{ phases: [] },
			[
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
			],
		);

		expect(result.error).toBeUndefined();
		expect(result.state?.phases[0]?.id).toBe("phase-1");
		expect(result.state?.phases[0]?.tasks[0]?.id).toBe("task-1");
		expect(result.state?.phases[0]?.tasks[1]?.id).toBe("task-2");
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

		expect(result.error).toBeUndefined();
		expect(result.state?.phases[1]?.id).toBe("phase-2");
		expect(result.state?.phases[1]?.tasks[0]?.id).toBe("task-2");
		expect(result.state?.phases[0]?.tasks[1]?.id).toBe("task-3");
	});

	it("returns error when multiple in_progress tasks exist", () => {
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

		expect(result.state).toBeUndefined();
		expect(result.error).toContain("in_progress");
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
		expect(result.error).toBeUndefined();

		const summary = renderTodoWriteSummary(result.state!);
		expect(summary).toContain("Remaining items (1):");
		expect(summary).toContain("task-2 B [pending]");
	});

	it("returns error when add_task phase is missing", () => {
		const start = {
			phases: [{ id: "phase-1", name: "P1", tasks: [] }],
		};
		const result = applyTodoWriteOps(start, [{ op: "add_task", phase: "phase-999", content: "X" }]);

		expect(result.state).toBeUndefined();
		expect(result.error).toContain("Phase phase-999 not found");
	});

	it("returns error when update target task does not exist", () => {
		const start = {
			phases: [{ id: "phase-1", name: "P1", tasks: [] }],
		};
		const result = applyTodoWriteOps(start, [{ op: "update", id: "task-404", status: "completed" }]);

		expect(result.state).toBeUndefined();
		expect(result.error).toContain("Task task-404 not found");
	});

	it("returns error when remove_task target does not exist", () => {
		const start = {
			phases: [{ id: "phase-1", name: "P1", tasks: [] }],
		};
		const result = applyTodoWriteOps(start, [{ op: "remove_task", id: "task-404" }]);

		expect(result.state).toBeUndefined();
		expect(result.error).toContain("Task task-404 not found");
	});

	it("renders empty summary when no pending or in_progress tasks remain", () => {
		const state = {
			phases: [
				{
					id: "phase-1",
					name: "P1",
					tasks: [
						{ id: "task-1", content: "A", status: "completed" as const, notes: "" },
						{ id: "task-2", content: "B", status: "abandoned" as const, notes: "" },
					],
				},
			],
		};

		expect(renderTodoWriteSummary(state)).toBe("Remaining items: none.");
	});
});
