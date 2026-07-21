import { type Api, completeSimple, type Model } from "@earendil-works/pi-ai/compat";

const COMPACTION_SYSTEM_PROMPT = [
	"You compress large shell-command output so it fits a coding agent's context window.",
	"You are given the command that produced the output (the agent's intent) and the raw output.",
	"Goal: preserve everything the agent needs to act on, at a fraction of the size.",
	"",
	"HARD RULES — preserve verbatim, character-for-character, never paraphrase:",
	"- Every error message, exception, stack trace, and assertion/diff line.",
	"- Every failure line (FAIL, ERROR, panic, non-zero exit, unmet expectation).",
	"- Exact file:line references, identifiers, paths, counts, versions, hashes, and key values.",
	"If the output is mostly errors or failures, keep nearly all of it — do not shorten failing sections.",
	"",
	"COMPRESS aggressively only the noise:",
	"- Collapse repetitive success/progress/boilerplate lines into one short note (e.g. '142 files compiled OK').",
	"- Drop decorative separators, spinners, and duplicate warnings (note the count instead).",
	"",
	"Preserve original ordering and structure. Output plain text only.",
	"No preamble, no closing remarks, no markdown code fences.",
].join("\n");

export type CompactorModel = Model<Api>;

export type CompactorAuth =
	| { ok: true; apiKey?: string; headers?: Record<string, string>; env?: Record<string, string> }
	| { ok: false; error: string };

export interface CompactorModelRegistry {
	getApiKeyAndHeaders(model: CompactorModel): Promise<CompactorAuth>;
}

function extractText(content: Array<{ type: string; text?: string }>): string {
	return content
		.filter((part) => part.type === "text" && typeof part.text === "string")
		.map((part) => part.text)
		.join("")
		.trim();
}

/**
 * Compress a large tool output via the given (fast) model.
 * Returns the compressed text, or undefined on any failure so the caller can fall back to the original.
 */
export async function compressOutput(
	command: string,
	output: string,
	model: CompactorModel,
	registry: CompactorModelRegistry,
	timeoutMs: number,
): Promise<string | undefined> {
	const auth = await registry.getApiKeyAndHeaders(model);
	if (!auth.ok) return undefined;

	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	try {
		const message = await completeSimple(
			model,
			{
				systemPrompt: COMPACTION_SYSTEM_PROMPT,
				messages: [
					{
						role: "user",
						content: `Command that produced this output:\n${command || "(unknown)"}\n\nRaw output:\n${output}`,
						timestamp: Date.now(),
					},
				],
			},
			{
				apiKey: auth.apiKey,
				headers: auth.headers,
				env: auth.env,
				signal: controller.signal,
				reasoning: "low",
			},
		);
		if (message.stopReason === "error" || message.stopReason === "aborted") return undefined;
		const text = extractText(message.content);
		return text || undefined;
	} catch {
		return undefined;
	} finally {
		clearTimeout(timer);
	}
}
