import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Container, Spacer, Text } from "@mariozechner/pi-tui";

const PATCH_STATE_KEY = Symbol.for("creatrip.tool-group-renderer.patch-state");
const PATCH_VERSION = "2026-04-24-r2";
const GROUP_STATE = Symbol("creatrip.tool-group-renderer.state");
const PI_INTERACTIVE_BASE = "/usr/local/lib/node_modules/@mariozechner/pi-coding-agent/dist/modes/interactive";
const BASH_PREVIEW_LIMIT = 56;

type GroupableToolName = "bash" | "read" | "edit" | "write";
type ThemeColor = "accent" | "dim" | "error" | "muted" | "success" | "text" | "toolTitle" | "warning";
type ThemeBg = "toolErrorBg" | "toolPendingBg" | "toolSuccessBg";

type RuntimeTheme = {
	fg: (color: ThemeColor, text: string) => string;
	bg: (color: ThemeBg, text: string) => string;
	bold: (text: string) => string;
};

type ToolResultLike = {
	content?: Array<{ type: string; text?: string }>;
	details?: unknown;
	isError?: boolean;
};

type GroupItem = {
	toolCallId: string;
	toolName: GroupableToolName;
	args: unknown;
	executionStarted: boolean;
	argsComplete: boolean;
	isPartial: boolean;
	isError: boolean;
	startedAt?: number;
	finishedAt?: number;
	result?: ToolResultLike;
};

type ToolHandle = {
	updateArgs: (args: unknown) => void;
	markExecutionStarted: () => void;
	setArgsComplete: () => void;
	updateResult: (result: ToolResultLike, isPartial?: boolean) => void;
};

type ToolComponentHandle = ToolHandle & { setExpanded?: (expanded: boolean) => void };

type TailCandidate = {
	toolName: GroupableToolName;
	toolCallId: string;
	item: GroupItem;
	component: ToolComponentHandle;
};

type GroupRuntimeState = {
	tailGroup: GroupedBuiltinToolComponent | null;
	tailCandidate: TailCandidate | null;
};

type InteractiveModeLike = {
	isInitialized?: boolean;
	init: () => Promise<void>;
	footer: { invalidate: () => void };
	ui: { requestRender: () => void };
	chatContainer: {
		children: unknown[];
		addChild: (child: unknown) => void;
		removeChild: (child: unknown) => void;
		clear: () => void;
	};
	pendingTools: Map<string, ToolHandle>;
	settingsManager: { getShowImages: () => boolean; getImageWidthCells: () => number };
	toolOutputExpanded: boolean;
	streamingComponent?: { updateContent: (message: unknown) => void };
	streamingMessage?: AssistantMessageLike;
	getRegisteredToolDefinition: (name: string) => unknown;
	sessionManager: { getCwd: () => string };
	session: { retryAttempt: number };
	addMessageToChat: (message: SessionMessageLike, options?: RenderSessionOptionsLike) => void;
	isFirstUserMessage: boolean;
	editor: { addToHistory?: (text: string) => void };
	getUserMessageText: (message: SessionMessageLike) => string | undefined;
	getMarkdownThemeWithSettings: () => unknown;
};

type RenderSessionOptionsLike = {
	updateFooter?: boolean;
	populateHistory?: boolean;
};

type AssistantMessageLike = {
	role: "assistant";
	content: AssistantContentLike[];
	stopReason?: string;
	errorMessage?: string;
};

type AssistantContentLike =
	| {
			type: "toolCall";
			id: string;
			name: string;
			arguments: unknown;
	  }
	| {
			type: string;
	  };

type SessionMessageLike =
	| AssistantMessageLike
	| {
			role: "toolResult";
			toolCallId: string;
			content?: Array<{ type: string; text?: string }>;
			details?: unknown;
			isError?: boolean;
	  }
	| {
			role: string;
			[key: string]: unknown;
	  };

type SessionContextLike = {
	messages: SessionMessageLike[];
};

type PrototypeMethods = {
	handleEvent: (event: {
		type: string;
		message?: SessionMessageLike;
		toolCallId?: string;
		toolName?: string;
		args?: unknown;
	}) => Promise<void>;
	renderSessionContext: (sessionContext: SessionContextLike, options?: RenderSessionOptionsLike) => void;
	addMessageToChat: (message: SessionMessageLike, options?: RenderSessionOptionsLike) => void;
};

