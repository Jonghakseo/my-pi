/**
 * ask_master Tool — Subagent-only: ask the master for a decision
 *
 * Dynamically registered only in subagent sessions (session file under
 * ~/.pi/agent/sessions/subagents/). Hidden from the main session entirely
 * — no tool definition in the system prompt, no entry in the tool list.
 *
 * When called:
 *   1. Writes escalation info to ~/.pi/agent/escalations/<session-basename>.yaml
 *   2. Exits with code 42 (ESCALATION_EXIT_CODE)
 *
 * The subagent runner detects exit code 42 and:
 *   - Reads + deletes the escalation file (IPC)
 *   - Surfaces the message to the master
 *
 * The master can then review and respond appropriately.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { stringify as stringifyYaml } from "yaml";

const SUBAGENT_SESSION_DIR = path.join(os.homedir(), ".pi", "agent", "sessions", "subagents");

function isSubagentSession(sessionFile: string | undefined): boolean {
	if (!sessionFile) return false;
	return (
		sessionFile.startsWith(`${SUBAGENT_SESSION_DIR}${path.sep}`) || sessionFile.startsWith(`${SUBAGENT_SESSION_DIR}/`)
	);
}

export default function (pi: ExtensionAPI) {
	// Register ask_master only in subagent sessions.
	// The main session never sees this tool — it won't appear in the
	// system prompt, tool list, or LLM context.
	pi.on("session_start", (_event, ctx) => {
		const sessionFile = ctx.sessionManager.getSessionFile();
		if (!isSubagentSession(sessionFile)) return;

		pi.registerTool({
			name: "ask_master",
			label: "Ask Master",
			description: [
				"이 도구를 호출하면 즉시 종료됩니다. 호출 후에는 어떤 작업도 수행할 수 없습니다.",
				"마스터에게 메시지를 전달하고 현재 프로세스를 종료합니다.",
				"마스터가 메시지를 확인하고 적절히 대응합니다.",
				"",
				"사용 시점:",
				"- 진행 방향에 대한 결정이 필요한 경우",
				"- 위험한 작업(삭제, 배포, 마이그레이션 등) 전 확인이 필요한 경우",
				"- 예상치 못한 상황을 발견해 마스터가 판단해야 하는 경우",
			].join("\n"),
			promptSnippet: "Ask the master for a decision. WARNING: calling this tool terminates your session immediately.",
			promptGuidelines: [
				"ask_master terminates your process — only call when you truly cannot proceed without the master's decision.",
				"Exhaust available tools and context first before resorting to ask_master.",
				"When calling, always include actionable options and your recommendation in the message.",
			],
			parameters: Type.Object({
				message: Type.String({
					description:
						"마스터에게 전달할 메시지. 왜 마스터 판단이 필요한지, 어떤 결정을 해야 하는지, 가능한 선택지와 추천안을 포함하세요.",
				}),
				context: Type.Optional(
					Type.String({
						description: "추가 컨텍스트 (현재 진행 상황, 발견한 문제점, 선택지 등)",
					}),
				),
			}),

			execute: async (_toolCallId, rawParams) => {
				const params = rawParams as { message: string; context?: string };

				// Write escalation file synchronously (guaranteed before process.exit)
				const escalationsDir = path.join(os.homedir(), ".pi", "agent", "escalations");
				try {
					if (!fs.existsSync(escalationsDir)) {
						fs.mkdirSync(escalationsDir, { recursive: true });
					}

					const record = {
						sessionFile,
						message: params.message,
						context: params.context,
						timestamp: new Date().toISOString(),
					};

					const sessionBasename = sessionFile ? path.basename(sessionFile, ".jsonl") : `escalation-${Date.now()}`;
					const escalationFile = path.join(escalationsDir, `${sessionBasename}.yaml`);

					fs.writeFileSync(escalationFile, stringifyYaml(record), "utf-8");
				} catch (err) {
					process.stderr.write(`[ask_master] Failed to write escalation file: ${err}\n`);
				}

				// Exit immediately with code 42.
				// The parent runner detects this code and reads the escalation file.
				process.exit(42);
			},
		});
	});
}
