import { Type } from "@sinclair/typebox";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import * as fs from "node:fs";
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
		description: "Find files or code using gpt-5.3-codex-spark subagent. Returns the search results and explanations.",
		parameters: Type.Object({
			target: Type.Optional(Type.String({ description: "Target file or code to find" })),
			purpose: Type.String({ description: "Purpose of the search" }),
		}),
		execute: async (toolCallId, params, signal, _onUpdate, ctx) => {
			const { target, purpose } = params;
			const model = "gpt-5.3-codex-spark";

			const prompt = `
[FAST-FIND GUIDELINE]
Target: ${target ?? "Not specified"}
Purpose: ${purpose}

Tasks:
1. Search for files or code snippets in the current directory that match the target and purpose.
2. Use any available tools (ls, find, grep, read) to locate them.
3. For each match, provide the following information:
   - path: The relative file path.
   - line: The starting line number of the match.
   - description: A brief explanation of why it matches.
   - similarity: A score between 0 and 1.
   - size: File size in bytes.
   - content: A short code snippet from that line.

[OUTPUT FORMAT]
Please provide the results in a clear, structured format. 
While a JSON array of objects is preferred for clarity, you may include brief reasoning for each finding.
JSON structure reference: { "path": string, "line": number, "description": string, "similarity": number, "size": number, "content": string }[]
Limit to at most 10 results.
`;

			const promptFilePath = path.join(ctx.cwd, `.fast_find_prompt_${toolCallId}.txt`);
			fs.writeFileSync(promptFilePath, prompt, "utf-8");

			try {
				// Execute pi in non-interactive mode (-p) without saving session (--no-session)
				const result = await pi.exec("pi", ["--model", model, "--no-session", "-p", `@${promptFilePath}`], { signal });

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
				// Clean up prompt file
				if (fs.existsSync(promptFilePath)) {
					try {
						fs.unlinkSync(promptFilePath);
					} catch {
						/* ignore */
					}
				}
			}
		},
	});
}
