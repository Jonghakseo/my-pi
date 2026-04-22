/**
 * model-client — calls the supervisor LLM using pi's internal agent session API.
 *
 * callModel        — low-level: returns raw response text
 * callSupervisorModel — high-level: parses response as SteeringDecision
 */

import {
	createAgentSession,
	DefaultResourceLoader,
	getAgentDir,
	SessionManager,
	SettingsManager,
} from "@mariozechner/pi-coding-agent";
import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { SteeringDecision } from "./types.js";

type ResourceLoaderOptions = ConstructorParameters<typeof DefaultResourceLoader>[0];
type AgentSessionOptions = Parameters<typeof createAgentSession>[0];

function requirePath(value: string | undefined, label: string): string {
	if (typeof value !== "string" || value.trim().length === 0) {
		throw new Error(`Supervisor analysis requires ${label} to be a non-empty path string.`);
	}
	return value;
}

function createAnalysisRuntime(ctx: ExtensionContext, systemPrompt: string) {
	const cwd = requirePath(ctx.cwd, "ctx.cwd");
	const agentDir = requirePath(getAgentDir(), "agentDir");
	const settingsManager = SettingsManager.create(cwd, agentDir);

	// Keep all cwd/agentDir plumbing in one place so future pi SDK changes
	// cannot leave one callsite half-configured.
	const loaderOptions: ResourceLoaderOptions = {
		cwd,
		agentDir,
		settingsManager,
		noExtensions: true,
		noSkills: true,
		noPromptTemplates: true,
		noThemes: true,
		systemPromptOverride: () => systemPrompt,
	};

	const sessionOptions: AgentSessionOptions = {
		cwd,
		sessionManager: SessionManager.inMemory(cwd),
		settingsManager,
		tools: [],
	};

	return {
		cwd,
		agentDir,
		settingsManager,
		loader: new DefaultResourceLoader(loaderOptions),
		sessionOptions,
	};
}

/**
 * Run a one-shot LLM call using pi's internal agent session.
 * Returns the raw response text, or null on failure.
 */
export async function callModel(
	ctx: ExtensionContext,
	provider: string,
	modelId: string,
	systemPrompt: string,
	userPrompt: string,
	signal?: AbortSignal,
	onDelta?: (accumulated: string) => void,
): Promise<string | null> {
	const model = ctx.modelRegistry.find(provider, modelId);
	if (!model) return null;

	// pi >= 0.68 requires cwd/agentDir-aware resource loading + session setup.
	// Omitting these can bubble up as node:path errors like
	// "The \"path\" argument must be of type string. Received undefined".
	const runtime = createAnalysisRuntime(ctx, systemPrompt);
	const loader = runtime.loader;
	await loader.reload();

	let session: Awaited<ReturnType<typeof createAgentSession>>["session"];
	try {
		const result = await createAgentSession({
			...runtime.sessionOptions,
			modelRegistry: ctx.modelRegistry,
			model,
			resourceLoader: loader,
		});
		session = result.session;
	} catch {
		return null;
	}

	const onAbort = () => session.abort();
	signal?.addEventListener("abort", onAbort, { once: true });

	let responseText = "";
	const unsubscribe = session.subscribe((event) => {
		if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
			responseText += event.assistantMessageEvent.delta;
			onDelta?.(responseText);
		}
	});

	try {
		await session.prompt(userPrompt);
	} catch {
		return null;
	} finally {
		unsubscribe();
		signal?.removeEventListener("abort", onAbort);
		session.dispose();
	}

	return responseText;
}

/**
 * Run a one-shot supervisor analysis.
 * Returns { action: "continue" } on any failure so the chat is never interrupted.
 */
export async function callSupervisorModel(
	ctx: ExtensionContext,
	provider: string,
	modelId: string,
	systemPrompt: string,
	userPrompt: string,
	signal?: AbortSignal,
	onDelta?: (accumulated: string) => void,
): Promise<SteeringDecision> {
	const text = await callModel(ctx, provider, modelId, systemPrompt, userPrompt, signal, onDelta);
	if (text === null) return safeContinue("Model call failed");
	return parseDecision(text);
}

// ---- Response parsing ----

function parseDecision(text: string): SteeringDecision {
	const jsonMatch = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/) ?? text.match(/(\{[\s\S]*\})/);
	const jsonStr = jsonMatch?.[1] ?? text.trim();

	try {
		const parsed = JSON.parse(jsonStr) as Partial<SteeringDecision>;
		const action = parsed.action;
		if (action !== "continue" && action !== "steer" && action !== "done") {
			return safeContinue("Invalid action in supervisor response");
		}
		return {
			action,
			message: typeof parsed.message === "string" ? parsed.message.trim() : undefined,
			reasoning: typeof parsed.reasoning === "string" ? parsed.reasoning : "",
			confidence: typeof parsed.confidence === "number" ? parsed.confidence : 0.5,
		};
	} catch {
		return safeContinue("Failed to parse supervisor JSON decision");
	}
}

function safeContinue(reason: string): SteeringDecision {
	return { action: "continue", reasoning: reason, confidence: 0 };
}
