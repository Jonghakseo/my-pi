import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { StringEnum } from "@mariozechner/pi-ai";
import { Text, truncateToWidth } from "@mariozechner/pi-tui";
import { Type, type Static } from "@sinclair/typebox";

type TodoStatus = "pending" | "in_progress" | "completed" | "abandoned";

type TodoTask = {
	id: string;
	content: string;
	status: TodoStatus;
	notes?: string;
};

type TodoPhase = {
	id: string;
	name: string;
	tasks: TodoTask[];
};

type TodoState = {
	phases: TodoPhase[];
};

const StatusEnum = StringEnum(["pending", "in_progress", "completed", "abandoned"] as const, {
	description: "Task status",
});

const InputTask = Type.Object({
	content: Type.String({ description: "Task description" }),
	status: Type.Optional(StatusEnum),
	notes: Type.Optional(Type.String({ description: "Additional context or notes" })),
});

const InputPhase = Type.Object({
	name: Type.String({ description: "Phase name" }),
	tasks: Type.Optional(Type.Array(InputTask)),
});

const TodoWriteParams = Type.Object(
	{
		ops: Type.Array(
			Type.Union([
				Type.Object({
					op: Type.Literal("replace"),
					phases: Type.Array(InputPhase),
				}),
				Type.Object({
					op: Type.Literal("add_phase"),
					name: Type.String({ description: "Phase name" }),
					tasks: Type.Optional(Type.Array(InputTask)),
				}),
				Type.Object({
					op: Type.Literal("add_task"),
					phase: Type.String({ description: "Phase ID, e.g. phase-1" }),
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
const TODO_HIDE_COMPLETED_AFTER_MS = 90_000;
const TODO_HIDE_COMPLETED_AFTER_TURNS = 2;


function createEmptyState(): TodoState {
	return { phases: [] };
}

function getTodoStateKey(ctx: Pick<ExtensionContext, "cwd" | "sessionManager">): string {
	const sessionFile = ctx.sessionManager.getSessionFile?.();
	return sessionFile ? `session:${sessionFile}` : `cwd:${ctx.cwd}`;
}

function isStatus(value: unknown): value is TodoStatus {
	return value === "pending" || value === "in_progress" || value === "completed" || value === "abandoned";
}

function findTask(phases: TodoPhase[], id: string): TodoTask | undefined {
	for (const phase of phases) {
		const task = phase.tasks.find((entry) => entry.id === id);
		if (task) return task;
	}
	return undefined;
}

function buildPhaseFromInput(
	input: { name: string; tasks?: Array<{ content: string; status?: TodoStatus; notes?: string }> },
	phaseId: string,
	nextTaskId: number,
): { phase: TodoPhase; nextTaskId: number } {
	const tasks: TodoTask[] = [];
	let taskId = nextTaskId;
	for (const task of input.tasks ?? []) {
		tasks.push({
			id: `task-${taskId++}`,
			content: task.content,
			status: task.status ?? "pending",
			notes: task.notes,
		});
	}
	return {
		phase: {
			id: phaseId,
			name: input.name,
			tasks,
		},
		nextTaskId: taskId,
	};
}

function getNextIds(phases: TodoPhase[]): { nextTaskId: number; nextPhaseId: number } {
	let maxTaskId = 0;
	let maxPhaseId = 0;

	for (const phase of phases) {
		const phaseMatch = /^phase-(\d+)$/.exec(phase.id);
		if (phaseMatch) {
			const value = Number.parseInt(phaseMatch[1], 10);
			if (Number.isFinite(value) && value > maxPhaseId) maxPhaseId = value;
		}

		for (const task of phase.tasks) {
			const taskMatch = /^task-(\d+)$/.exec(task.id);
			if (!taskMatch) continue;
			const value = Number.parseInt(taskMatch[1], 10);
			if (Number.isFinite(value) && value > maxTaskId) maxTaskId = value;
		}
	}

	return { nextTaskId: maxTaskId + 1, nextPhaseId: maxPhaseId + 1 };
}

function clonePhases(phases: TodoPhase[]): TodoPhase[] {
	return phases.map((phase) => ({
		...phase,
		tasks: phase.tasks.map((task) => ({ ...task })),
	}));
}

function normalizeInProgressTask(phases: TodoPhase[]): void {
	const orderedTasks = phases.flatMap((phase) => phase.tasks);
	if (orderedTasks.length === 0) return;

	const inProgressTasks = orderedTasks.filter((task) => task.status === "in_progress");
	if (inProgressTasks.length > 1) {
		for (const task of inProgressTasks.slice(1)) {
			task.status = "pending";
		}
	}

	if (inProgressTasks.length > 0) return;

	const firstPendingTask = orderedTasks.find((task) => task.status === "pending");
	if (firstPendingTask) firstPendingTask.status = "in_progress";
}

function isPhaseCompleted(phase: TodoPhase): boolean {
	return phase.tasks.length > 0 && phase.tasks.every((task) => task.status === "completed");
}

function hasRemainingTasks(state: TodoState): boolean {
	return state.phases.some((phase) => phase.tasks.some((task) => task.status === "pending" || task.status === "in_progress"));
}

function getTodoTaskCount(state: TodoState): number {
	return state.phases.reduce((count, phase) => count + phase.tasks.length, 0);
}

type TodoWidgetVisibility = {
	hidden: boolean;
	completionGraceActive: boolean;
	meta?: { completedAt: number; completedTurn: number };
	remainingMs?: number;
};

export function getTodoWidgetVisibility(
	state: TodoState,
	meta: { completedAt?: number; completedTurn?: number } | undefined,
	currentTurn: number,
	now: number,
): TodoWidgetVisibility {
	if (getTodoTaskCount(state) === 0) return { hidden: true, completionGraceActive: false };
	if (hasRemainingTasks(state)) return { hidden: false, completionGraceActive: false };

	const completedAt = meta?.completedAt ?? now;
	const completedTurn = meta?.completedTurn ?? currentTurn;
	const elapsedMs = Math.max(0, now - completedAt);
	const elapsedTurns = Math.max(0, currentTurn - completedTurn);
	const hidden = elapsedMs >= TODO_HIDE_COMPLETED_AFTER_MS || elapsedTurns >= TODO_HIDE_COMPLETED_AFTER_TURNS;

	return {
		hidden,
		completionGraceActive: !hidden,
		meta: { completedAt, completedTurn },
		remainingMs: hidden ? 0 : Math.max(0, TODO_HIDE_COMPLETED_AFTER_MS - elapsedMs),
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
	let next: TodoState = { phases: clonePhases(state.phases) };
	let { nextTaskId, nextPhaseId } = getNextIds(next.phases);

	for (const op of ops) {
		switch (op.op) {
			case "replace": {
				const replaced: TodoState = { phases: [] };
				let replaceTaskId = 1;
				let replacePhaseId = 1;
				for (const inputPhase of op.phases) {
					const phaseId = `phase-${replacePhaseId++}`;
					const { phase, nextTaskId: updatedTaskId } = buildPhaseFromInput(inputPhase, phaseId, replaceTaskId);
					replaced.phases.push(phase);
					replaceTaskId = updatedTaskId;
				}
				next = replaced;
				({ nextTaskId, nextPhaseId } = getNextIds(next.phases));
				break;
			}

			case "add_phase": {
				const phaseId = `phase-${nextPhaseId++}`;
				const { phase, nextTaskId: updatedTaskId } = buildPhaseFromInput(op, phaseId, nextTaskId);
				next.phases.push(phase);
				nextTaskId = updatedTaskId;
				break;
			}

			case "add_task": {
				const phase = next.phases.find((entry) => entry.id === op.phase);
				if (!phase) {
					errors.push(`Phase "${op.phase}" not found`);
					break;
				}
				phase.tasks.push({
					id: `task-${nextTaskId++}`,
					content: op.content,
					status: "pending",
					notes: op.notes,
				});
				break;
			}

			case "update": {
				const task = findTask(next.phases, op.id);
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
				let removed = false;
				for (const phase of next.phases) {
					const index = phase.tasks.findIndex((task) => task.id === op.id);
					if (index === -1) continue;
					phase.tasks.splice(index, 1);
					removed = true;
					break;
				}
				if (!removed) errors.push(`Task "${op.id}" not found`);
				break;
			}
		}
	}

	normalizeInProgressTask(next.phases);
	return { state: next, errors };
}

export function renderTodoWidgetLines(state: TodoState): string[] {
	if (getTodoTaskCount(state) === 0) return [];

	const lines: string[] = [];
	const remainingByPhase = state.phases.map((phase) => ({
		name: phase.name,
		tasks: phase.tasks.filter((task) => task.status === "pending" || task.status === "in_progress"),
	}));
	const hasRemaining = remainingByPhase.some((phase) => phase.tasks.length > 0);

	if (hasRemaining) {
		for (const [index, phase] of state.phases.entries()) {
			const remainingPhase = remainingByPhase[index];
			lines.push(isPhaseCompleted(phase) ? `${phase.name} ✓` : phase.name);
			for (const task of remainingPhase.tasks) {
				const marker = task.status === "in_progress" ? "→" : "○";
				lines.push(`  ${marker} ${task.content}`);
			}
		}
		return lines;
	}

	for (const phase of state.phases) {
		lines.push(isPhaseCompleted(phase) ? `${phase.name} ✓` : phase.name);
		for (const task of phase.tasks) {
			const marker = task.status === "completed" ? "●" : task.status === "abandoned" ? "✗" : "○";
			lines.push(`  ${marker} ${task.content}`);
		}
	}

	return lines;
}

export function renderTodoWriteSummary(state: TodoState, errors: string[] = []): string {
	const tasks = state.phases.flatMap((phase) => phase.tasks);
	if (tasks.length === 0) return errors.length > 0 ? `Errors: ${errors.join("; ")}` : "Todo list cleared.";

	const remainingByPhase = state.phases
		.map((phase) => ({
			name: phase.name,
			tasks: phase.tasks.filter((task) => task.status === "pending" || task.status === "in_progress"),
		}))
		.filter((phase) => phase.tasks.length > 0);
	const remainingTasks = remainingByPhase.flatMap((phase) => phase.tasks.map((task) => ({ ...task, phase: phase.name })));

	let currentIndex = state.phases.findIndex((phase) =>
		phase.tasks.some((task) => task.status === "pending" || task.status === "in_progress"),
	);
	if (currentIndex === -1) currentIndex = state.phases.length - 1;
	const currentPhase = state.phases[currentIndex];
	const doneCount = currentPhase ? currentPhase.tasks.filter((task) => task.status === "completed" || task.status === "abandoned").length : 0;

	const lines: string[] = [];
	if (errors.length > 0) lines.push(`Errors: ${errors.join("; ")}`);
	if (remainingTasks.length === 0) {
		lines.push("Remaining items: none.");
	} else {
		lines.push(`Remaining items (${remainingTasks.length}):`);
		for (const task of remainingTasks) {
			lines.push(`  - ${task.id} ${task.content} [${task.status}] (${task.phase})`);
		}
	}

	if (currentPhase) {
		lines.push(`Phase ${currentIndex + 1}/${state.phases.length} "${currentPhase.name}" — ${doneCount}/${currentPhase.tasks.length} tasks complete`);
	}

	for (const phase of state.phases) {
		lines.push(`  ${phase.name}:`);
		for (const task of phase.tasks) {
			const marker =
				task.status === "completed"
					? "✓"
					: task.status === "in_progress"
						? "→"
						: task.status === "abandoned"
							? "✗"
							: "○";
			lines.push(`    ${marker} ${task.id} ${task.content}`);
		}
	}

	return lines.join("\n");
}

function readTodoWriteState(ctx: Pick<ExtensionContext, "cwd" | "sessionManager">): TodoState {
	const key = getTodoStateKey(ctx);
	const state = todoStateStore.get(key);
	return state ? { phases: clonePhases(state.phases) } : createEmptyState();
}

function writeTodoWriteState(ctx: Pick<ExtensionContext, "cwd" | "sessionManager">, state: TodoState): void {
	const key = getTodoStateKey(ctx);
	if (state.phases.length === 0) {
		todoStateStore.delete(key);
		return;
	}
	todoStateStore.set(key, { phases: clonePhases(state.phases) });
}

function hasInProgressTask(state: TodoState): boolean {
	return state.phases.some((phase) => phase.tasks.some((task) => task.status === "in_progress"));
}

function getCurrentPhaseName(state: TodoState): string | undefined {
	const currentPhase = state.phases.find((phase) => phase.tasks.some((task) => task.status === "in_progress"));
	if (currentPhase) return currentPhase.name;
	const nextPhase = state.phases.find((phase) => phase.tasks.some((task) => task.status === "pending"));
	if (nextPhase) return nextPhase.name;
	return state.phases.at(-1)?.name;
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
	if (visibility.completionGraceActive && visibility.remainingMs !== undefined) {
		todoWidgetHideTimerByKey.set(
			key,
			setTimeout(() => {
				void syncTodoWidget(ctx);
			}, Math.max(0, visibility.remainingMs + 50)),
		);
	}

	ctx.ui.setWidget(TODO_WIDGET_KEY, (tui, theme) => {
		const renderedLines = [...lines];
		const hasRunning = hasInProgressTask(state);
		const currentPhaseName = getCurrentPhaseName(state);
		const content = new Text("", 0, 0);

		clearTodoWidgetTimer();
		if (hasRunning) {
			todoWidgetTimer = setInterval(() => tui.requestRender(), TODO_SPINNER_INTERVAL_MS);
		}

		return {
			render(width: number): string[] {
				const lineWidth = Math.max(8, width);
				const spinner = TODO_SPINNER_FRAMES[Math.floor(Date.now() / TODO_SPINNER_INTERVAL_MS) % TODO_SPINNER_FRAMES.length] ?? "•";
				const styledLines = renderedLines.map((line) => {
					if (!line.startsWith("  ")) {
						const phaseLine = truncateToWidth(line, lineWidth);
						return line === currentPhaseName ? theme.bold(theme.fg("accent", phaseLine)) : theme.fg("toolOutput", phaseLine);
					}
					if (line.startsWith("  → ")) {
						const runningLine = `  ${spinner} ${line.slice(4)}`;
						return theme.bold(theme.fg("accent", truncateToWidth(runningLine, lineWidth)));
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
			"Manage phased todos via ops. Use replace/add_phase/add_task/update/remove_task. replace phases require { name, tasks? }; tasks require { content, status?, notes? }. Status values: pending, in_progress, completed, abandoned.",
		parameters: TodoWriteParams,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const current = readTodoWriteState(ctx);
			const applied = applyTodoWriteOps(current, params.ops);
			const summary = renderTodoWriteSummary(applied.state, applied.errors);
			writeTodoWriteState(ctx, applied.state);
			await syncTodoWidget(ctx);
			return {
				content: [{ type: "text" as const, text: summary }],
				details: { phases: applied.state.phases, summary },
			};
		},
		renderResult(result, { expanded }, theme) {
			if (!expanded) return new Text("", 0, 0);
			const details = result.details as { summary?: unknown } | undefined;
			const summary = typeof details?.summary === "string" ? details.summary : "";
			return new Text(summary ? theme.fg("toolOutput", summary) : "", 0, 0);
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		await syncTodoWidget(ctx);
	});

	pi.on("session_switch", async (_event, ctx) => {
		await syncTodoWidget(ctx);
	});

	pi.on("session_fork", async (_event, ctx) => {
		await syncTodoWidget(ctx);
	});

	pi.on("session_tree", async (_event, ctx) => {
		await syncTodoWidget(ctx);
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
