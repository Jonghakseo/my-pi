import * as path from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

const MODEL = "openai-codex/gpt-5.3-codex-spark";
const GENERATIVE_UI_EXTENSION = path.join(
	process.env.HOME ?? "",
	".pi/agent/npm/node_modules/@ryan_nookpi/pi-extension-generative-ui/index.ts",
);
const RUN_TIMEOUT_MS = 180_000;
const MAX_SOURCE_CHARS = 60_000;

function extractTextContent(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";

	let text = "";
	for (const part of content) {
		if (!part || typeof part !== "object") continue;
		const p = part as Record<string, unknown>;
		if (p.type === "text" && typeof p.text === "string") text += p.text;
	}
	return text;
}

function getLastAssistantText(ctx: ExtensionCommandContext): string | undefined {
	const branch = ctx.sessionManager.getBranch();
	for (let i = branch.length - 1; i >= 0; i--) {
		const entry = branch[i];
		if (entry.type !== "message") continue;
		const message = entry.message;
		if (message.role !== "assistant") continue;
		const text = extractTextContent(message.content).trim();
		if (text) return text;
	}
	return undefined;
}

function buildPrompt(lastResponse: string, userHint: string): string {
	const clipped =
		lastResponse.length > MAX_SOURCE_CHARS
			? `${lastResponse.slice(0, MAX_SOURCE_CHARS)}\n\n[TRUNCATED: source response exceeded ${MAX_SOURCE_CHARS} characters]`
			: lastResponse;
	const hint = userHint.trim();

	return `You are a visual UI generator running inside a headless pi process.
Your only job is to turn the provided previous assistant response into a polished HTML/SVG widget and show it to the user.

Hard requirements:
- First call visualize_read_me with the modules that fit the content.
- Then call show_widget exactly once with i_have_seen_read_me=true.
- Use a complete, self-contained widget_code fragment (style + markup + optional script). Do not include DOCTYPE/html/head/body.
- Preserve the meaning of the source response. Do not invent new facts.
- Optimize for visual comprehension: make the information easier to understand at a glance than the original text.
- Prefer a visually useful layout over a plain document: cards, hierarchy, diagrams, tables, timelines, or interactive controls when appropriate.
- Convert abstract or sequential explanations into visual structures such as flows, comparison grids, layered cards, annotated diagrams, or step-by-step timelines.
- Emphasize key takeaways with clear grouping, contrast, spacing, labels, icons, and concise microcopy.
- Keep the final natural-language response after tool calls to one short Korean sentence.
${hint ? `- Additional user direction: ${hint}\n` : ""}

SOURCE ASSISTANT RESPONSE:
<source_response>
${clipped}
</source_response>`;
}

function summarizeFailure(result: { code: number; stdout: string; stderr: string }): string {
	const stderr = result.stderr.trim();
	const stdoutTail = result.stdout.trim().split("\n").slice(-5).join("\n").trim();
	return [
		`exit=${result.code}`,
		stderr ? `stderr: ${stderr.slice(0, 1000)}` : undefined,
		stdoutTail ? `stdout tail: ${stdoutTail.slice(0, 1000)}` : undefined,
	]
		.filter(Boolean)
		.join("\n");
}

export default function (pi: ExtensionAPI) {
	pi.registerCommand("to-html", {
		description:
			"마지막 assistant 응답을 gpt-5.3-codex-spark + generative-ui 전용 headless pi로 HTML 위젯화합니다. (사용: /to-html [추가 지시])",
		handler: async (args, ctx) => {
			await ctx.waitForIdle();

			const lastResponse = getLastAssistantText(ctx);
			if (!lastResponse) {
				ctx.ui.notify("HTML 위젯으로 만들 마지막 assistant 응답을 찾지 못했습니다.", "warning");
				return;
			}

			ctx.ui.notify("🎨 마지막 응답을 HTML 위젯으로 변환 중…", "info");

			const prompt = buildPrompt(lastResponse, args);
			const result = await pi.exec(
				"pi",
				[
					"--mode",
					"json",
					"--print",
					"--no-session",
					"--no-extensions",
					"--no-builtin-tools",
					"--extension",
					GENERATIVE_UI_EXTENSION,
					"--tools",
					"visualize_read_me,show_widget",
					"--model",
					MODEL,
					"--thinking",
					"minimal",
					"--no-context-files",
					"--no-skills",
					"--no-prompt-templates",
					prompt,
				],
				{ cwd: ctx.cwd, timeout: RUN_TIMEOUT_MS },
			);

			if (result.code !== 0) {
				ctx.ui.notify(`HTML 위젯 생성 실패\n${summarizeFailure(result)}`, "error");
				return;
			}

			ctx.ui.notify("✅ HTML 위젯 생성 요청이 완료되었습니다.", "info");
		},
	});
}
