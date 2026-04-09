/** biome-ignore-all lint/suspicious/noExplicitAny: Claude stream events are dynamic runtime data. */
import type { Message } from "@mariozechner/pi-ai";
import { extractActivityPreviewFromTextDelta, extractThoughtText } from "./live-preview.js";
import type { SingleResult } from "./types.js";

export interface ClaudeStreamState {
	sessionId: string | undefined;
	model: string | undefined;
	messages: Message[];
	liveText: string | undefined;
	liveThinking: string | undefined;
	liveToolCalls: number;
	thoughtText: string | undefined;
	stopReason: string | undefined;
	errorMessage: string | undefined;
	usage: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		cost: number;
		contextTokens: number;
		turns: number;
	};
	resultReceived: boolean;
	resultEvent: any | undefined;
	isError: boolean;
	permissionDenials: any[];
	liveActivityPreview: string | undefined;
	currentToolName: string | undefined;
	currentToolInput: string;
}

export function createStreamState(): ClaudeStreamState {
	return {
		sessionId: undefined,
		model: undefined,
		messages: [],
		liveText: undefined,
		liveThinking: undefined,
		liveToolCalls: 0,
		thoughtText: undefined,
		stopReason: undefined,
		errorMessage: undefined,
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
		resultReceived: false,
		resultEvent: undefined,
		isError: false,
		permissionDenials: [],
		liveActivityPreview: undefined,
		currentToolName: undefined,
		currentToolInput: "",
	};
}

