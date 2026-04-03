import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { describe, expect, it } from "vitest";
import {
	applyTodoWrite,
	buildPostCompactionTodoReminder,
	getTodoWidgetVisibility,
	renderTodoWidgetLines,
	renderTodoWriteSummary,
	restoreTodoWriteState,
} from "../todo-write.js";

describe("todo-write", () => {
	it("creates state from todos array with deterministic ids", () => {
		const result = applyTodoWrite([
			{ content: "Read source", status: "completed" },
			{ content: "Map callsites", status: "in_progress" },
		]);

		expect(result.state.tasks[0]?.id).toBe("task-1");
		expect(result.state.tasks[0]?.status).toBe("completed");
		expect(result.state.tasks[1]?.id).toBe("task-2");
		expect(result.state.tasks[1]?.status).toBe("in_progress");
	});

	it("normalizes multiple in_progress — keeps only the first", () => {
		const result = applyTodoWrite([
			{ content: "A", status: "in_progress" },
			{ content: "B", status: "in_progress" },
		]);

		expect(result.state.tasks[0]?.status).toBe("in_progress");
		expect(result.state.tasks[1]?.status).toBe("pending");
	});

	it("promotes first pending to in_progress when none exists", () => {
		const result = applyTodoWrite([
			{ content: "A", status: "pending" },
			{ content: "B", status: "pending" },
		]);

		expect(result.state.tasks[0]?.status).toBe("in_progress");
		expect(result.state.tasks[1]?.status).toBe("pending");
	});

	it("preserves activeForm and notes", () => {
		const result = applyTodoWrite([
			{ content: "Run tests", status: "in_progress", activeForm: "Running tests", notes: "unit + e2e" },
		]);

		expect(result.state.tasks[0]?.activeForm).toBe("Running tests");
		expect(result.state.tasks[0]?.notes).toBe("unit + e2e");
	});

	it("renders empty summary when no tasks remain", () => {
		expect(renderTodoWriteSummary({ tasks: [] })).toBe("Todo list cleared.");
	});

	it("renders summary with remaining and progress", () => {
		const state = {
			tasks: [
				{ id: "task-1", content: "Done", status: "completed" as const },
				{ id: "task-2", content: "Working", status: "in_progress" as const },
			],
		};
		const summary = renderTodoWriteSummary(state);
		expect(summary).toContain("Remaining items (1):");
		expect(summary).toContain("task-2 Working [in_progress]");
		expect(summary).toContain("Progress: 1/2 tasks complete");
	});

	it("renders widget lines with markers", () => {
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

	it("shows at most two completed widget lines and collapses older ones", () => {
		const state = {
			tasks: [
				{ id: "task-1", content: "분석", status: "completed" as const },
				{ id: "task-2", content: "구현", status: "completed" as const },
				{ id: "task-3", content: "검증", status: "completed" as const },
				{ id: "task-4", content: "커밋 생성", status: "completed" as const },
			],
		};

		const lines = renderTodoWidgetLines(state);
		expect(lines).toEqual(["완료 +2", "~~● 검증", "~~● 커밋 생성"]);
	});

	it("keeps non-completed widget lines visible while collapsing old completed ones", () => {
		const state = {
			tasks: [
				{ id: "task-1", content: "초기 분석", status: "completed" as const },
				{ id: "task-2", content: "다음 구현", status: "in_progress" as const },
				{ id: "task-3", content: "리뷰", status: "completed" as const },
				{ id: "task-4", content: "배포", status: "completed" as const },
				{ id: "task-5", content: "문서화", status: "pending" as const },
			],
		};

		const lines = renderTodoWidgetLines(state);
		expect(lines).toEqual(["완료 +1", "→ 다음 구현", "~~● 리뷰", "~~● 배포", "○ 문서화"]);
	});

	it("renders widget lines using activeForm for in_progress tasks", () => {
		const state = {
			tasks: [
				{ id: "task-1", content: "Run tests", status: "in_progress" as const, activeForm: "Running tests" },
				{ id: "task-2", content: "Deploy", status: "pending" as const },
			],
		};

		const lines = renderTodoWidgetLines(state);
		expect(lines).toEqual(["→ Running tests", "○ Deploy"]);
	});

	it("renders widget lines with content when activeForm is missing", () => {
		const state = {
			tasks: [{ id: "task-1", content: "Run tests", status: "in_progress" as const }],
		};

		const lines = renderTodoWidgetLines(state);
		expect(lines).toEqual(["→ Run tests"]);
	});

	it("returns empty widget lines for empty state", () => {
		expect(renderTodoWidgetLines({ tasks: [] })).toEqual([]);
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
		const visibility = getTodoWidgetVisibility({ tasks: [] }, undefined, 0, 0);
		expect(visibility.hidden).toBe(true);
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

	it("restores an empty latest persisted state so auto-cleared todos stay cleared", () => {
		const ctx = {
			cwd: "/tmp/project",
			sessionManager: {
				getSessionFile: () => "session.jsonl",
				getBranch: () => [
					{
						type: "custom",
						customType: "todo-write-state",
						data: {
							tasks: [{ id: "task-1", content: "Finished task", status: "completed" as const }],
							updatedAt: 1,
						},
					},
					{
						type: "custom",
						customType: "todo-write-state",
						data: {
							tasks: [],
							updatedAt: 2,
						},
					},
				],
			},
		} as unknown as Pick<ExtensionContext, "cwd" | "sessionManager">;

		const restored = restoreTodoWriteState(ctx);

		expect(restored).toEqual({ tasks: [] });
	});

	it("migrates legacy abandoned status to completed on restore", () => {
		const ctx = {
			cwd: "/tmp/project",
			sessionManager: {
				getSessionFile: () => "session.jsonl",
				getBranch: () => [
					{
						type: "custom",
						customType: "todo-write-state",
						data: {
							tasks: [
								{ id: "task-1", content: "Old task", status: "abandoned" },
								{ id: "task-2", content: "Active task", status: "in_progress" },
							],
							updatedAt: 1,
						},
					},
				],
			},
		} as unknown as Pick<ExtensionContext, "cwd" | "sessionManager">;

		const restored = restoreTodoWriteState(ctx);

		expect(restored.tasks).toHaveLength(2);
		expect(restored.tasks[0]?.status).toBe("completed");
		expect(restored.tasks[0]?.content).toBe("Old task");
		expect(restored.tasks[1]?.status).toBe("in_progress");
	});

	it("normalizes in_progress after legacy migration (all abandoned + pending)", () => {
		const ctx = {
			cwd: "/tmp/project",
			sessionManager: {
				getSessionFile: () => "session.jsonl",
				getBranch: () => [
					{
						type: "custom",
						customType: "todo-write-state",
						data: {
							tasks: [
								{ id: "task-1", content: "Dropped", status: "abandoned" },
								{ id: "task-2", content: "Waiting", status: "pending" },
							],
							updatedAt: 1,
						},
					},
				],
			},
		} as unknown as Pick<ExtensionContext, "cwd" | "sessionManager">;

		const restored = restoreTodoWriteState(ctx);

		expect(restored.tasks[0]?.status).toBe("completed");
		// pending should be promoted to in_progress since no in_progress exists after migration
		expect(restored.tasks[1]?.status).toBe("in_progress");
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
