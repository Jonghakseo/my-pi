/**
 * Escalate Tool — Subagent-only escalation to master
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
 *   - Surfaces the escalation message to the master
 *
 * The master can then review the escalation and respond appropriately.
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
	// Register the escalate tool only in subagent sessions.
	// The main session never sees this tool — it won't appear in the
	// system prompt, tool list, or LLM context.
	//
	// Best practice (pi docs):
	//   - registerTool() inside session_start is immediately active
	//   - promptSnippet → "Available tools" section in system prompt
	//   - promptGuidelines → "Guidelines" section in system prompt
	pi.on("session_start", (_event, ctx) => {
		// ReadonlySessionManager.getSessionFile() is a public API (session-manager.d.ts:134).
		// Call it on the object directly to preserve `this` binding.
		const sessionFile = ctx.sessionManager.getSessionFile();
		if (!isSubagentSession(sessionFile)) return;

		pi.registerTool({
			name: "escalate",
			label: "Escalate",
			description: [
				"에스컬레이션: 현재 작업에서 마스터의 판단이 필요할 때 호출.",
				"마스터에게 메시지를 전달하고 현재 실행을 즉시 중단합니다.",
				"마스터가 에스컬레이션 메시지를 확인하고 적절히 대응합니다.",
				"",
				"사용 시점:",
				"- 진행 방향에 대한 결정이 필요한 경우",
				"- 위험한 작업(삭제, 배포, 마이그레이션 등) 전 확인이 필요한 경우",
				"- 예상치 못한 상황을 발견해 마스터가 판단해야 하는 경우",
			].join("\n"),
			promptSnippet: "Signal the master that you need a decision before continuing (subagent-only)",
			promptGuidelines: [
				"Use escalate only as a last resort — exhaust available tools and context first.",
				"When escalating, always provide actionable options and your recommendation in the message.",
			],
			parameters: Type.Object({
				message: Type.String({
					description:
						"마스터에게 전달할 에스컬레이션 메시지. 왜 마스터 판단이 필요한지, 어떤 결정을 해야 하는지 명확히 설명하세요.",
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

					// File named by session basename for deterministic lookup by executor
					const sessionBasename = sessionFile ? path.basename(sessionFile, ".jsonl") : `escalation-${Date.now()}`;
					const escalationFile = path.join(escalationsDir, `${sessionBasename}.yaml`);

					fs.writeFileSync(escalationFile, stringifyYaml(record), "utf-8");
				} catch (err) {
					process.stderr.write(`[escalate] Failed to write escalation file: ${err}\n`);
				}

				// Exit immediately with escalation code 42.
				// This terminates the subagent process before it can continue work.
				// The parent executor.ts detects exit code 42 and reads the escalation file.
				process.exit(42);
			},
		});
	});
}
