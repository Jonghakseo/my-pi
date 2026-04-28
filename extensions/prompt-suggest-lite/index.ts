import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { ExtensionAPI, ExtensionContext, InputEvent } from "@mariozechner/pi-coding-agent";
import type { AutocompleteItem } from "@mariozechner/pi-tui";
import {
	loadPromptSuggestLiteConfig,
	promptSuggestLiteConfigPath,
	savePromptSuggestLiteConfig,
	type PromptSuggestLiteConfig,
} from "./config.ts";
import {
	buildAbortedFallbackTurn,
	buildLatestHistoricalTurnContext,
	buildTurnContext,
	type BranchMessageEntry,
	type PromptSuggestLiteTurnContext,
} from "./context.ts";
import { generatePromptSuggestion } from "./model.ts";
import { normalizeSuggestionText, renderPromptSuggestLitePrompt } from "./prompt.ts";
import { classifySteering } from "./steering.ts";
import { promptSuggestLiteStore, type PromptSuggestLiteSource } from "./shared.ts";

const STATUS_KEY = "prompt-suggest-lite";

const PROMPT_SUGGEST_SUBCOMMANDS = [
	{ value: "status", label: "status", description: "현재 상태와 마지막 suggestion 확인" },
	{ value: "on", label: "on", description: "prompt-suggest-lite 활성화" },
	{ value: "off", label: "off", description: "prompt-suggest-lite 비활성화" },
	{ value: "reload", label: "reload", description: "prompt-suggest-lite.json 다시 읽기" },
] as const satisfies readonly AutocompleteItem[];

function getPromptSuggestArgumentCompletions(argumentPrefix: string): AutocompleteItem[] | null {
	const prefix = argumentPrefix.trimStart().toLowerCase();
	const filtered = PROMPT_SUGGEST_SUBCOMMANDS.filter((item) => item.label.toLowerCase().startsWith(prefix));
	return filtered.length > 0 ? filtered.map((item) => ({ ...item })) : null;
}

function clearFooterStatus(ctx: ExtensionContext): void {
	if (!ctx.hasUI) return;
	ctx.ui.setStatus(STATUS_KEY, undefined);
}

function cancelPendingGenerationStatus(ctx: ExtensionContext): void {
	if (promptSuggestLiteStore.getStatus().status === "generating") {
		promptSuggestLiteStore.setStatus({ status: promptSuggestLiteStore.getConfig().enabled ? "idle" : "disabled" });
	}
	clearFooterStatus(ctx);
}

function branchMessageEntries(ctx: ExtensionContext): BranchMessageEntry[] {
	return ctx.sessionManager
		.getBranch()
		.flatMap((entry) => (entry.type === "message" ? [{ id: entry.id, message: entry.message as AgentMessage }] : []));
}

function branchMessages(ctx: ExtensionContext): AgentMessage[] {
	return branchMessageEntries(ctx).map((entry) => entry.message);
}

function setSuggestion(params: {
	turn: PromptSuggestLiteTurnContext;
	text: string;
	source: PromptSuggestLiteSource;
	ctx: ExtensionContext;
}): void {
	promptSuggestLiteStore.setSuggestion({
		text: params.text,
		turnId: params.turn.turnId,
		shownAt: new Date().toISOString(),
		source: params.source,
	});
	clearFooterStatus(params.ctx);
}

function renderStatus(config: PromptSuggestLiteConfig): string {
	const suggestion = promptSuggestLiteStore.getSuggestionDetails();
	const status = promptSuggestLiteStore.getStatus();
	const steering = promptSuggestLiteStore.getSteeringHistory();
	return [
		"# prompt-suggest-lite",
		"",
		`- config: \`${promptSuggestLiteConfigPath}\``,
		`- enabled: ${config.enabled}`,
		`- modelRef: ${config.modelRef}`,
		`- thinking: ${config.thinking}`,
		`- acceptKeys: ${config.acceptKeys.join(", ")}`,
		`- status: ${status.status}`,
		status.lastModelRef ? `- lastModel: ${status.lastModelRef}` : undefined,
		status.lastGeneratedAt ? `- lastGeneratedAt: ${status.lastGeneratedAt}` : undefined,
		status.lastError ? `- lastError: ${status.lastError}` : undefined,
		`- steering events: ${steering.length}`,
		suggestion ? `- current suggestion: ${JSON.stringify(suggestion.text)}` : "- current suggestion: (none)",
	]
		.filter((line): line is string => typeof line === "string")
		.join("\n");
}

async function generateForTurn(params: {
	turn: PromptSuggestLiteTurnContext;
	ctx: ExtensionContext;
	generationId: number;
	getGenerationId: () => number;
}): Promise<void> {
	const { turn, ctx, generationId, getGenerationId } = params;
	const config = promptSuggestLiteStore.getConfig();
	if (!ctx.hasUI || !config.enabled) return;

	if (config.fastPathContinueOnError && turn.status !== "success") {
		setSuggestion({ turn, text: "continue", source: "fast-path", ctx });
		return;
	}

	promptSuggestLiteStore.setStatus({ status: "generating" });
	clearFooterStatus(ctx);

	try {
		const prompt = renderPromptSuggestLitePrompt({
			turn,
			config,
			steeringHistory: promptSuggestLiteStore.getSteeringHistory(),
		});
		const result = await generatePromptSuggestion({ ctx, config, prompt });
		if (generationId !== getGenerationId()) return;
		const suggestion = normalizeSuggestionText(result.text, config);
		if (!suggestion) {
			promptSuggestLiteStore.clearSuggestion();
			promptSuggestLiteStore.setStatus({
				status: "idle",
				lastGeneratedAt: new Date().toISOString(),
				lastModelRef: result.modelRef,
			});
			clearFooterStatus(ctx);
			return;
		}
		promptSuggestLiteStore.setStatus({
			status: "ready",
			lastGeneratedAt: new Date().toISOString(),
			lastModelRef: result.modelRef,
		});
		setSuggestion({ turn, text: suggestion, source: "model", ctx });
	} catch (error) {
		if (generationId !== getGenerationId()) return;
		promptSuggestLiteStore.clearSuggestion();
		promptSuggestLiteStore.setStatus({
			status: "error",
			lastError: error instanceof Error ? error.message : String(error),
			lastGeneratedAt: new Date().toISOString(),
		});
		clearFooterStatus(ctx);
	}
}

