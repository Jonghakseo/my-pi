import { StringEnum } from "@mariozechner/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Text, truncateToWidth } from "@mariozechner/pi-tui";
import { type Static, Type } from "@sinclair/typebox";

type TodoStatus = "pending" | "in_progress" | "completed" | "abandoned";

type TodoTask = {
	id: string;
	content: string;
	status: TodoStatus;
	notes?: string;
};

type TodoState = {
	tasks: TodoTask[];
};

const StatusEnum = StringEnum(["pending", "in_progress", "completed", "abandoned"] as const, {
	description: "Task status",
});

const InputTask = Type.Object({
	content: Type.String({ description: "Task description" }),
	status: Type.Optional(StatusEnum),
	notes: Type.Optional(Type.String({ description: "Additional context or notes" })),
});

const TodoWriteParams = Type.Object(
	{
		ops: Type.Array(
			Type.Union([
				Type.Object({
					op: Type.Literal("replace"),
					tasks: Type.Array(InputTask),
				}),
				Type.Object({
					op: Type.Literal("add_task"),
					content: Type.String({ description: "Task description" }),
					notes: Type.Optional(Type.String({ description: "Additional context or notes" })),
				}),
				Type.Object({
					op: Type.Literal("update"),
					id: Type.String({ description: "Task ID, e.g. task-3" }),
					status: Type.Optional(StatusEnum),
					content: Type.Optional(Type.String({ description: "Updated task description" })),
					notes: Type.Optional(Type.String({ description: "Additional context or notes" })),
				}),
				Type.Object({
					op: Type.Literal("remove_task"),
					id: Type.String({ description: "Task ID, e.g. task-3" }),
				}),
			]),
			{ description: "Todo write operations" },
		),
	},
	{ additionalProperties: true },
);

type TodoWriteParamsType = Static<typeof TodoWriteParams>;
type TodoWriteOp = TodoWriteParamsType["ops"][number];

const todoStateStore = new Map<string, TodoState>();
const TODO_WIDGET_KEY = "todo-write";
const TODO_SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const;
const TODO_SPINNER_INTERVAL_MS = 120;
let todoWidgetTimer: ReturnType<typeof setInterval> | undefined;
const todoWidgetHideTimerByKey = new Map<string, ReturnType<typeof setTimeout>>();
const todoWidgetMetaStore = new Map<string, { completedAt?: number; completedTurn?: number }>();
const todoTurnStore = new Map<string, number>();
const TODO_HIDE_COMPLETED_AFTER_TURNS = 2;
const TODO_STATE_ENTRY_TYPE = "todo-write-state";
const TODO_COMPACTION_REMINDER_TYPE = "todo-write-compaction-reminder";

function createEmptyState(): TodoState {
	return { tasks: [] };
}

function getTodoStateKey(ctx: Pick<ExtensionContext, "cwd" | "sessionManager">): string {
	const sessionFile = ctx.sessionManager.getSessionFile?.();
	return sessionFile ? `session:${sessionFile}` : `cwd:${ctx.cwd}`;
}

function _isStatus(value: unknown): value is TodoStatus {
	return value === "pending" || value === "in_progress" || value === "completed" || value === "abandoned";
}

function findTask(tasks: TodoTask[], id: string): TodoTask | undefined {
	return tasks.find((entry) => entry.id === id);
}

function getNextTaskId(tasks: TodoTask[]): number {
	let maxId = 0;
	for (const task of tasks) {
		const match = /^task-(\d+)$/.exec(task.id);
		if (!match) continue;
		const value = Number.parseInt(match[1], 10);
		if (Number.isFinite(value) && value > maxId) maxId = value;
	}
	return maxId + 1;
}

function cloneTasks(tasks: TodoTask[]): TodoTask[] {
	return tasks.map((task) => ({ ...task }));
}

function normalizeInProgressTask(tasks: TodoTask[]): void {
	if (tasks.length === 0) return;

	const inProgressTasks = tasks.filter((task) => task.status === "in_progress");
	if (inProgressTasks.length > 1) {
		for (const task of inProgressTasks.slice(1)) {
			task.status = "pending";
		}
	}

	if (inProgressTasks.length > 0) return;

	const firstPendingTask = tasks.find((task) => task.status === "pending");
	if (firstPendingTask) firstPendingTask.status = "in_progress";
}

function hasRemainingTasks(state: TodoState): boolean {
	return state.tasks.some((task) => task.status === "pending" || task.status === "in_progress");
}

function getTodoTaskCount(state: TodoState): number {
	return state.tasks.length;
}

type TodoWidgetVisibility = {
	hidden: boolean;
	completionGraceActive: boolean;
	meta?: { completedAt: number; completedTurn: number };
};

