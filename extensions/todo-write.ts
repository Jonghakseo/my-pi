import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";

type TodoStatus = "pending" | "in_progress" | "completed" | "abandoned";

type TodoTask = {
	id: string;
	content: string;
	status: TodoStatus;
	notes: string;
};

type TodoPhase = {
	id: string;
	name: string;
	tasks: TodoTask[];
};

type TodoState = {
	phases: TodoPhase[];
};

type ReplaceTaskInput = {
	content: string;
	status?: TodoStatus;
	notes?: string;
};

type ReplacePhaseInput = {
	name: string;
	tasks: ReplaceTaskInput[];
};

type TodoWriteOp =
	| { op: "replace"; phases: ReplacePhaseInput[] }
	| { op: "add_phase"; name: string; tasks: ReplaceTaskInput[] }
	| { op: "add_task"; phase: string; content: string; notes?: string }
	| { op: "update"; id: string; status?: TodoStatus; content?: string; notes?: string }
	| { op: "remove_task"; id: string };

const TodoWriteParams = Type.Object(
	{
		ops: Type.Array(Type.Any(), { description: "Todo write operations" }),
	},
	{ additionalProperties: true },
);

const TODO_WRITE_DIR = ".todos";
const TODO_WRITE_FILE = "todo-write-state.json";

function createEmptyState(): TodoState {
	return { phases: [] };
}

function getStatePath(cwd: string): string {
	return join(cwd, TODO_WRITE_DIR, TODO_WRITE_FILE);
}

function isStatus(value: unknown): value is TodoStatus {
	return value === "pending" || value === "in_progress" || value === "completed" || value === "abandoned";
}

function normalizeTaskInput(raw: unknown): ReplaceTaskInput | null {
	if (!raw || typeof raw !== "object") return null;
	const entry = raw as Record<string, unknown>;
	if (typeof entry.content !== "string" || !entry.content.trim()) return null;

	const status = entry.status;
	if (status != null && !isStatus(status)) return null;

	const notes = entry.notes;
	if (notes != null && typeof notes !== "string") return null;

	return {
		content: entry.content,
		status: status ?? "pending",
		notes: typeof notes === "string" ? notes : "",
	};
}

function normalizeOps(rawOps: unknown): { ops?: TodoWriteOp[]; error?: string } {
	if (!Array.isArray(rawOps) || rawOps.length === 0) {
		return { error: "ops must be a non-empty array." };
	}

	const ops: TodoWriteOp[] = [];
	for (const raw of rawOps) {
		if (!raw || typeof raw !== "object") return { error: "Each op must be an object." };
		const op = raw as Record<string, unknown>;
		if (op.op === "replace") {
			if (!Array.isArray(op.phases)) return { error: "replace requires phases array." };
			const phases: ReplacePhaseInput[] = [];
			for (const rawPhase of op.phases) {
				if (!rawPhase || typeof rawPhase !== "object") return { error: "replace phases must be objects." };
				const phaseObj = rawPhase as Record<string, unknown>;
				if (typeof phaseObj.name !== "string" || !phaseObj.name.trim()) {
					return { error: "phase name is required." };
				}
				if (!Array.isArray(phaseObj.tasks)) return { error: "phase tasks must be an array." };
				const tasks: ReplaceTaskInput[] = [];
				for (const rawTask of phaseObj.tasks) {
					const task = normalizeTaskInput(rawTask);
					if (!task) return { error: "invalid replace task entry." };
					tasks.push(task);
				}
				phases.push({ name: phaseObj.name, tasks });
			}
			ops.push({ op: "replace", phases });
			continue;
		}

		if (op.op === "add_phase") {
			if (typeof op.name !== "string" || !op.name.trim()) return { error: "add_phase requires name." };
			if (!Array.isArray(op.tasks)) return { error: "add_phase requires tasks array." };
			const tasks: ReplaceTaskInput[] = [];
			for (const rawTask of op.tasks) {
				const task = normalizeTaskInput(rawTask);
				if (!task) return { error: "invalid add_phase task entry." };
				tasks.push(task);
			}
			ops.push({ op: "add_phase", name: op.name, tasks });
			continue;
		}

		if (op.op === "add_task") {
			if (typeof op.phase !== "string" || !op.phase.trim()) return { error: "add_task requires phase id." };
			if (typeof op.content !== "string" || !op.content.trim()) return { error: "add_task requires content." };
			if (op.notes != null && typeof op.notes !== "string") return { error: "add_task notes must be string." };
			ops.push({
				op: "add_task",
				phase: op.phase,
				content: op.content,
				notes: typeof op.notes === "string" ? op.notes : "",
			});
			continue;
		}

		if (op.op === "update") {
			if (typeof op.id !== "string" || !op.id.trim()) return { error: "update requires id." };
			if (op.status != null && !isStatus(op.status)) return { error: "update status is invalid." };
			if (op.content != null && typeof op.content !== "string") return { error: "update content must be string." };
			if (op.notes != null && typeof op.notes !== "string") return { error: "update notes must be string." };
			ops.push({
				op: "update",
				id: op.id,
				status: op.status as TodoStatus | undefined,
				content: op.content as string | undefined,
				notes: op.notes as string | undefined,
			});
			continue;
		}

		if (op.op === "remove_task") {
			if (typeof op.id !== "string" || !op.id.trim()) return { error: "remove_task requires id." };
			ops.push({ op: "remove_task", id: op.id });
			continue;
		}

		return { error: `unsupported op: ${String(op.op)}` };
	}

	return { ops };
}

function getMaxPhaseNumber(state: TodoState): number {
	return state.phases
		.map((phase) => Number(phase.id.replace("phase-", "")))
		.filter((n) => Number.isInteger(n) && n > 0)
		.reduce((acc, n) => Math.max(acc, n), 0);
}