type PatchState = {
	version?: string;
	originals?: PrototypeMethods;
	toolExecutionComponent?: new (
		toolName: string,
		toolCallId: string,
		args: unknown,
		options: { showImages: boolean; imageWidthCells: number },
		toolDefinition: unknown,
		ui: unknown,
		cwd: string,
	) => ToolHandle & { setExpanded?: (expanded: boolean) => void };
};

let runtimeTheme: RuntimeTheme | undefined;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function isAssistantToolCallContent(
	content: AssistantContentLike,
): content is Extract<AssistantContentLike, { type: "toolCall" }> {
	return content.type === "toolCall";
}

function isAssistantMessage(message: SessionMessageLike | undefined): message is AssistantMessageLike {
	return !!message && message.role === "assistant";
}

function isToolResultMessage(
	message: SessionMessageLike,
): message is Extract<SessionMessageLike, { role: "toolResult" }> {
	return message.role === "toolResult";
}

function getTheme(): RuntimeTheme {
	return (
		runtimeTheme ?? {
			fg: (_color: ThemeColor, text: string) => text,
			bg: (_color: ThemeBg, text: string) => text,
			bold: (text: string) => text,
		}
	);
}

function isGroupableTool(toolName: string): toolName is GroupableToolName {
	return toolName === "bash" || toolName === "read" || toolName === "edit" || toolName === "write";
}

function ensureGroupState(mode: InteractiveModeLike): GroupRuntimeState {
	const target = mode as InteractiveModeLike & { [GROUP_STATE]?: GroupRuntimeState };
	if (!target[GROUP_STATE]) {
		target[GROUP_STATE] = { tailGroup: null, tailCandidate: null };
	}
	return target[GROUP_STATE];
}

function hasVisibleAssistantContent(message: AssistantMessageLike): boolean {
	return message.content.some((content) => {
		if (!isRecord(content)) return false;
		const record = content as Record<string, unknown>;
		if (record.type !== "text") return false;
		return typeof record.text === "string" && record.text.trim().length > 0;
	});
}

function shouldBreakGroupForMessage(message: SessionMessageLike): boolean {
	if (isAssistantMessage(message)) {
		const hasToolCalls = message.content.some((content) => isAssistantToolCallContent(content));
		if (hasVisibleAssistantContent(message)) return true;
		return !hasToolCalls && (message.stopReason === "aborted" || message.stopReason === "error");
	}
	return message.role !== "toolResult";
}

function replaceChildInContainer(
	container: InteractiveModeLike["chatContainer"],
	previousChild: unknown,
	nextChild: unknown,
): void {
	const index = container.children.indexOf(previousChild);
	if (index === -1) {
		container.addChild(nextChild);
		return;
	}
	container.children.splice(index, 1, nextChild);
}

function isComponentLike(value: unknown): value is { render: (width: number) => string[] } {
	return isRecord(value) && typeof value.render === "function";
}

function isVisuallyEmptyChild(child: unknown): boolean {
	if (!isComponentLike(child)) return false;
	try {
		const lines = child.render(120);
		return lines.length === 0 || lines.every((line) => line.length === 0);
	} catch {
		return false;
	}
}

function findAppendableGroup(
	mode: InteractiveModeLike,
	toolName: GroupableToolName,
): GroupedBuiltinToolComponent | null {
	for (let index = mode.chatContainer.children.length - 1; index >= 0; index--) {
		const child = mode.chatContainer.children[index];
		if (child instanceof GroupedBuiltinToolComponent) {
			return child.toolName === toolName ? child : null;
		}
		if (isVisuallyEmptyChild(child)) continue;
		return null;
	}
	return null;
}

function isAppendableTailCandidate(
	mode: InteractiveModeLike,
	candidate: TailCandidate,
	toolName: GroupableToolName,
): boolean {
	if (candidate.toolName !== toolName) return false;
	for (let index = mode.chatContainer.children.length - 1; index >= 0; index--) {
		const child = mode.chatContainer.children[index];
		if (child === candidate.component) return true;
		if (isVisuallyEmptyChild(child)) continue;
		return false;
	}
	return false;
}

function truncatePreview(value: string, maxLength: number): string {
	return value.length > maxLength ? `${value.slice(0, maxLength)}…` : value;
}

function normalizeInlinePreview(value: string): string {
	return value.replace(/\r\n|\r|\n/g, " ");
}

