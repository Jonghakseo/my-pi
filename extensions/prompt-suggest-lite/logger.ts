import { mkdir, appendFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { PromptSuggestLiteSteeringEvent } from "./shared.ts";

const extensionDir = dirname(fileURLToPath(import.meta.url));
export const steeringLogPath = join(extensionDir, ".data", "steering.jsonl");

let mkdirPromise: Promise<void> | undefined;

async function ensureLogDir(): Promise<void> {
	if (!mkdirPromise) {
		mkdirPromise = mkdir(dirname(steeringLogPath), { recursive: true }).then(() => undefined);
	}
	await mkdirPromise;
}

export async function appendSteeringEventToLog(event: PromptSuggestLiteSteeringEvent): Promise<void> {
	try {
		await ensureLogDir();
		await appendFile(steeringLogPath, `${JSON.stringify(event)}\n`, "utf8");
	} catch {
		// Logging must never break the extension.
	}
}
