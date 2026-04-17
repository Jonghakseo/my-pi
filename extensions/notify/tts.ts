import { type ChildProcess, spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const DEFAULT_VOICE = "ko-KR-SunHiNeural";

const ENABLED_ENV = "PI_NOTIFY_TTS";
const VOICE_ENV = "PI_NOTIFY_EDGE_VOICE";

let active: { gen?: ChildProcess; play?: ChildProcess; tmpDir?: string } = {};

function ttsEnabled(): boolean {
	return (process.env[ENABLED_ENV] ?? "").toLowerCase() !== "off";
}

function safeRm(dir: string | undefined): void {
	if (!dir) return;
	try {
		rmSync(dir, { recursive: true, force: true });
	} catch {
		// 정리 실패는 무시 — OS가 tmpdir를 결국 회수함
	}
}

function killActive(): void {
	if (active.gen && active.gen.exitCode === null) active.gen.kill("SIGTERM");
	if (active.play && active.play.exitCode === null) active.play.kill("SIGTERM");
	safeRm(active.tmpDir);
	active = {};
}

export function speak(text: string): void {
	if (process.platform !== "darwin") return;
	if (!ttsEnabled()) return;
	const trimmed = text.trim();
	if (!trimmed) return;

	killActive();

	let tmpDir: string;
	try {
		tmpDir = mkdtempSync(join(tmpdir(), "pi-notify-tts-"));
	} catch {
		return;
	}
	const outFile = join(tmpDir, "out.mp3");
	active.tmpDir = tmpDir;

	const voice = process.env[VOICE_ENV]?.trim() || DEFAULT_VOICE;

	const gen = spawn("edge-tts", ["--voice", voice, "--text", trimmed, "--write-media", outFile], {
		stdio: "ignore",
	});
	active.gen = gen;

	gen.on("error", () => {
		safeRm(tmpDir);
	});

	gen.on("close", (code) => {
		if (code !== 0) {
			safeRm(tmpDir);
			return;
		}
		try {
			const play = spawn("afplay", [outFile], { stdio: "ignore" });
			active.play = play;
			play.on("error", () => safeRm(tmpDir));
			play.on("close", () => safeRm(tmpDir));
		} catch {
			safeRm(tmpDir);
		}
	});
}

export function stopSpeaking(): void {
	killActive();
}
