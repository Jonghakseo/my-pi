import type { ExtensionAPI, ExtensionContext, Theme } from "@mariozechner/pi-coding-agent";
import type { OverlayHandle, TUI } from "@mariozechner/pi-tui";
import { truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";

type AutoCommitState = {
	enabled: boolean;
};

type AutoCommitStateEntryData = AutoCommitState & {
	updatedAt: number;
};

type AutoCommitPhase = "커밋 필요 내역 확인중" | "커밋 시도" | "커밋 메시지 생성중" | "precommit 동작중";

type PhaseUpdater = (phase: AutoCommitPhase) => Promise<void>;

type OverlayRecord = {
	opening: boolean;
	phase: AutoCommitPhase;
	component?: AutoCommitOverlayComponent;
	handle?: OverlayHandle;
	close?: () => void;
};

type ExecResult = {
	stdout: string;
	stderr: string;
	code: number;
	killed?: boolean;
};

type CommitAttempt =
	| { kind: "success"; message: string }
	| { kind: "no-changes" }
	| { kind: "failed"; stdout: string; stderr: string; code: number };

type TextBlock = {
	type: "text";
	text: string;
};

type MessageLike = {
	role?: string;
	content?: unknown;
	toolName?: unknown;
	name?: unknown;
};

const AUTO_COMMIT_STATE_ENTRY_TYPE = "auto-commit-state";
const AUTO_COMMIT_OVERLAY_WIDTH = 34;
const GIT_TIMEOUT_MS = 120_000;
const LLM_TIMEOUT_MS = 120_000;
const MAX_DIFF_CONTEXT_CHARS = 12_000;
const MAX_CONVERSATION_CONTEXT_CHARS = 3_000;
const MIN_PHASE_VISIBLE_MS = 1_000;

const stateStore = new Map<string, AutoCommitState>();
const overlayStore = new Map<string, OverlayRecord>();
const runningStore = new Map<string, boolean>();

function defaultState(): AutoCommitState {
	return { enabled: false };
}

function getStateKey(ctx: Pick<ExtensionContext, "cwd" | "sessionManager">): string {
	const sessionFile = ctx.sessionManager.getSessionFile?.();
	return sessionFile ? `session:${sessionFile}` : `cwd:${ctx.cwd}`;
}

function isStateEntryData(value: unknown): value is AutoCommitStateEntryData {
	if (!value || typeof value !== "object") return false;
	const candidate = value as Partial<AutoCommitStateEntryData>;
	return typeof candidate.enabled === "boolean" && typeof candidate.updatedAt === "number";
}

function readState(ctx: Pick<ExtensionContext, "cwd" | "sessionManager">): AutoCommitState {
	const state = stateStore.get(getStateKey(ctx)) ?? defaultState();
	return { ...state };
}

function writeState(ctx: Pick<ExtensionContext, "cwd" | "sessionManager">, state: AutoCommitState): void {
	stateStore.set(getStateKey(ctx), { ...state });
}

function persistState(pi: Pick<ExtensionAPI, "appendEntry">, state: AutoCommitState): void {
	pi.appendEntry<AutoCommitStateEntryData>(AUTO_COMMIT_STATE_ENTRY_TYPE, {
		...state,
		updatedAt: Date.now(),
	});
}

function restoreState(ctx: Pick<ExtensionContext, "cwd" | "sessionManager">): AutoCommitState {
	const branch = ctx.sessionManager.getBranch?.() ?? [];
	for (let index = branch.length - 1; index >= 0; index -= 1) {
		const entry = branch[index];
		if (entry?.type !== "custom" || entry.customType !== AUTO_COMMIT_STATE_ENTRY_TYPE) continue;
		if (!isStateEntryData(entry.data)) continue;
		const restored = { enabled: entry.data.enabled };
		writeState(ctx, restored);
		return restored;
	}

	const empty = defaultState();
	writeState(ctx, empty);
	return empty;
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function padAnsi(text: string, width: number): string {
	const clipped = truncateToWidth(text, width, "…", true);
	return `${clipped}${" ".repeat(Math.max(0, width - visibleWidth(clipped)))}`;
}

class AutoCommitOverlayComponent {
	private phase: AutoCommitPhase;

	constructor(
		private readonly tui: TUI,
		private readonly theme: Theme,
		phase: AutoCommitPhase,
	) {
		this.phase = phase;
	}

	setPhase(phase: AutoCommitPhase): void {
		this.phase = phase;
		this.tui.requestRender();
	}

	render(width: number): string[] {
		const outerWidth = Math.min(AUTO_COMMIT_OVERLAY_WIDTH, Math.max(18, width));
		const innerWidth = Math.max(1, outerWidth - 2);
		const border = (text: string) => this.theme.fg("borderAccent", text);
		const row = (text: string) => `${border("│")}${padAnsi(text, innerWidth)}${border("│")}`;
		const title = this.theme.fg("accent", this.theme.bold(" 자동 커밋 활성화 "));
		const titleWidth = visibleWidth(title);
		const titlePad = Math.max(0, innerWidth - titleWidth);
		const phase = this.theme.fg("toolOutput", this.phase);

		return [
			`${border("╭")}${title}${border("─".repeat(titlePad))}${border("╮")}`,
			row(` ${phase}`),
			`${border("╰")}${border("─".repeat(innerWidth))}${border("╯")}`,
		];
	}

	invalidate(): void {
		this.tui.requestRender();
	}

	dispose(): void {}
}

function hideOverlay(key: string): void {
	const record = overlayStore.get(key);
	if (!record) return;
	record.close?.();
	record.handle?.hide();
	record.component?.dispose();
	overlayStore.delete(key);
}

function showOrUpdateOverlay(ctx: ExtensionContext, key: string, phase: AutoCommitPhase): void {
	if (!ctx.hasUI) return;

	const record = overlayStore.get(key);
	if (record?.component) {
		record.phase = phase;
		record.component.setPhase(phase);
		return;
	}
	if (record?.opening) {
		record.phase = phase;
		return;
	}

	overlayStore.set(key, { opening: true, phase });
	const overlayPromise = ctx.ui.custom<void>(
		(tui, theme, _keybindings, done) => {
			const latest = overlayStore.get(key);
			const component = new AutoCommitOverlayComponent(tui, theme, latest?.phase ?? phase);
			overlayStore.set(key, {
				opening: false,
				phase: latest?.phase ?? phase,
				component,
				close: done,
				handle: latest?.handle,
			});
			return component;
		},
		{
			overlay: true,
			overlayOptions: {
				anchor: "top-left",
				width: AUTO_COMMIT_OVERLAY_WIDTH,
				maxHeight: 3,
				margin: { top: 1, left: 2 },
				nonCapturing: true,
				visible: (termWidth) => termWidth >= 50,
			},
			onHandle: (handle) => {
				const current = overlayStore.get(key) ?? { opening: false, phase };
				overlayStore.set(key, { ...current, handle });
			},
		},
	);
	void overlayPromise
		.finally(() => {
			const current = overlayStore.get(key);
			current?.component?.dispose();
			overlayStore.delete(key);
		})
		.catch(() => {});
}

async function exec(
	pi: ExtensionAPI,
	command: string,
	args: string[],
	cwd: string,
	timeout = GIT_TIMEOUT_MS,
): Promise<ExecResult> {
	const result = await pi.exec(command, args, { cwd, timeout });
	return {
		stdout: result.stdout ?? "",
		stderr: result.stderr ?? "",
		code: result.code ?? 1,
		killed: result.killed,
	};
}

async function findGitRoot(pi: ExtensionAPI, cwd: string): Promise<string | null> {
	const result = await exec(pi, "git", ["rev-parse", "--show-toplevel"], cwd, GIT_TIMEOUT_MS);
	if (result.code !== 0) return null;
	const root = result.stdout.trim();
	return root.length > 0 ? root : null;
}

async function hasWorkingTreeChanges(pi: ExtensionAPI, repoRoot: string): Promise<boolean> {
	const result = await exec(pi, "git", ["status", "--porcelain=1", "-uall"], repoRoot, GIT_TIMEOUT_MS);
	return result.code === 0 && result.stdout.trim().length > 0;
}

async function hasStagedDiff(pi: ExtensionAPI, repoRoot: string): Promise<boolean> {
	const result = await exec(pi, "git", ["diff", "--cached", "--quiet", "--exit-code"], repoRoot, GIT_TIMEOUT_MS);
	return result.code === 1;
}

function truncateCommitSubject(subject: string): string {
	if (subject.length <= 72) return subject;
	return `${subject.slice(0, 71)}…`;
}

function truncateContext(text: string, maxChars: number): string {
	if (text.length <= maxChars) return text;
	return `${text.slice(0, maxChars)}\n\n[truncated ${text.length - maxChars} chars]`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function extractText(content: unknown): string {
	if (!Array.isArray(content)) return "";
	return content
		.filter((block): block is TextBlock => isRecord(block) && block.type === "text" && typeof block.text === "string")
		.map((block) => block.text)
		.join("\n")
		.trim();
}

function getStringField(value: Record<string, unknown>, key: string): string | null {
	const field = value[key];
	return typeof field === "string" && field.trim().length > 0 ? field.trim() : null;
}

function extractToolCallNames(content: unknown): string[] {
	if (!Array.isArray(content)) return [];
	const names: string[] = [];
	for (const block of content) {
		if (!isRecord(block)) continue;
		const type = getStringField(block, "type");
		if (type !== "toolCall" && type !== "tool_call" && type !== "toolUse" && type !== "tool_use") continue;
		const name = getStringField(block, "name") ?? getStringField(block, "toolName");
		if (name) names.push(name);
	}
	return Array.from(new Set(names));
}

function extractToolResultName(message: MessageLike): string | null {
	if (typeof message.toolName === "string" && message.toolName.trim().length > 0) return message.toolName.trim();
	if (typeof message.name === "string" && message.name.trim().length > 0) return message.name.trim();
	return null;
}

function extractRecentConversation(ctx: ExtensionContext): string {
	const lines: string[] = [];
	for (const entry of ctx.sessionManager.getEntries()) {
		if (!entry || entry.type !== "message") continue;
		const message = entry.message as MessageLike;
		if (message.role === "user" || message.role === "assistant") {
			const text = extractText(message.content);
			if (text.length > 0) lines.push(`${message.role}: ${text}`);

			const toolNames = message.role === "assistant" ? extractToolCallNames(message.content) : [];
			if (toolNames.length > 0) lines.push(`assistant tools: ${toolNames.join(", ")}`);
			continue;
		}

		if (message.role === "toolResult") {
			const toolName = extractToolResultName(message);
			if (toolName) lines.push(`tool: ${toolName}`);
		}
	}

	const joined = lines.join("\n");
	if (joined.length <= MAX_CONVERSATION_CONTEXT_CHARS) return joined;
	return joined.slice(joined.length - MAX_CONVERSATION_CONTEXT_CHARS);
}

function parseCommitMessage(output: string): string | null {
	const explicit = output.match(/COMMIT_MESSAGE=(.+)/);
	const raw = explicit?.[1] ?? output.split("\n").find((line) => line.trim().length > 0);
	if (!raw) return null;

	const subject = raw
		.trim()
		.replace(/^[-*]\s+/, "")
		.replace(/^`+|`+$/g, "")
		.replace(/^['"]|['"]$/g, "")
		.trim();
	if (!subject || subject.includes("\n")) return null;
	return truncateCommitSubject(subject);
}

async function readStagedDiffContext(pi: ExtensionAPI, repoRoot: string): Promise<string> {
	const [nameStatus, stat, diff] = await Promise.all([
		exec(pi, "git", ["diff", "--cached", "--name-status"], repoRoot, GIT_TIMEOUT_MS),
		exec(pi, "git", ["diff", "--cached", "--stat", "--no-color"], repoRoot, GIT_TIMEOUT_MS),
		exec(pi, "git", ["diff", "--cached", "--no-color", "--unified=3"], repoRoot, GIT_TIMEOUT_MS),
	]);

	return [
		"Changed files:",
		nameStatus.stdout.trim() || "(none)",
		"",
		"Diff stat:",
		stat.stdout.trim() || "(none)",
		"",
		"Diff:",
		truncateContext(diff.stdout.trim() || "(none)", MAX_DIFF_CONTEXT_CHARS),
	].join("\n");
}

async function generateCommitMessage(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	repoRoot: string,
): Promise<string | null> {
	const [diffContext, conversation] = await Promise.all([
		readStagedDiffContext(pi, repoRoot),
		Promise.resolve(extractRecentConversation(ctx)),
	]);
	const prompt = `You are a git commit message assistant. Generate one concise commit subject for the staged changes.

Requirements:
- Use Conventional Commits style: type(scope optional): summary
- Prefer the language/style implied by the repository and change context.
- Keep it under 72 characters when possible.
- Do not include markdown, quotes, bullets, or explanation.
- Your final output MUST be exactly one line in this format: COMMIT_MESSAGE=<subject>

Recent conversation context:
${conversation || "(none)"}

${diffContext}`;

	const result = await exec(
		pi,
		"pi",
		[
			"--no-session",
			"--no-tools",
			"--no-extensions",
			"--no-skills",
			"--no-prompt-templates",
			"--no-context-files",
			"-p",
			prompt,
		],
		repoRoot,
		LLM_TIMEOUT_MS,
	);
	if (result.code !== 0) return null;
	return parseCommitMessage(result.stdout);
}

async function attemptCommit(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	repoRoot: string,
	showPhase: PhaseUpdater,
): Promise<CommitAttempt> {
	await exec(pi, "git", ["add", "-A"], repoRoot, GIT_TIMEOUT_MS);
	if (!(await hasStagedDiff(pi, repoRoot))) return { kind: "no-changes" };

	await showPhase("커밋 메시지 생성중");
	const message = await generateCommitMessage(pi, ctx, repoRoot);
	if (!message) {
		return {
			kind: "failed",
			stdout: "",
			stderr: "Failed to generate commit message with LLM.",
			code: 1,
		};
	}

	await showPhase("precommit 동작중");
	const result = await exec(pi, "git", ["commit", "-m", message], repoRoot, GIT_TIMEOUT_MS);
	if (result.code === 0) return { kind: "success", message };

	return {
		kind: "failed",
		stdout: result.stdout,
		stderr: result.stderr,
		code: result.code,
	};
}

async function runAutoCommit(pi: ExtensionAPI, ctx: ExtensionContext, key: string): Promise<void> {
	let phaseStartedAt = 0;
	let hasVisiblePhase = false;
	const waitForCurrentPhase = async () => {
		if (!ctx.hasUI || !hasVisiblePhase) return;
		const remainingMs = MIN_PHASE_VISIBLE_MS - (Date.now() - phaseStartedAt);
		if (remainingMs > 0) await sleep(remainingMs);
	};
	const showPhase: PhaseUpdater = async (phase) => {
		await waitForCurrentPhase();
		showOrUpdateOverlay(ctx, key, phase);
		if (!ctx.hasUI) return;
		hasVisiblePhase = true;
		phaseStartedAt = Date.now();
	};

	try {
		await showPhase("커밋 필요 내역 확인중");

		const repoRoot = await findGitRoot(pi, ctx.cwd);
		if (!repoRoot) return;
		if (!(await hasWorkingTreeChanges(pi, repoRoot))) return;

		await showPhase("커밋 시도");
		await attemptCommit(pi, ctx, repoRoot, showPhase);
	} finally {
		await waitForCurrentPhase();
	}
}

function setEnabled(pi: Pick<ExtensionAPI, "appendEntry">, ctx: ExtensionContext, enabled: boolean): void {
	const state = { enabled };
	writeState(ctx, state);
	persistState(pi, state);
	if (!enabled) hideOverlay(getStateKey(ctx));
}

export default function autoCommitExtension(pi: ExtensionAPI): void {
	pi.registerCommand("auto-commit:on", {
		description: "Enable automatic git commit after each agent turn when files changed",
		handler: async (_args, ctx) => {
			setEnabled(pi, ctx, true);
			ctx.ui.notify("자동 커밋을 활성화했습니다.", "info");
		},
	});

	pi.registerCommand("auto-commit:off", {
		description: "Disable automatic git commit after agent turns",
		handler: async (_args, ctx) => {
			setEnabled(pi, ctx, false);
			ctx.ui.notify("자동 커밋을 비활성화했습니다.", "info");
		},
	});

	pi.registerCommand("auto-commit:status", {
		description: "Show automatic git commit status",
		handler: async (_args, ctx) => {
			const state = readState(ctx);
			ctx.ui.notify(`자동 커밋: ${state.enabled ? "활성화" : "비활성화"}`, "info");
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		restoreState(ctx);
	});

	pi.on("session_tree", async (_event, ctx) => {
		restoreState(ctx);
	});

	pi.on("agent_end", async (_event, ctx) => {
		const state = readState(ctx);
		if (!state.enabled) return;

		const key = getStateKey(ctx);
		if (runningStore.get(key)) return;
		runningStore.set(key, true);
		try {
			await runAutoCommit(pi, ctx, key);
		} finally {
			runningStore.delete(key);
			hideOverlay(key);
		}
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		const key = getStateKey(ctx);
		hideOverlay(key);
		stateStore.delete(key);
		runningStore.delete(key);
	});
}
