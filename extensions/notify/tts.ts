import { type ChildProcess, spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SAY_DEFAULT_VOICE = "Sandy";
const EDGE_DEFAULT_VOICE = "ko-KR-SunHiNeural";

const BACKEND_ENV = "PI_NOTIFY_TTS";
const EDGE_VOICE_ENV = "PI_NOTIFY_EDGE_VOICE";
const SAY_VOICE_ENV = "PI_NOTIFY_SAY_VOICE";

type Backend = "auto" | "edge" | "say" | "off";

let edgeUnavailable = false;
let active: { gen?: ChildProcess; play?: ChildProcess; tmpDir?: string } = {};

function pickBackend(): Backend {
	const raw = (process.env[BACKEND_ENV] ?? "auto").toLowerCase();
	if (raw === "edge" || raw === "say" || raw === "off") return raw;
	return "auto";
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

function speakSay(text: string, voice: string): void {
	try {
		const child = spawn("say", ["-v", voice, "--", text], { stdio: "ignore" });
		child.on("error", () => {
			// say 실행 실패는 조용히 무시 (보이스 미설치 등)
		});
		active.play = child;
	} catch {
		// spawn 자체가 실패하면 무시
	}
}

function speakEdge(text: string, voice: string): Promise<boolean> {
	if (edgeUnavailable) return Promise.resolve(false);

	let tmpDir: string;
	try {
		tmpDir = mkdtempSync(join(tmpdir(), "pi-notify-tts-"));
	} catch {
		return Promise.resolve(false);
	}
	const outFile = join(tmpDir, "out.mp3");
	active.tmpDir = tmpDir;

	return new Promise((resolve) => {
		let resolved = false;
		const finish = (ok: boolean) => {
			if (resolved) return;
			resolved = true;
			if (!ok) safeRm(tmpDir);
			resolve(ok);
		};

		const gen = spawn("edge-tts", ["--voice", voice, "--text", text, "--write-media", outFile], {
			stdio: "ignore",
		});
		active.gen = gen;

		gen.on("error", (err) => {
			if ((err as NodeJS.ErrnoException).code === "ENOENT") {
				edgeUnavailable = true;
			}
			finish(false);
		});

		gen.on("close", (code) => {
			if (code !== 0) {
				finish(false);
				return;
			}
			try {
				const play = spawn("afplay", [outFile], { stdio: "ignore" });
				active.play = play;
				play.on("error", () => finish(false));
				play.on("close", () => {
					safeRm(tmpDir);
					finish(true);
				});
			} catch {
				finish(false);
			}
		});
	});
}

export function speak(text: string): void {
	if (process.platform !== "darwin") return;
	const trimmed = text.trim();
	if (!trimmed) return;

	const backend = pickBackend();
	if (backend === "off") return;

	killActive();

	const sayVoice = process.env[SAY_VOICE_ENV]?.trim() || SAY_DEFAULT_VOICE;
	const edgeVoice = process.env[EDGE_VOICE_ENV]?.trim() || EDGE_DEFAULT_VOICE;

	if (backend === "say") {
		speakSay(trimmed, sayVoice);
		return;
	}

	void (async () => {
		const ok = await speakEdge(trimmed, edgeVoice);
		if (ok) return;
		if (backend === "edge") return; // 사용자가 edge 강제 → 폴백 안 함
		speakSay(trimmed, sayVoice);
	})();
}

export function stopSpeaking(): void {
	killActive();
}