function formatBashCommandPreview(command: string): string {
	return truncatePreview(normalizeInlinePreview(`$ ${command}`), BASH_PREVIEW_LIMIT);
}

function deriveBashTitle(command: string): string {
	const trimmed = command.trim();
	if (!trimmed) return "명령어 실행";

	const withoutEnv = trimmed.replace(/^[A-Za-z_][A-Za-z0-9_]*=\S*\s*/, "");
	const withoutSudo = withoutEnv.replace(/^sudo\s+/, "");
	const withoutBang = withoutSudo.replace(/^(?:!!\s*)?/, "");
	const match = withoutBang.match(/^\S+/);
	return match?.[0] ?? "명령어 실행";
}

function extractRawTextContent(result?: ToolResultLike): string | undefined {
	return result?.content?.find(
		(entry): entry is { type: string; text: string } => entry.type === "text" && typeof entry.text === "string",
	)?.text;
}

function extractTextContent(result?: ToolResultLike): string | undefined {
	return extractRawTextContent(result)?.trim();
}

function countRenderedTextLines(text: string): number {
	const lines = text.split("\n");
	while (lines.length > 1 && lines.at(-1) === "") {
		lines.pop();
	}
	return lines.length;
}

function summarizeEditDiff(diff: string): { added: number; removed: number } {
	let added = 0;
	let removed = 0;
	for (const line of diff.split("\n")) {
		if (line.startsWith("+++") || line.startsWith("---")) continue;
		if (line.startsWith("+")) added++;
		if (line.startsWith("-")) removed++;
	}
	return { added, removed };
}

function formatElapsedSeconds(ms: number): number {
	return Math.max(1, Math.ceil(ms / 1000));
}

function formatBashDuration(item: GroupItem): string {
	const theme = getTheme();
	if (!item.startedAt) return "";
	const endTime = item.finishedAt ?? Date.now();
	const seconds = formatElapsedSeconds(Math.max(0, endTime - item.startedAt));
	if (item.finishedAt) {
		return ` ${theme.fg("muted", `[${seconds}s]`)}`;
	}
	return ` ${theme.fg("warning", `[~${seconds}s]`)}`;
}

function formatBashLine(args: unknown, item: GroupItem): string {
	const theme = getTheme();
	const params = isRecord(args) ? args : {};
	const title = typeof params.title === "string" && params.title.length > 0 ? params.title : undefined;
	const command = typeof params.command === "string" ? params.command : "";
	const label = title ?? deriveBashTitle(command);
	const commandPreview = command ? ` (${formatBashCommandPreview(command)})` : "";
	const duration = formatBashDuration(item);
	const content = `${label}${commandPreview}${duration}`;

	if (item.isError) return `${theme.fg("muted", "ㄴ ")}${theme.fg("error", content)}`;
	if (item.isPartial || (!item.result && item.executionStarted)) {
		return `${theme.fg("muted", "ㄴ ")}${theme.fg("warning", content)}`;
	}
	return `${theme.fg("muted", "ㄴ ")}${theme.fg("text", label)}${theme.fg("dim", commandPreview)}${duration}`;
}

function formatPlainPathLine(path: string, item: GroupItem): string {
	const theme = getTheme();
	if (item.isError) return `${theme.fg("muted", "ㄴ ")}${theme.fg("error", path)}`;
	if (item.isPartial || (!item.result && item.executionStarted)) {
		return `${theme.fg("muted", "ㄴ ")}${theme.fg("warning", path)}`;
	}
	return `${theme.fg("muted", "ㄴ ")}${theme.fg("accent", path)}`;
}

function formatReadLine(args: unknown, item: GroupItem): string {
	const theme = getTheme();
	const params = isRecord(args) ? args : {};
	const path = typeof params.path === "string" && params.path.length > 0 ? params.path : "(unknown path)";
	const rawText = extractRawTextContent(item.result);
	if (!rawText) return formatPlainPathLine(path, item);

	const start = typeof params.offset === "number" && Number.isFinite(params.offset) ? params.offset : 1;
	const lineCount = countRenderedTextLines(rawText);
	const end = start + Math.max(lineCount - 1, 0);
	const suffix = theme.fg("dim", `:${start}-${end}`);
	const base = formatPlainPathLine(path, item);
	return `${base}${suffix}`;
}