export function getTodoWidgetVisibility(
	state: TodoState,
	meta: { completedAt?: number; completedTurn?: number } | undefined,
	currentTurn: number,
	now: number,
): TodoWidgetVisibility {
	if (getTodoTaskCount(state) === 0) return { hidden: true, completionGraceActive: false };
	// Reset completion tracking when tasks are still remaining — stale completedTurn causes immediate hide on next full completion
	if (hasRemainingTasks(state)) return { hidden: false, completionGraceActive: false };

	const completedTurn = meta?.completedTurn ?? currentTurn;
	const elapsedTurns = Math.max(0, currentTurn - completedTurn);
	const hidden = elapsedTurns >= TODO_HIDE_COMPLETED_AFTER_TURNS;

	return {
		hidden,
		completionGraceActive: !hidden,
		meta: { completedAt: meta?.completedAt ?? now, completedTurn },
	};
}

export function applyTodoWriteOps(
	state: TodoState,
	ops: TodoWriteOp[],
): {
	state: TodoState;
	errors: string[];
} {
	const errors: string[] = [];
	let next: TodoState = { tasks: cloneTasks(state.tasks) };
	let nextTaskId = getNextTaskId(next.tasks);

	for (const op of ops) {
		switch (op.op) {
			case "replace": {
				const replaced: TodoState = { tasks: [] };
				let replaceTaskId = 1;
				for (const inputTask of op.tasks) {
					replaced.tasks.push({
						id: `task-${replaceTaskId++}`,
						content: inputTask.content,
						status: inputTask.status ?? "pending",
						notes: inputTask.notes,
					});
				}
				next = replaced;
				nextTaskId = getNextTaskId(next.tasks);
				break;
			}

			case "add_task": {
				next.tasks.push({
					id: `task-${nextTaskId++}`,
					content: op.content,
					status: "pending",
					notes: op.notes,
				});
				break;
			}

			case "update": {
				const task = findTask(next.tasks, op.id);
				if (!task) {
					errors.push(`Task "${op.id}" not found`);
					break;
				}
				if (op.status !== undefined) task.status = op.status;
				if (op.content !== undefined) task.content = op.content;
				if (op.notes !== undefined) task.notes = op.notes;
				break;
			}

			case "remove_task": {
				const index = next.tasks.findIndex((task) => task.id === op.id);
				if (index === -1) {
					errors.push(`Task "${op.id}" not found`);
					break;
				}
				next.tasks.splice(index, 1);
				break;
			}
		}
	}

	normalizeInProgressTask(next.tasks);
	return { state: next, errors };
}

export function renderTodoWidgetLines(state: TodoState): string[] {
	if (getTodoTaskCount(state) === 0) return [];

	const lines: string[] = [];

	for (const task of state.tasks) {
		const isDone = task.status === "completed" || task.status === "abandoned";
		const marker = task.status === "in_progress" ? "→" : isDone ? "●" : "○";
		// Prefix with ~~ for strikethrough styling (applied in widget render)
		lines.push(isDone ? `~~${marker} ${task.content}` : `${marker} ${task.content}`);
	}

	return lines;
}

export function renderTodoWriteSummary(state: TodoState, errors: string[] = []): string {
	if (state.tasks.length === 0) return errors.length > 0 ? `Errors: ${errors.join("; ")}` : "Todo list cleared.";

	const remainingTasks = state.tasks.filter((task) => task.status === "pending" || task.status === "in_progress");
	const doneCount = state.tasks.filter((task) => task.status === "completed" || task.status === "abandoned").length;

	const lines: string[] = [];
	if (errors.length > 0) lines.push(`Errors: ${errors.join("; ")}`);
	if (remainingTasks.length === 0) {
		lines.push("Remaining items: none.");
	} else {
		lines.push(`Remaining items (${remainingTasks.length}):`);
		for (const task of remainingTasks) {
			lines.push(`  - ${task.id} ${task.content} [${task.status}]`);
		}
	}

	lines.push(`Progress: ${doneCount}/${state.tasks.length} tasks complete`);

	for (const task of state.tasks) {
		const marker =
			task.status === "completed"
				? "✓"
				: task.status === "in_progress"
					? "→"
					: task.status === "abandoned"
						? "✗"
						: "○";
		lines.push(`  ${marker} ${task.id} ${task.content}`);
	}

	return lines.join("\n");
}

function buildTodoTurnContext(state: TodoState): string | null {
	if (state.tasks.length === 0) return null;
	const summary = renderTodoWriteSummary(state);
	const activeTask = state.tasks.find((task) => task.status === "in_progress");
	const directive = activeTask
		? [
				`Active task: ${activeTask.id} ${activeTask.content}`,
				"When this task becomes done, your next action must be todo_write before any other tool call or response.",
			].join("\n")
		: hasRemainingTasks(state)
			? "There are remaining tasks but no active in_progress task. Before doing more work, call todo_write to select the next active task."
			: "All todo items are complete.";
	return [
		"[todo-reminder] internal todo_write state snapshot",
		"Source: in-memory session state maintained by the todo_write tool.",
		"Treat this as the latest authoritative todo status for the current turn.",
		"Do not contradict this snapshot. If progress/status differs, update todo_write first.",
		"",
		summary,
		"",
		directive,
	].join("\n");
}

