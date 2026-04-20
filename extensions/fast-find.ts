import { Type } from "@sinclair/typebox";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/**
 * fast-find extension
 *
 * Uses gpt-5.3-codex-spark subagent to find files or code based on target and purpose.
 * The subagent is guided to return JSON, but the tool returns the raw string output.
 */
export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "fast-find",
		label: "Fast Find",
		description:
			"Use when the user asks to find, search, or look into something and the exact file path is unknown. Prefer this whenever possible because it is extremely fast and token-efficient: a dedicated gpt-5.3-codex-spark subagent searches the codebase and returns up to 10 candidate files with path, relatedLines, human-readable size, and rationale. Best for requests like 기능 위치 찾아봐, 관련 파일 찾아봐, 어디를 수정해야 할지 찾아봐.",
		parameters: Type.Object({
			target: Type.Optional(Type.String({ description: "Target file or code to find. Keep this short." })),
			purpose: Type.String({ description: "Purpose of the search. Keep this short." }),
		}),
		renderCall(args, theme) {
			const { target, purpose } = args as { target?: string; purpose?: string };
			const lines = [
				theme.fg("toolTitle", theme.bold("fast-find ")) + theme.fg("accent", target?.trim() || "(no target)"),
			];
			if (purpose?.trim()) {
				const displayPurpose = purpose.length > 220 ? `${purpose.slice(0, 217)}...` : purpose;
				lines.push(theme.fg("dim", "  purpose: ") + theme.fg("muted", displayPurpose));
			}
			return new Text(lines.join("\n"), 0, 0);
		},
		execute: async (toolCallId, params, signal, _onUpdate, _ctx) => {
			const { target, purpose } = params;
			const model = "openai-codex/gpt-5.3-codex-spark";

			const prompt = `
			[FAST-FIND GUIDELINE]
			Target: ${target ?? "Not specified"}
			Purpose: ${purpose}
			
			Input guidance:
			- Keep both target and purpose short and compact.
			- Do not echo long explanations of the request.
			
			Tasks:
			1. Search for files or code snippets in the current directory that match the target and purpose.
			2. Use only the available read-only tools to locate them efficiently.
			3. Return up to 10 strong candidate files.
			4. For each match, provide only the following fields:
			   - path: relative file path
			   - relatedLines: related line ranges as a string, such as "#1~#10", "#13,#172", or "all"
			   - description: brief reason it matches
			   - size: human-readable size string like "812 B", "3.4 KB", or "1.2 MB"
			
			[OUTPUT FORMAT]
			Return YAML, not JSON.
			YAML structure example:
			- path: src/main.ts
			  relatedLines: "#13,#172"
			  description: main entry point related to the request
			  size: 3.4 KB
			Do not include similarity.
			Do not include content snippets.
			Limit to at most 10 results.
			`;

			const promptDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fast-find-"));
			const promptFilePath = path.join(promptDir, `prompt-${toolCallId}.txt`);
			fs.writeFileSync(promptFilePath, prompt, "utf-8");

			try {
				// Execute pi in non-interactive mode with minimal read-only surface
				const result = await pi.exec(
					"pi",
					[
						"--model",
						model,
						"--no-session",
						"--no-extensions",
						"--no-skills",
						"--no-prompt-templates",
						"--no-themes",
						"--no-context-files",
						"--tools",
						"read,grep,find,ls",
						"-p",
						`@${promptFilePath}`,
					],
					{ signal },
				);

				if (result.code !== 0) {
					return {
						content: [{ type: "text", text: `Subagent failed with code ${result.code}.\n\n${result.stderr}` }],
						details: { error: result.stderr, code: result.code },
					};
				}

				// Return the raw stdout string as requested
				const output = result.stdout.trim();
				return {
					content: [{ type: "text", text: output }],
					details: { rawOutput: output },
				};
			} catch (e) {
				return {
					content: [{ type: "text", text: `Execution failed: ${String(e)}` }],
					details: { error: String(e) },
				};
			} finally {
				// Clean up prompt file and temp directory
				try {
					fs.rmSync(promptDir, { recursive: true, force: true });
				} catch {
					/* ignore */
				}
			}
		},
	});
}
