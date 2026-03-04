import * as fs from "fs";
import * as path from "path";
import { parse as parseYaml } from "yaml";

/**
 * Exit code used by the 'escalate' tool to signal that the
 * subagent wants to escalate to the master.
 */
export const ESCALATION_EXIT_CODE = 42;

const ESCALATIONS_DIR = path.join(process.env.HOME ?? process.env.USERPROFILE ?? "/tmp", ".pi", "agent", "escalations");

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