export function processClaudeEvent(state: ClaudeStreamState, event: any): boolean {
	if (event.session_id && !state.sessionId) {
		state.sessionId = event.session_id;
	}

	if (event.type === "system") {
		if (event.subtype === "init") {
			if (event.model && !state.model) state.model = event.model;
		}
		return false;
	}

	if (event.type === "stream_event") {
		return processStreamEvent(state, event.event);
	}

	if (event.type === "assistant") {
		return processAssistantSnapshot(state, event);
	}

	if (event.type === "user") {
		processUserEvent(state, event);
		return false;
	}

	if (event.type === "result") {
		processResultEvent(state, event);
		return true;
	}

	return false;
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: event dispatch with many branches; splitting would hurt readability
function processStreamEvent(state: ClaudeStreamState, ev: any): boolean {
	if (!ev || !ev.type) return false;

	if (ev.type === "message_start") {
		const msg = ev.message;
		if (msg?.model && !state.model) state.model = msg.model;
		state.liveThinking = undefined;
		state.thoughtText = undefined;
		return false;
	}

	if (ev.type === "content_block_start") {
		const block = ev.content_block;
		if (block?.type === "text") {
			state.liveText = "";
		} else if (block?.type === "tool_use") {
			state.liveToolCalls++;
			state.currentToolName = block.name;
			state.currentToolInput = "";
			state.liveActivityPreview = `\u2192 ${block.name}`;
		} else if (block?.type === "thinking") {
			state.liveThinking = undefined;
		}
		return false;
	}

	if (ev.type === "content_block_delta") {
		const delta = ev.delta;
		if (delta?.type === "text_delta") {
			const chunk = delta.text ?? "";
			state.liveText = `${state.liveText ?? ""}${chunk}`;
			const preview = extractActivityPreviewFromTextDelta(state.liveText);
			if (preview) state.liveActivityPreview = preview;
		} else if (delta?.type === "input_json_delta") {
			state.currentToolInput += delta.partial_json ?? "";
			if (state.currentToolName) {
				const argSnippet = state.currentToolInput.slice(0, 80);
				state.liveActivityPreview = `\u2192 ${state.currentToolName}(${argSnippet})`;
			}
		} else if (delta?.type === "thinking_delta") {
			const raw = delta.thinking ?? "";
			if (raw) {
				state.liveThinking = `${state.liveThinking ?? ""}${raw}`;
				const thoughtText = extractThoughtText(state.liveThinking);
				if (thoughtText) state.thoughtText = thoughtText;
			}
		}
		return false;
	}

	if (ev.type === "content_block_stop") {
		state.currentToolName = undefined;
		state.currentToolInput = "";
		return false;
	}

	if (ev.type === "message_delta") {
		const usage = ev.usage;
		if (usage) {
			state.usage.input += usage.input_tokens || 0;
			state.usage.output += usage.output_tokens || 0;
			state.usage.cacheRead += usage.cache_read_input_tokens || 0;
			state.usage.cacheWrite += usage.cache_creation_input_tokens || 0;
		}
		if (ev.delta?.stop_reason) {
			state.stopReason = ev.delta.stop_reason;
		}
		return false;
	}

	return false;
}

function extractThoughtTextFromClaudeMessage(msg: any): string | undefined {
	for (const block of msg.content ?? []) {
		if (block.type !== "thinking") continue;
		const thoughtText = extractThoughtText(block.thinking ?? "");
		if (thoughtText) return thoughtText;
	}
	return undefined;
}

function processAssistantSnapshot(state: ClaudeStreamState, event: any): boolean {
	const msg = event.message;
	if (!msg) return false;

	if (msg.model && !state.model) state.model = msg.model;

	if (event.error) {
		state.errorMessage = event.error;
	}

	const piMessage = claudeMessageToPi(msg);
	state.messages.push(piMessage);
	state.usage.turns++;

	const thoughtText = extractThoughtTextFromClaudeMessage(msg);
	if (thoughtText) state.thoughtText = thoughtText;

	state.liveText = undefined;
	state.liveThinking = undefined;
	state.currentToolName = undefined;
	state.currentToolInput = "";

	return false;
}

function processUserEvent(state: ClaudeStreamState, event: any): void {
	const msg = event.message;
	if (!msg) return;

	const contentBlocks: any[] = [];
	for (const block of msg.content ?? []) {
		if (block.type === "tool_result") {
			const textContent = typeof block.content === "string" ? block.content : JSON.stringify(block.content);
			contentBlocks.push({ type: "text", text: textContent });
		}
	}

	const piMessage = {
		role: "user" as const,
		content: contentBlocks.length > 0 ? contentBlocks : [{ type: "text" as const, text: "" }],
		timestamp: Date.now(),
	} as Message;

	state.messages.push(piMessage);
}

function processResultEvent(state: ClaudeStreamState, event: any): void {
	state.resultReceived = true;
	state.resultEvent = event;
	state.isError = event.is_error === true;
	state.stopReason = event.stop_reason;
	state.permissionDenials = event.permission_denials ?? [];

	if (event.session_id) state.sessionId = event.session_id;

	if (event.is_error && event.result) {
		state.errorMessage = event.result;
	}

	if (event.usage) {
		const u = event.usage;
		state.usage = {
			input: u.input_tokens || 0,
			output: u.output_tokens || 0,
			cacheRead: u.cache_read_input_tokens || 0,
			cacheWrite: u.cache_creation_input_tokens || 0,
			cost: event.total_cost_usd || 0,
			contextTokens: (u.input_tokens || 0) + (u.output_tokens || 0) + (u.cache_read_input_tokens || 0),
			turns: event.num_turns || state.usage.turns,
		};
	}
}

function claudeMessageToPi(msg: any): Message {
	const content: any[] = [];

	for (const block of msg.content ?? []) {
		if (block.type === "text") {
			content.push({ type: "text", text: block.text });
		} else if (block.type === "tool_use") {
			content.push({
				type: "toolCall",
				id: block.id,
				name: block.name,
				arguments: block.input ?? {},
			});
		} else if (block.type === "thinking") {
			content.push({ type: "thinking", thinking: block.thinking ?? "" });
		}
	}

	return {
		role: msg.role ?? "assistant",
		content,
		model: msg.model,
		stopReason: msg.stop_reason ?? undefined,
		usage: msg.usage
			? {
					input: msg.usage.input_tokens || 0,
					output: msg.usage.output_tokens || 0,
					cacheRead: msg.usage.cache_read_input_tokens || 0,
					cacheWrite: msg.usage.cache_creation_input_tokens || 0,
				}
			: undefined,
	} as any;
}

export function stateToSingleResult(
	state: ClaudeStreamState,
	agent: string,
	agentSource: "user" | "project" | "unknown",
	task: string,
	exitCode: number,
	step: number | undefined,
	stderr: string,
): SingleResult {
	const result: SingleResult = {
		agent,
		agentSource,
		task,
		exitCode,
		messages: state.messages,
		stderr,
		usage: { ...state.usage },
		model: state.model,
		stopReason: state.stopReason,
		errorMessage: state.errorMessage,
		step,
		runtime: "claude",
		claudeSessionId: state.sessionId,
	};

	if (state.liveThinking) {
		result.liveThinking = state.liveThinking;
	}
	if (state.thoughtText) {
		result.thoughtText = state.thoughtText;
	}
	if (state.liveActivityPreview) {
		result.liveActivityPreview = state.liveActivityPreview;
	}

	if (state.isError && !result.errorMessage && state.resultEvent?.result) {
		result.errorMessage = state.resultEvent.result;
	}

	if (state.permissionDenials.length > 0) {
		const names = state.permissionDenials.map((d: any) => d.tool_name).join(", ");
		result.errorMessage = `Permission denied for tools: ${names}`;
	}

	return result;
}