export default function promptSuggestLite(pi: ExtensionAPI) {
	let config = loadPromptSuggestLiteConfig();
	let generationId = 0;
	promptSuggestLiteStore.setConfig(config);

	function reloadConfig(): PromptSuggestLiteConfig {
		config = loadPromptSuggestLiteConfig();
		promptSuggestLiteStore.setConfig(config);
		return config;
	}

	function saveAndApply(nextConfig: PromptSuggestLiteConfig): void {
		savePromptSuggestLiteConfig(nextConfig);
		config = nextConfig;
		promptSuggestLiteStore.setConfig(config);
	}

	pi.on("session_start", async (_event, ctx) => {
		reloadConfig();
		const currentGeneration = ++generationId;
		promptSuggestLiteStore.clearSuggestion();
		promptSuggestLiteStore.setStatus({ status: config.enabled ? "idle" : "disabled" });
		clearFooterStatus(ctx);

		if (!config.enabled || !ctx.hasUI) return;
		const turn = buildLatestHistoricalTurnContext({ branchEntries: branchMessageEntries(ctx), config });
		if (!turn) return;
		void generateForTurn({ turn, ctx, generationId: currentGeneration, getGenerationId: () => generationId });
	});

	pi.on("session_tree", async (_event, ctx) => {
		generationId += 1;
		promptSuggestLiteStore.clearSuggestion();
		cancelPendingGenerationStatus(ctx);
	});

	pi.on("input", async (event: InputEvent, ctx) => {
		if (event.source === "extension") return { action: "continue" as const };
		generationId += 1;
		const submitted = event.text.trim();
		const suggestion = promptSuggestLiteStore.getSuggestionDetails();
		promptSuggestLiteStore.clearSuggestion();
		if (suggestion && submitted && !submitted.startsWith("/")) {
			const result = classifySteering(suggestion.text, submitted);
			promptSuggestLiteStore.recordSteering({
				turnId: suggestion.turnId,
				suggestedPrompt: suggestion.text,
				actualUserPrompt: submitted,
				classification: result.classification,
				similarity: result.similarity,
				timestamp: new Date().toISOString(),
			});
		}
		cancelPendingGenerationStatus(ctx);
		return { action: "continue" as const };
	});

	pi.on("agent_start", async (_event, ctx) => {
		generationId += 1;
		promptSuggestLiteStore.clearSuggestion();
		cancelPendingGenerationStatus(ctx);
	});

	pi.on("agent_end", async (event, ctx) => {
		config = promptSuggestLiteStore.getConfig();
		if (!config.enabled || !ctx.hasUI) return;
		const branch = branchMessages(ctx);
		const turnId = ctx.sessionManager.getLeafId() ?? `turn-${Date.now()}`;
		const messagesFromPrompt = event.messages as AgentMessage[];
		const turn =
			buildTurnContext({
				turnId,
				messagesFromPrompt,
				branchMessages: branch,
				config,
			}) ??
			(messagesFromPrompt.length === 0 ? buildAbortedFallbackTurn({ turnId, branchMessages: branch, config }) : null);
		if (!turn) return;
		const currentGeneration = ++generationId;
		void generateForTurn({ turn, ctx, generationId: currentGeneration, getGenerationId: () => generationId });
	});

	pi.registerCommand("prompt-suggest", {
		description: "Lightweight next-prompt suggestion controls: status | on | off | reload",
		getArgumentCompletions: getPromptSuggestArgumentCompletions,
		handler: async (args, ctx) => {
			const trimmed = args.trim();
			const [command = "status"] = trimmed ? trimmed.split(/\s+/) : ["status"];
			if (command === "on") {
				saveAndApply({ ...config, enabled: true });
				ctx.ui.notify("prompt-suggest-lite enabled", "info");
				clearFooterStatus(ctx);
				return;
			}
			if (command === "off") {
				saveAndApply({ ...config, enabled: false });
				generationId += 1;
				promptSuggestLiteStore.clearSuggestion();
				ctx.ui.notify("prompt-suggest-lite disabled", "info");
				clearFooterStatus(ctx);
				return;
			}
			if (command === "reload") {
				reloadConfig();
				ctx.ui.notify("prompt-suggest-lite config reloaded", "info");
				clearFooterStatus(ctx);
				return;
			}

			if (command !== "status") {
				ctx.ui.notify(`Unknown prompt-suggest command: ${command}. Available: status, on, off, reload`, "warning");
				return;
			}

			pi.sendMessage(
				{
					customType: "prompt-suggest-lite-status",
					content: renderStatus(config),
					display: true,
				},
				{ triggerTurn: false },
			);
		},
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		generationId += 1;
		promptSuggestLiteStore.clearSuggestion();
		if (ctx.hasUI) ctx.ui.setStatus(STATUS_KEY, undefined);
	});
}