type TodoStateEntryData = {
	tasks: TodoTask[];
	updatedAt: number;
};

function isTodoTask(value: unknown): value is TodoTask {
	if (!value || typeof value !== "object") return false;
	const candidate = value as Partial<TodoTask>;
	return (
		typeof candidate.id === "string" &&
		typeof candidate.content === "string" &&
		_isStatus(candidate.status) &&
		(candidate.notes === undefined || typeof candidate.notes === "string")
	);
}

function isTodoStateEntryData(value: unknown): value is TodoStateEntryData {
	if (!value || typeof value !== "object") return false;
	const candidate = value as Partial<TodoStateEntryData>;
	return typeof candidate.updatedAt === "number" && Array.isArray(candidate.tasks) && candidate.tasks.every((task) => isTodoTask(task));
}


export function restoreTodoWriteState(ctx: Pick<ExtensionContext, "cwd" | "sessionManager">): TodoState {
	const branch = ctx.sessionManager.getBranch();
	for (let index = branch.length - 1; index >= 0; index -= 1) {
		const entry = branch[index];
		if (entry.type !== "custom" || entry.customType !== TODO_STATE_ENTRY_TYPE) continue;
		if (isTodoStateEntryData(entry.data)) {
			const restored = { tasks: cloneTasks(entry.data.tasks) };
			writeTodoWriteState(ctx, restored);
			return restored;
		}
	}

	const empty = createEmptyState();
	writeTodoWriteState(ctx, empty);
	return empty;
}

export function buildPostCompactionTodoReminder(state: TodoState): string | null {
	if (!hasRemainingTasks(state)) return null;
	return [
		"[todo-reminder] todo_write still has remaining items after compaction.",
		"Please continue from the authoritative snapshot below.",
		"",
		renderTodoWriteSummary(state),
	].join("\n");
}


function readTodoWriteState(ctx: Pick<ExtensionContext, "cwd" | "sessionManager">): TodoState {
	const key = getTodoStateKey(ctx);
	const state = todoStateStore.get(key);
	return state ? { tasks: cloneTasks(state.tasks) } : createEmptyState();
}

function writeTodoWriteState(ctx: Pick<ExtensionContext, "cwd" | "sessionManager">, state: TodoState): void {
	const key = getTodoStateKey(ctx);
	if (state.tasks.length === 0) {
		todoStateStore.delete(key);
		return;
	}
	todoStateStore.set(key, { tasks: cloneTasks(state.tasks) });
}

function hasInProgressTask(state: TodoState): boolean {
	return state.tasks.some((task) => task.status === "in_progress");
}

function clearTodoWidgetTimer(): void {
	if (!todoWidgetTimer) return;
	clearInterval(todoWidgetTimer);
	todoWidgetTimer = undefined;
}

function clearTodoWidgetHideTimer(key: string): void {
	const timer = todoWidgetHideTimerByKey.get(key);
	if (!timer) return;
	clearTimeout(timer);
	todoWidgetHideTimerByKey.delete(key);
}

function getTodoTurn(key: string): number {
	return todoTurnStore.get(key) ?? 0;
}

function incrementTodoTurn(ctx: Pick<ExtensionContext, "cwd" | "sessionManager">): void {
	const key = getTodoStateKey(ctx);
	todoTurnStore.set(key, getTodoTurn(key) + 1);
}

async function syncTodoWidget(ctx: ExtensionContext): Promise<void> {
	if (!ctx.hasUI) return;

	const key = getTodoStateKey(ctx);
	const state = readTodoWriteState(ctx);
	const visibility = getTodoWidgetVisibility(state, todoWidgetMetaStore.get(key), getTodoTurn(key), Date.now());

	if (visibility.meta) {
		todoWidgetMetaStore.set(key, visibility.meta);
	} else {
		todoWidgetMetaStore.delete(key);
	}

	const lines = visibility.hidden ? [] : renderTodoWidgetLines(state);
	if (lines.length === 0) {
		clearTodoWidgetTimer();
		clearTodoWidgetHideTimer(key);
		ctx.ui.setWidget(TODO_WIDGET_KEY, undefined);
		return;
	}

	clearTodoWidgetHideTimer(key);

	ctx.ui.setWidget(TODO_WIDGET_KEY, (tui, theme) => {
		const renderedLines = [...lines];
		const hasRunning = hasInProgressTask(state);
		const content = new Text("", 0, 0);

		clearTodoWidgetTimer();
		if (hasRunning) {
			todoWidgetTimer = setInterval(() => tui.requestRender(), TODO_SPINNER_INTERVAL_MS);
		}

		return {
			render(width: number): string[] {
				const lineWidth = Math.max(8, width);
				const spinner =
					TODO_SPINNER_FRAMES[Math.floor(Date.now() / TODO_SPINNER_INTERVAL_MS) % TODO_SPINNER_FRAMES.length] ?? "•";
				const styledLines = renderedLines.map((line) => {
					if (line.startsWith("→ ")) {
						const runningLine = `${spinner} ${line.slice(2)}`;
						return theme.bold(theme.fg("accent", truncateToWidth(runningLine, lineWidth)));
					}
					if (line.startsWith("~~")) {
						return theme.fg("dim", theme.strikethrough(truncateToWidth(line.slice(2), lineWidth)));
					}
					return theme.fg("toolOutput", truncateToWidth(line, lineWidth));
				});
				content.setText(styledLines.join("\n"));
				return content.render(width);
			},
			invalidate() {
				content.invalidate();
			},
		};
	});
}

