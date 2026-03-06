import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { StringEnum } from "@mariozechner/pi-ai";
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

const TODO_WRITE_DIR = ".todos";
const TODO_WRITE_FILE = "todo-write-state.json";
const TODO_WIDGET_KEY = "todo-write";

function createEmptyState(): TodoState {
	return { phases: [] };
}

function getStatePath(cwd: string): string {
	return join(cwd, TODO_WRITE_DIR, TODO_WRITE_FILE);
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
	const allTasks = state.phases.flatMap((phase) => phase.tasks.map((task) => ({ ...task, phase: phase.name })));
	if (allTasks.length === 0) return [];

	const remainingTasks = allTasks.filter((task) => task.status === "pending" || task.status === "in_progress");
	const completedCount = allTasks.filter((task) => task.status === "completed" || task.status === "abandoned").length;
	let currentPhaseIndex = state.phases.findIndex((phase) =>
		phase.tasks.some((task) => task.status === "pending" || task.status === "in_progress"),
	);
	if (currentPhaseIndex === -1) currentPhaseIndex = state.phases.length - 1;
	const currentPhase = state.phases[currentPhaseIndex];
	const focusTask = remainingTasks.find((task) => task.status === "in_progress") ?? remainingTasks[0] ?? allTasks[allTasks.length - 1];
	const phaseLabel = currentPhase ? ` · ${currentPhase.name} (${currentPhaseIndex + 1}/${state.phases.length})` : "";

	const lines = [`📋 Todo ${completedCount}/${allTasks.length} done · ${remainingTasks.length} remaining${phaseLabel}`];
	if (focusTask) {
		const focusPrefix =
			focusTask.status === "in_progress"
				? "→"
				: focusTask.status === "completed"
					? "✓"
					: focusTask.status === "abandoned"
						? "✗"
						: "○";
		lines.push(`  ${focusPrefix} ${focusTask.id} ${focusTask.content} (${focusTask.phase})`);
	}

	for (const task of remainingTasks.slice(0, 3)) {
		if (task.id === focusTask?.id) continue;
		const marker = task.status === "in_progress" ? "→" : "○";
		lines.push(`  ${marker} ${task.id} ${task.content} (${task.phase})`);
	}

	if (remainingTasks.length > 3) {
		lines.push(`  … ${remainingTasks.length - 3} more`);
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

async function readTodoWriteState(cwd: string): Promise<TodoState> {
	const path = getStatePath(cwd);
	try {
		const raw = await readFile(path, "utf8");
		const parsed = JSON.parse(raw) as { phases?: unknown };
		if (!parsed || !Array.isArray(parsed.phases)) return createEmptyState();

		const phases: TodoPhase[] = [];
		for (const rawPhase of parsed.phases) {
			if (!rawPhase || typeof rawPhase !== "object") continue;
			const phase = rawPhase as Record<string, unknown>;
			if (typeof phase.id !== "string" || typeof phase.name !== "string" || !Array.isArray(phase.tasks)) continue;

			const tasks: TodoTask[] = [];
			for (const rawTask of phase.tasks) {
				if (!rawTask || typeof rawTask !== "object") continue;
				const task = rawTask as Record<string, unknown>;
				if (typeof task.id !== "string" || typeof task.content !== "string" || !isStatus(task.status)) continue;
				const notes = typeof task.notes === "string" ? task.notes : undefined;
				tasks.push({
					id: task.id,
					content: task.content,
					status: task.status,
					notes,
				});
			}

			phases.push({ id: phase.id, name: phase.name, tasks });
		}

		return { phases };
	} catch {
		return createEmptyState();
	}
}

async function writeTodoWriteState(cwd: string, state: TodoState): Promise<void> {
	const dir = join(cwd, TODO_WRITE_DIR);
	await mkdir(dir, { recursive: true });
	await writeFile(getStatePath(cwd), `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

async function syncTodoWidget(ctx: ExtensionContext): Promise<void> {
	if (!ctx.hasUI) return;
	const state = await readTodoWriteState(ctx.cwd);
	const lines = renderTodoWidgetLines(state);
	ctx.ui.setWidget(TODO_WIDGET_KEY, lines.length > 0 ? lines : undefined);
}

export default function todoWriteExtension(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "todo_write",
		label: "Todo Write",
		description:
			"Manage phased todos via ops. Use replace/add_phase/add_task/update/remove_task. replace phases require { name, tasks? }; tasks require { content, status?, notes? }. Status values: pending, in_progress, completed, abandoned.",
		parameters: TodoWriteParams,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const current = await readTodoWriteState(ctx.cwd);
			const applied = applyTodoWriteOps(current, params.ops);
			await writeTodoWriteState(ctx.cwd, applied.state);
			await syncTodoWidget(ctx);
			return {
				content: [{ type: "text" as const, text: renderTodoWriteSummary(applied.state, applied.errors) }],
				details: { phases: applied.state.phases },
			};
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

	pi.on("session_shutdown", async (_event, ctx) => {
		if (!ctx.hasUI) return;
		ctx.ui.setWidget(TODO_WIDGET_KEY, undefined);
	});
}