function formatEditLine(args: unknown, item: GroupItem): string {
	const theme = getTheme();
	const params = isRecord(args) ? args : {};
	const path = typeof params.path === "string" && params.path.length > 0 ? params.path : "(unknown path)";
	const base = formatPlainPathLine(path, item);
	const details = isRecord(item.result?.details) ? item.result?.details : undefined;
	const diff = typeof details?.diff === "string" ? details.diff : undefined;
	if (!diff) return base;
	const { added, removed } = summarizeEditDiff(diff);
	return `${base} ${theme.fg("success", `+${added}`)} ${theme.fg("dim", "/")} ${theme.fg("error", `-${removed}`)}`;
}

function formatWriteLine(args: unknown, item: GroupItem): string {
	const params = isRecord(args) ? args : {};
	const path = typeof params.path === "string" && params.path.length > 0 ? params.path : "(unknown path)";
	return formatPlainPathLine(path, item);
}

function formatExpandedTextDetail(item: GroupItem): string[] {
	const theme = getTheme();
	const text = extractTextContent(item.result);
	if (!text) return [];

	const firstLine = text.split("\n").find((line) => line.trim().length > 0);
	if (!firstLine) return [];

	const summary = truncatePreview(firstLine.trim(), 96);
	const color: ThemeColor = item.isError ? "error" : item.isPartial ? "warning" : "dim";
	return [`  ${theme.fg(color, summary)}`];
}

function formatExpandedEditDetail(item: GroupItem): string[] {
	const theme = getTheme();
	const details = isRecord(item.result?.details) ? item.result?.details : undefined;
	const diff = typeof details?.diff === "string" ? details.diff : undefined;
	if (!diff) return formatExpandedTextDetail(item);

	const changedLines = diff
		.split("\n")
		.filter(
			(line) => (line.startsWith("+") || line.startsWith("-")) && !line.startsWith("+++") && !line.startsWith("---"),
		);
	if (changedLines.length === 0) return formatExpandedTextDetail(item);

	const previewLimit = 6;
	const preview = changedLines.slice(0, previewLimit).map((line) => {
		const color: ThemeColor = line.startsWith("+") ? "success" : "error";
		return `  ${theme.fg(color, truncatePreview(line, 96))}`;
	});
	const hidden = changedLines.length - preview.length;
	if (hidden > 0) {
		preview.push(`  ${theme.fg("dim", `… ${hidden} more changed lines`)}`);
	}
	return preview;
}

function formatExpandedDetail(item: GroupItem): string[] {
	if (item.toolName === "edit" && !item.isError) return formatExpandedEditDetail(item);
	return formatExpandedTextDetail(item);
}

function createGroupItem(toolName: GroupableToolName, toolCallId: string, args: unknown): GroupItem {
	return {
		toolCallId,
		toolName,
		args,
		executionStarted: false,
		argsComplete: false,
		isPartial: false,
		isError: false,
	};
}

function updateGroupItemResult(item: GroupItem, result: ToolResultLike, isPartial = false): void {
	item.result = result;
	item.isPartial = isPartial;
	item.isError = !!result?.isError;
	if (isPartial) {
		item.startedAt ??= Date.now();
		item.finishedAt = undefined;
	} else {
		item.startedAt ??= Date.now();
		item.finishedAt = Date.now();
	}
}

class GroupedBuiltinToolComponent extends Container {
	readonly toolName: GroupableToolName;
	private readonly content: Text;
	private items: GroupItem[] = [];
	private expanded = false;

	constructor(toolName: GroupableToolName) {
		super();
		this.toolName = toolName;
		this.addChild(new Spacer(1));
		this.content = new Text("", 1, 1);
		this.addChild(this.content);
		this.refreshDisplay();
	}

	appendItem(toolCallId: string, args: unknown): ToolHandle {
		return this.appendExistingItem(createGroupItem(this.toolName, toolCallId, args));
	}

	appendExistingItem(item: GroupItem): ToolHandle {
		this.items.push(item);
		this.refreshDisplay();
		return {
			updateArgs: (nextArgs: unknown) => {
				item.args = nextArgs;
				this.refreshDisplay();
			},
			markExecutionStarted: () => {
				item.executionStarted = true;
				item.startedAt ??= Date.now();
				this.refreshDisplay();
			},
			setArgsComplete: () => {
				item.argsComplete = true;
				this.refreshDisplay();
			},
			updateResult: (result: ToolResultLike, isPartial = false) => {
				updateGroupItemResult(item, result, isPartial);
				this.refreshDisplay();
			},
		};
	}