export default function todoWriteExtension(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "todo_write",
		label: "Todo Write",
		description:
			"Manage todos via ops. Only use for tasks with 3+ clearly distinct phases (e.g. research → implement → verify). Do NOT create separate todos for multiple simple edits within a single theme — just do them. Record todo status changes immediately when they happen. If a phase finishes, your very next action must be todo_write. Do not batch-complete multiple tasks at the end. Prefer at most one newly completed task per todo_write call; starting the next task as in_progress in the same call is allowed. Use replace/add_task/update/remove_task. replace requires { tasks }; tasks require { content, status?, notes? }. Status values: pending, in_progress, completed, abandoned. If requirements change mid-task, revise the todo list with todo_write to reflect the new plan before continuing.",
		parameters: TodoWriteParams,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const current = readTodoWriteState(ctx);
			const applied = applyTodoWriteOps(current, params.ops);
			const summary = renderTodoWriteSummary(applied.state, applied.errors);
			writeTodoWriteState(ctx, applied.state);
			pi.appendEntry<TodoStateEntryData>(TODO_STATE_ENTRY_TYPE, {
				tasks: cloneTasks(applied.state.tasks),
				updatedAt: Date.now(),
			});
			await syncTodoWidget(ctx);
			return {
				content: [{ type: "text" as const, text: summary }],
				details: { tasks: applied.state.tasks, summary },
			};
		},
		renderResult(result, { expanded }, theme) {
			if (!expanded) return new Text("", 0, 0);
			const details = result.details as { summary?: unknown } | undefined;
			const summary = typeof details?.summary === "string" ? details.summary : "";
			return new Text(summary ? theme.fg("toolOutput", summary) : "", 0, 0);
		},
	});

	pi.on("before_agent_start", async (_event, ctx) => {
		const state = readTodoWriteState(ctx);
		const content = buildTodoTurnContext(state);
		if (!content) return;
		return {
			message: {
				customType: "todo-write-context",
				content,
				display: false,
				details: { summary: renderTodoWriteSummary(state) },
			},
		};
	});

	pi.on("session_start", async (_event, ctx) => {
		restoreTodoWriteState(ctx);
		await syncTodoWidget(ctx);
	});

	pi.on("session_switch", async (_event, ctx) => {
		restoreTodoWriteState(ctx);
		await syncTodoWidget(ctx);
	});

	pi.on("session_fork", async (_event, ctx) => {
		restoreTodoWriteState(ctx);
		await syncTodoWidget(ctx);
	});

	pi.on("session_tree", async (_event, ctx) => {
		restoreTodoWriteState(ctx);
		await syncTodoWidget(ctx);
	});

	pi.on("session_compact", async (_event, ctx) => {
		const state = restoreTodoWriteState(ctx);
		await syncTodoWidget(ctx);
		const reminder = buildPostCompactionTodoReminder(state);
		if (!reminder) return;

		if (ctx.hasUI) {
			ctx.ui.notify("Todo reminder: remaining items still exist after compaction.", "info");
		}

		pi.sendMessage(
			{
				customType: TODO_COMPACTION_REMINDER_TYPE,
				content: reminder,
				display: true,
				details: { summary: renderTodoWriteSummary(state) },
			},
			{ triggerTurn: false },
		);
	});

	pi.on("message_end", async (_event, ctx) => {
		incrementTodoTurn(ctx);
		await syncTodoWidget(ctx);
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		const key = getTodoStateKey(ctx);
		clearTodoWidgetTimer();
		clearTodoWidgetHideTimer(key);
		todoWidgetMetaStore.delete(key);
		todoTurnStore.delete(key);
		if (!ctx.hasUI) return;
		ctx.ui.setWidget(TODO_WIDGET_KEY, undefined);
	});
}