function getMaxTaskNumber(state: TodoState): number {
	return state.phases
		.flatMap((phase) => phase.tasks)
		.map((task) => Number(task.id.replace("task-", "")))
		.filter((n) => Number.isInteger(n) && n > 0)
		.reduce((acc, n) => Math.max(acc, n), 0);
}

function validateInProgressInvariant(state: TodoState): { error?: string } {
	const inProgressCount = state.phases.flatMap((phase) => phase.tasks).filter((task) => task.status === "in_progress").length;
	if (inProgressCount > 1) {
		return { error: "Exactly one task may be in_progress at a time; found multiple in_progress tasks." };
	}
	return {};
}

export function applyTodoWriteOps(state: TodoState, ops: TodoWriteOp[]): { state?: TodoState; error?: string } {
	let next: TodoState = {
		phases: state.phases.map((phase) => ({ ...phase, tasks: phase.tasks.map((task) => ({ ...task })) })),
	};
	let phaseCounter = getMaxPhaseNumber(next);
	let taskCounter = getMaxTaskNumber(next);

	for (const op of ops) {
		if (op.op === "replace") {
			const phases: TodoPhase[] = [];
			let phaseNum = 1;
			let taskNum = 1;
			for (const phase of op.phases) {
				const tasks: TodoTask[] = phase.tasks.map((task) => ({
					id: `task-${taskNum++}`,
					content: task.content,
					status: task.status ?? "pending",
					notes: task.notes ?? "",
				}));
				phases.push({ id: `phase-${phaseNum++}`, name: phase.name, tasks });
			}
			next = { phases };
			phaseCounter = getMaxPhaseNumber(next);
			taskCounter = getMaxTaskNumber(next);
			continue;
		}

		if (op.op === "add_phase") {
			const phaseId = `phase-${++phaseCounter}`;
			const tasks: TodoTask[] = op.tasks.map((task) => ({
				id: `task-${++taskCounter}`,
				content: task.content,
				status: task.status ?? "pending",
				notes: task.notes ?? "",
			}));
			next.phases.push({ id: phaseId, name: op.name, tasks });
			continue;
		}

		if (op.op === "add_task") {
			const phase = next.phases.find((entry) => entry.id === op.phase);
			if (!phase) return { error: `Phase ${op.phase} not found.` };
			phase.tasks.push({
				id: `task-${++taskCounter}`,
				content: op.content,
				status: "pending",
				notes: op.notes ?? "",
			});
			continue;
		}

		if (op.op === "update") {
			const task = next.phases.flatMap((phase) => phase.tasks).find((entry) => entry.id === op.id);
			if (!task) return { error: `Task ${op.id} not found.` };
			if (op.status !== undefined) task.status = op.status;
			if (op.content !== undefined) task.content = op.content;
			if (op.notes !== undefined) task.notes = op.notes;
			continue;
		}

		const phase = next.phases.find((entry) => entry.tasks.some((task) => task.id === op.id));
		if (!phase) return { error: `Task ${op.id} not found.` };
		phase.tasks = phase.tasks.filter((task) => task.id !== op.id);
	}

	const invariant = validateInProgressInvariant(next);
	if (invariant.error) return { error: invariant.error };
	return { state: next };
}

export function renderTodoWriteSummary(state: TodoState): string {
	const remaining = state.phases.flatMap((phase) => phase.tasks).filter((task) => task.status === "pending" || task.status === "in_progress");
	if (remaining.length === 0) return "Remaining items: none.";

	const lines: string[] = [`Remaining items (${remaining.length}):`];
	for (const task of remaining) {
		lines.push(`  - ${task.id} ${task.content} [${task.status}]`);
	}

	for (const phase of state.phases) {
		const total = phase.tasks.length;
		const done = phase.tasks.filter((task) => task.status === "completed").length;
		lines.push(`Phase ${phase.id} \"${phase.name}\" — ${done}/${total} tasks complete`);
		for (const task of phase.tasks) {
			const marker = task.status === "completed" ? "✓" : task.status === "in_progress" ? "→" : task.status === "abandoned" ? "✗" : "○";
			lines.push(`  ${marker} ${task.id} ${task.content}`);
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
				if (
					typeof task.id !== "string" ||
					typeof task.content !== "string" ||
					typeof task.notes !== "string" ||
					!isStatus(task.status)
				) {
					continue;
				}
				tasks.push({
					id: task.id,
					content: task.content,
					status: task.status,
					notes: task.notes,
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

export default function todoWriteExtension(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "todo_write",
		label: "Todo Write",
		description:
			"Manage phased todos via ops. Supports replace/update/add_phase/add_task/remove_task with statuses pending/in_progress/completed/abandoned.",
		parameters: TodoWriteParams,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const parsed = normalizeOps((params as Record<string, unknown>).ops);
			if (!parsed.ops) {
				return {
					isError: true,
					content: [{ type: "text" as const, text: `Error: ${parsed.error ?? "invalid ops"}` }],
					details: undefined,
				};
			}

			const current = await readTodoWriteState(ctx.cwd);
			const applied = applyTodoWriteOps(current, parsed.ops);
			if (!applied.state) {
				return {
					isError: true,
					content: [{ type: "text" as const, text: `Error: ${applied.error ?? "failed to apply ops"}` }],
					details: undefined,
				};
			}

			await writeTodoWriteState(ctx.cwd, applied.state);
			return {
				content: [{ type: "text" as const, text: renderTodoWriteSummary(applied.state) }],
				details: { phases: applied.state.phases },
			};
		},
	});
}