	getItemCount(): number {
		return this.items.length;
	}

	getSingletonItem(): GroupItem | undefined {
		return this.items.length === 1 ? this.items[0] : undefined;
	}

	setExpanded(expanded: boolean): void {
		this.expanded = expanded;
		this.refreshDisplay();
	}

	override invalidate(): void {
		super.invalidate();
		this.refreshDisplay();
	}

	private getBackgroundToken(): ThemeBg {
		if (this.items.length > 0 && this.items.every((item) => item.isError)) return "toolErrorBg";
		if (this.items.some((item) => item.isPartial || (item.executionStarted && !item.result))) return "toolPendingBg";
		return "toolSuccessBg";
	}

	private formatItemLine(item: GroupItem): string[] {
		const line =
			item.toolName === "bash"
				? formatBashLine(item.args, item)
				: item.toolName === "read"
					? formatReadLine(item.args, item)
					: item.toolName === "edit"
						? formatEditLine(item.args, item)
						: formatWriteLine(item.args, item);
		if (!this.expanded) return [line];
		return [line, ...formatExpandedDetail(item)];
	}

	private refreshDisplay(): void {
		const theme = getTheme();
		this.content.setCustomBgFn((text) => theme.bg(this.getBackgroundToken(), text));
		const header = theme.fg("toolTitle", theme.bold(this.toolName));
		const lines = [header, ...this.items.flatMap((item) => this.formatItemLine(item))];
		this.content.setText(lines.join("\n"));
	}
}

function createNormalToolInstance(
	mode: InteractiveModeLike,
	toolName: string,
	toolCallId: string,
	args: unknown,
): ToolComponentHandle {
	const ToolExecutionComponentCtor = (
		globalThis as typeof globalThis & {
			[PATCH_STATE_KEY]?: PatchState;
		}
	)[PATCH_STATE_KEY]?.toolExecutionComponent;
	if (!ToolExecutionComponentCtor) {
		throw new Error("ToolExecutionComponent constructor is not initialized");
	}

	const component = new ToolExecutionComponentCtor(
		toolName,
		toolCallId,
		args,
		{
			showImages: mode.settingsManager.getShowImages(),
			imageWidthCells: mode.settingsManager.getImageWidthCells(),
		},
		mode.getRegisteredToolDefinition(toolName),
		mode.ui,
		mode.sessionManager.getCwd(),
	);
	component.setExpanded?.(mode.toolOutputExpanded);
	return component;
}

function createNormalToolComponent(
	mode: InteractiveModeLike,
	toolName: string,
	toolCallId: string,
	args: unknown,
): ToolHandle {
	const component = createNormalToolInstance(mode, toolName, toolCallId, args);
	mode.chatContainer.addChild(component);
	return component;
}

function createRecordingToolHandle(delegate: ToolComponentHandle, item: GroupItem): ToolComponentHandle {
	return {
		updateArgs: (args: unknown) => {
			item.args = args;
			delegate.updateArgs(args);
		},
		markExecutionStarted: () => {
			item.executionStarted = true;
			item.startedAt ??= Date.now();
			delegate.markExecutionStarted();
		},
		setArgsComplete: () => {
			item.argsComplete = true;
			delegate.setArgsComplete();
		},
		updateResult: (result: ToolResultLike, isPartial = false) => {
			updateGroupItemResult(item, result, isPartial);
			delegate.updateResult(result, isPartial);
		},
		setExpanded: (expanded: boolean) => delegate.setExpanded?.(expanded),
	};
}

function createTailCandidate(
	mode: InteractiveModeLike,
	toolName: GroupableToolName,
	toolCallId: string,
	args: unknown,
): { candidate: TailCandidate; handle: ToolComponentHandle } {
	const component = createNormalToolInstance(mode, toolName, toolCallId, args);
	const item = createGroupItem(toolName, toolCallId, args);
	const handle = createRecordingToolHandle(component, item);
	mode.chatContainer.addChild(component);
	return {
		candidate: { toolName, toolCallId, item, component },
		handle,
	};
}

function promoteTailCandidateToGroup(mode: InteractiveModeLike, candidate: TailCandidate): GroupedBuiltinToolComponent {
	const group = new GroupedBuiltinToolComponent(candidate.toolName);
	group.setExpanded(mode.toolOutputExpanded);
	const firstHandle = group.appendExistingItem(candidate.item);
	replaceChildInContainer(mode.chatContainer, candidate.component, group);
	if (mode.pendingTools.has(candidate.toolCallId)) {
		mode.pendingTools.set(candidate.toolCallId, firstHandle);
	}
	return group;
}

