import { Type } from "@sinclair/typebox";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
// biome-ignore lint/complexity/useRegexLiterals: RegExp constructor avoids noControlCharactersInRegex false positive for ANSI pattern.
const ANSI_ESCAPE_REGEX = new RegExp("\\x1B\\[[0-?]*[ -/]*[@-~]", "g");
const PREVIEW_LIMIT = 96;

function getPreviewLine(text: string): string | null {
	const lines = text
		.replace(ANSI_ESCAPE_REGEX, "")
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter(Boolean);
	const lastLine = lines.at(-1);
	if (!lastLine) return null;
	return lastLine.length > PREVIEW_LIMIT ? `${lastLine.slice(0, PREVIEW_LIMIT - 3)}...` : lastLine;
}

/**
 * fast-find extension
 *
 * Uses gpt-5.3-codex-spark subagent to find files or code based on target and purpose.
 * The subagent may format the result however it thinks is most useful, and the tool returns the raw string output.
 */
export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "fast-find",
		label: "Fast Find",
		description:
			"Use when the user asks to find, search, or look into something and the exact file path is unknown. Prefer this whenever possible because it is extremely fast and token-efficient: a dedicated gpt-5.3-codex-spark subagent searches the codebase and returns concise, high-signal candidate results in whatever format best fits the query. Best for requests like 기능 위치 찾아봐, 관련 파일 찾아봐, 어디를 수정해야 할지 찾아봐.",
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
		renderResult(result, { expanded, isPartial }, theme) {
			const details = result.details as {
				phase?: string;
				spinnerFrame?: string;
				tailLine?: string;
				error?: string;
				durationMs?: number;
			};
			const textContent = result.content.find((item) => item.type === "text")?.text ?? "";

			if (isPartial) {
				const statusLine = `${details?.spinnerFrame ?? "…"} ${details?.phase ?? "Searching..."}`;
				if (details?.tailLine) {
					return new Text(`${theme.fg("accent", statusLine)}\n${theme.fg("dim", details.tailLine)}`, 0, 0);
				}
				return new Text(theme.fg("accent", statusLine), 0, 0);
			}

			if (details?.error) {
				return new Text(theme.fg("error", `Error: ${details.error}`), 0, 0);
			}

			if (expanded || !textContent) {
				return new Text(textContent || "(no output)", 0, 0);
			}

			const firstLine =
				textContent
					.split(/\r?\n/)
					.map((line) => line.trim())
					.find(Boolean) ?? "(no output)";
			const preview = firstLine.length > 180 ? `${firstLine.slice(0, 177)}...` : firstLine;
			const seconds = typeof details?.durationMs === "number" ? ` (${(details.durationMs / 1000).toFixed(1)}s)` : "";
			return new Text(`${theme.fg("success", `fast-find complete${seconds}`)}\n${theme.fg("dim", preview)}`, 0, 0);
		},
		execute: async (toolCallId, params, signal, onUpdate, _ctx) => {
			const { target, purpose } = params;
			const model = "openai-codex/gpt-5.3-codex-spark";
			const startedAt = Date.now();
			let spinnerIndex = 0;
			let phase = "Preparing search prompt...";
			let tailLine = "";

			const emitUpdate = () => {
				const spinnerFrame = SPINNER_FRAMES[spinnerIndex % SPINNER_FRAMES.length];
				spinnerIndex += 1;
				onUpdate?.({
					content: [
						{ type: "text", text: tailLine ? `${spinnerFrame} ${phase}\n${tailLine}` : `${spinnerFrame} ${phase}` },
					],
					details: {
						phase,
						spinnerFrame,
						tailLine,
						durationMs: Date.now() - startedAt,
					},
				});
			};

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
			3. Return the most useful findings in whatever format best fits the request.
			4. Prefer concise, high-signal output. Include file paths and relevant context when helpful.
			5. If there are many matches, focus on the strongest candidates instead of being exhaustive.
			6. Do not include unnecessary boilerplate or restate the prompt.
			7. You may use bullets, plain text, YAML, or a small table if useful, but no format is required.
			`;

			phase = "Preparing fast-find prompt...";
			emitUpdate();

			const promptDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fast-find-"));
			const promptFilePath = path.join(promptDir, `prompt-${toolCallId}.txt`);
			fs.writeFileSync(promptFilePath, prompt, "utf-8");

			let spinnerTimer: NodeJS.Timeout | undefined;
			try {
				phase = "Launching search subagent...";
				emitUpdate();

				const args = [
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
				];

				const child = spawn("pi", args, { signal });
				let stdout = "";
				let stderr = "";

				spinnerTimer = setInterval(() => {
					phase = "Searching codebase...";
					emitUpdate();
				}, 700);
				spinnerTimer.unref();

				child.stdout?.on("data", (chunk) => {
					const text = String(chunk);
					stdout += text;
					tailLine = getPreviewLine(text) ?? tailLine;
				});

				child.stderr?.on("data", (chunk) => {
					const text = String(chunk);
					stderr += text;
					tailLine = getPreviewLine(text) ?? tailLine;
				});

				const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
					child.once("error", reject);
					child.once("close", (code, closeSignal) => resolve({ code, signal: closeSignal }));
				});

				if (spinnerTimer) clearInterval(spinnerTimer);

				if (result.code !== 0) {
					const errorText = result.signal
						? `Subagent terminated by signal ${result.signal}.\n\n${stderr}`
						: `Subagent failed with code ${result.code}.\n\n${stderr}`;
					return {
						content: [{ type: "text", text: errorText }],
						details: {
							error: stderr || errorText,
							code: result.code,
							signal: result.signal,
							durationMs: Date.now() - startedAt,
						},
					};
				}

				const output = stdout.trim();
				return {
					content: [{ type: "text", text: output }],
					details: {
						rawOutput: output,
						durationMs: Date.now() - startedAt,
					},
				};
			} catch (e) {
				if (spinnerTimer) clearInterval(spinnerTimer);
				return {
					content: [{ type: "text", text: `Execution failed: ${String(e)}` }],
					details: { error: String(e), durationMs: Date.now() - startedAt },
				};
			} finally {
				if (spinnerTimer) clearInterval(spinnerTimer);
				try {
					fs.rmSync(promptDir, { recursive: true, force: true });
				} catch {
					/* ignore */
				}
			}
		},
	});
}
