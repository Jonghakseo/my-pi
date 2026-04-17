import { type ChildProcess, spawn } from "node:child_process";

const DEFAULT_VOICE = "Yuna";
const VOICE_ENV = "PI_NOTIFY_VOICE";

let current: ChildProcess | undefined;

function pickVoice(): string {
	const envVoice = process.env[VOICE_ENV]?.trim();
	return envVoice || DEFAULT_VOICE;
}

export function speak(text: string): void {
	if (process.platform !== "darwin") return;
	const trimmed = text.trim();
	if (!trimmed) return;

	if (current && current.exitCode === null) {
		current.kill("SIGTERM");
	}

	try {
		const child = spawn("say", ["-v", pickVoice(), "--", trimmed], {
			stdio: "ignore",
			detached: false,
		});
		child.on("error", () => {
			// say 실행 실패는 조용히 무시 (보이스 미설치 등)
		});
		current = child;
	} catch {
		// spawn 자체가 실패하면 무시
	}
}

export function stopSpeaking(): void {
	if (current && current.exitCode === null) {
		current.kill("SIGTERM");
	}
	current = undefined;
}