function materializeSingletonGroup(mode: InteractiveModeLike, group: GroupedBuiltinToolComponent): void {
	const item = group.getSingletonItem();
	if (!item) return;
	const component = createNormalToolInstance(mode, item.toolName, item.toolCallId, item.args);
	if (item.executionStarted) {
		component.markExecutionStarted();
	}
	if (item.argsComplete) {
		component.setArgsComplete();
	}
	if (item.result) {
		component.updateResult(item.result, item.isPartial);
	}
	const pendingHandle = mode.pendingTools.get(item.toolCallId);
	if (pendingHandle) {
		mode.pendingTools.set(item.toolCallId, component);
	}
	replaceChildInContainer(mode.chatContainer, group, component);
}

function finalizeTailGroup(mode: InteractiveModeLike): void {
	const state = ensureGroupState(mode);
	const group = state.tailGroup;
	if (!group) return;
	if (group.getItemCount() === 1) {
		materializeSingletonGroup(mode, group);
	}
	state.tailGroup = null;
}

function breakGroup(mode: InteractiveModeLike): void {
	const state = ensureGroupState(mode);
	finalizeTailGroup(mode);
	state.tailCandidate = null;
}

function ensureToolHandle(mode: InteractiveModeLike, toolName: string, toolCallId: string, args: unknown): ToolHandle {
	if (!isGroupableTool(toolName)) {
		breakGroup(mode);
		const component = createNormalToolComponent(mode, toolName, toolCallId, args);
		mode.pendingTools.set(toolCallId, component);
		return component;
	}

	const state = ensureGroupState(mode);
	let group = findAppendableGroup(mode, toolName);
	if (group) {
		state.tailGroup = group;
		state.tailCandidate = null;
		const handle = group.appendItem(toolCallId, args);
		mode.pendingTools.set(toolCallId, handle);
		return handle;
	}

	if (state.tailCandidate && isAppendableTailCandidate(mode, state.tailCandidate, toolName)) {
		group = promoteTailCandidateToGroup(mode, state.tailCandidate);
		state.tailGroup = group;
		state.tailCandidate = null;
		const handle = group.appendItem(toolCallId, args);
		mode.pendingTools.set(toolCallId, handle);
		return handle;
	}

	finalizeTailGroup(mode);
	state.tailCandidate = null;
	const { candidate, handle } = createTailCandidate(mode, toolName, toolCallId, args);
	state.tailCandidate = candidate;
	mode.pendingTools.set(toolCallId, handle);
	return handle;
}

function updateStreamingAssistantToolCalls(mode: InteractiveModeLike, message: AssistantMessageLike): void {
	mode.streamingMessage = message;
	mode.streamingComponent?.updateContent(message);
	for (const content of message.content) {
		if (!isAssistantToolCallContent(content)) continue;
		if (!mode.pendingTools.has(content.id)) {
			ensureToolHandle(mode, content.name, content.id, content.arguments);
		} else {
			mode.pendingTools.get(content.id)?.updateArgs(content.arguments);
		}
	}
	mode.ui.requestRender();
}

function getAssistantAbortMessage(mode: InteractiveModeLike, message: AssistantMessageLike): string {
	if (message.stopReason === "aborted") {
		const retryAttempt = mode.session.retryAttempt;
		return retryAttempt > 0
			? `Aborted after ${retryAttempt} retry attempt${retryAttempt > 1 ? "s" : ""}`
			: "Operation aborted";
	}
	return message.errorMessage || "Error";
}

function renderAssistantMessageWithGroups(mode: InteractiveModeLike, message: AssistantMessageLike): void {
	mode.addMessageToChat(message);
	for (const content of message.content) {
		if (!isAssistantToolCallContent(content)) continue;
		const handle = ensureToolHandle(mode, content.name, content.id, content.arguments);
		if (message.stopReason !== "aborted" && message.stopReason !== "error") continue;
		handle.updateResult({ content: [{ type: "text", text: getAssistantAbortMessage(mode, message) }], isError: true });
		mode.pendingTools.delete(content.id);
	}
}

