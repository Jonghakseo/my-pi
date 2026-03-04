/**
 * Escalate Tool — Subagent escalation to master
 *
 * Allows a subagent to signal that it needs master judgment before continuing.
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

export default function (pi: ExtensionAPI) {
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

		execute: async (_toolCallId, rawParams, _signal, _onUpdate, ctx) => {
			const params = rawParams as { message: string; context?: string };

			// Subagent session directory — must match session.ts:SUBAGENT_SESSION_DIR
			const subagentSessionDir = path.join(os.homedir(), ".pi", "agent", "sessions", "subagents");

			// Derive session file path for IPC correlation
			let sessionFile: string | undefined;
			try {
				// Type guard: sessionManager has getSessionFile method
				const sessionManager = ctx.sessionManager;
				if (sessionManager && typeof sessionManager === "object" && "getSessionFile" in sessionManager) {
					const getSessionFile = (sessionManager as Record<string, unknown>).getSessionFile;
					if (typeof getSessionFile === "function") {
						const raw = String(getSessionFile() ?? "");
						sessionFile = raw.replace(/[\r\n\t]+/g, "").trim() || undefined;
					}
				}
			} catch {
				/* ignore — will use timestamp fallback */
			}

			// Guard: escalate must only be called from a subagent session.
			// If the current session file is NOT inside the subagent sessions directory,
			// this tool was invoked from the main session — do NOT exit the process.
			const isSubagentSession = sessionFile
				? sessionFile.startsWith(subagentSessionDir + path.sep) || sessionFile.startsWith(subagentSessionDir + "/")
				: false;

			if (!isSubagentSession) {
				return {
					content: [
						{
							type: "text" as const,
							text: "escalate 도구는 서브에이전트 세션에서만 사용할 수 있습니다. 메인 세션에서는 호출할 수 없습니다.",
						},
					],
					details: undefined,
				};
			}

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
				// Log to stderr — won't surface to user since process is about to exit
				process.stderr.write(`[escalate] Failed to write escalation file: ${err}\n`);
			}

			// Exit immediately with escalation code 42.
			// This terminates the subagent process before it can continue work.
			// The parent executor.ts detects exit code 42 and reads the escalation file.
			process.exit(42);
		},
	});
}
