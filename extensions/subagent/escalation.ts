import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

const SUBAGENT_SESSION_DIR = path.join(os.homedir(), ".pi", "agent", "sessions", "subagents");
const ESCALATIONS_DIR = path.join(os.homedir(), ".pi", "agent", "escalations");

function isSubagentSession(sessionFile: string | undefined): boolean {
	if (!sessionFile) return false;
	return (
		sessionFile.startsWith(`${SUBAGENT_SESSION_DIR}${path.sep}`) || sessionFile.startsWith(`${SUBAGENT_SESSION_DIR}/`)
	);
}

export function writeEscalationRecord(sessionFile: string, message: string, context?: string): void {
	if (!fs.existsSync(ESCALATIONS_DIR)) {
		fs.mkdirSync(ESCALATIONS_DIR, { recursive: true });
	}

	const record = {
		sessionFile,
		message,
		context,
		timestamp: new Date().toISOString(),
	};

	const sessionBasename = path.basename(sessionFile, ".jsonl");
	const escalationFile = path.join(ESCALATIONS_DIR, `${sessionBasename}.yaml`);
	fs.writeFileSync(escalationFile, stringifyYaml(record), "utf-8");
}

/**
 * ask_master Tool — registered only when the current session is a subagent session.
 *
 * When called:
 *   1. Writes escalation info to ~/.pi/agent/escalations/<session-basename>.yaml
 *   2. Exits with code 42 (ESCALATION_EXIT_CODE)
 *
 * The subagent runner detects exit code 42 and:
 *   - Reads + deletes the escalation file (IPC)
 *   - Surfaces the message to the master
 */
export function registerAskMasterTool(pi: ExtensionAPI): void {
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
				const activeSessionFile = sessionFile;
				if (!activeSessionFile) {
					return {
						content: [
							{
								type: "text" as const,
								text: "[ask_master] Error: Missing subagent session file. Escalation not written.",
							},
						],
						details: { message: params.message, context: params.context, error: true },
						terminate: true,
					};
				}

				try {
					writeEscalationRecord(activeSessionFile, params.message, params.context);
				} catch (err) {
					process.stderr.write(`[ask_master] Failed to write escalation file: ${err}\n`);
				}

				return {
					content: [{ type: "text" as const, text: `Escalated to master: ${params.message}` }],
					details: { message: params.message, context: params.context, error: false },
					terminate: true,
				};
			},
		});
	});
}

/**
 * Exit code used by the 'escalate' tool to signal that the
 * subagent wants to escalate to the master.
 */
export const ESCALATION_EXIT_CODE = 42;

export interface EscalationRecord {
	sessionFile: string;
	message: string;
	context?: string;
	timestamp: string;
}

/**
 * Derive the escalation IPC file path from a subagent session file.
 */
export function getEscalationFilePath(sessionFile: string): string {
	const basename = path.basename(sessionFile, ".jsonl");
	return path.join(ESCALATIONS_DIR, `${basename}.yaml`);
}

/**
 * Read the escalation IPC file and delete it immediately (consume-once pattern).
 * Returns null if the file does not exist or cannot be parsed.
 */
export function readAndConsumeEscalation(sessionFile: string): EscalationRecord | null {
	try {
		const filePath = getEscalationFilePath(sessionFile);
		if (!fs.existsSync(filePath)) return null;
		const content = fs.readFileSync(filePath, "utf-8");
		const record = parseYaml(content) as EscalationRecord;
		try {
			fs.unlinkSync(filePath);
		} catch {
			/* ignore deletion errors */
		}
		return record;
	} catch {
		return null;
	}
}