function applyToolResultToPendingHandle(
	mode: InteractiveModeLike,
	message: Extract<SessionMessageLike, { role: "toolResult" }>,
): void {
	const handle = mode.pendingTools.get(message.toolCallId);
	if (!handle) return;
	handle.updateResult(message);
	mode.pendingTools.delete(message.toolCallId);
}

function renderSessionContextPatched(
	mode: InteractiveModeLike,
	sessionContext: SessionContextLike,
	options: RenderSessionOptionsLike = {},
): void {
	mode.pendingTools.clear();
	mode.isFirstUserMessage = true;
	breakGroup(mode);

	if (options.updateFooter) {
		mode.footer.invalidate();
		(mode as InteractiveModeLike & { updateEditorBorderColor?: () => void }).updateEditorBorderColor?.();
	}

	for (const message of sessionContext.messages) {
		if (isAssistantMessage(message)) {
			renderAssistantMessageWithGroups(mode, message);
			continue;
		}
		if (isToolResultMessage(message)) {
			applyToolResultToPendingHandle(mode, message);
			continue;
		}
		mode.addMessageToChat(message, options);
	}

	mode.pendingTools.clear();
	breakGroup(mode);
	mode.ui.requestRender();
}

export const __test__ = {
	formatBashCommandPreview,
	ensureToolHandle,
};

export default async function toolGroupRenderer(_pi: ExtensionAPI): Promise<void> {
	const globalState = globalThis as typeof globalThis & {
		[PATCH_STATE_KEY]?: PatchState;
	};
	const patchState = globalState[PATCH_STATE_KEY] ?? {};
	globalState[PATCH_STATE_KEY] = patchState;

	const [{ InteractiveMode }, { ToolExecutionComponent }, themeModule] = await Promise.all([
		import(`${PI_INTERACTIVE_BASE}/interactive-mode.js`),
		import(`${PI_INTERACTIVE_BASE}/components/tool-execution.js`),
		import(`${PI_INTERACTIVE_BASE}/theme/theme.js`),
	]);

	patchState.toolExecutionComponent = ToolExecutionComponent;
	runtimeTheme = themeModule.theme as RuntimeTheme;

	const proto = InteractiveMode.prototype as InteractiveModeLike & PrototypeMethods;
	if (!patchState.originals) {
		patchState.originals = {
			handleEvent: proto.handleEvent,
			renderSessionContext: proto.renderSessionContext,
			addMessageToChat: proto.addMessageToChat,
		};
	} else {
		proto.handleEvent = patchState.originals.handleEvent;
		proto.renderSessionContext = patchState.originals.renderSessionContext;
		proto.addMessageToChat = patchState.originals.addMessageToChat;
	}

	const originalHandleEvent = patchState.originals.handleEvent;
	const originalRenderSessionContext = patchState.originals.renderSessionContext;
	const originalAddMessageToChat = patchState.originals.addMessageToChat;

	proto.addMessageToChat = function addMessageToChatPatched(this: InteractiveModeLike, message, options) {
		if (shouldBreakGroupForMessage(message)) {
			breakGroup(this);
		}
		return originalAddMessageToChat.call(this, message, options);
	};

	proto.handleEvent = async function handleEventPatched(this: InteractiveModeLike, event) {
		if (event.type === "agent_start" || event.type === "agent_end") {
			breakGroup(this);
		}

		if (event.type === "message_update" && isAssistantMessage(event.message)) {
			if (hasVisibleAssistantContent(event.message)) {
				breakGroup(this);
			}
			if (!this.isInitialized) {
				await this.init();
			}
			this.footer.invalidate();
			if (this.streamingComponent) {
				updateStreamingAssistantToolCalls(this, event.message);
			}
			return;
		}

		if (
			event.type === "tool_execution_start" &&
			typeof event.toolCallId === "string" &&
			typeof event.toolName === "string"
		) {
			if (!this.isInitialized) {
				await this.init();
			}
			this.footer.invalidate();
			let handle = this.pendingTools.get(event.toolCallId);
			if (!handle) {
				handle = ensureToolHandle(this, event.toolName, event.toolCallId, event.args);
			}
			handle.markExecutionStarted();
			this.ui.requestRender();
			return;
		}

		return originalHandleEvent.call(this, event);
	};

	proto.renderSessionContext = function renderSessionContextPatchedWrapper(
		this: InteractiveModeLike,
		sessionContext,
		options,
	) {
		return renderSessionContextPatched(this, sessionContext, options);
	};

	patchState.version = PATCH_VERSION;

	void originalRenderSessionContext;
}
