import type { ChildProcess } from "node:child_process";
import { spawn } from "node:child_process";
import { existsSync, promises as fs } from "node:fs";
import * as os from "node:os";
import { basename, join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";

const VOICE_SHORTCUT = "alt+v";
const VOICE_STATUS_KEY = "voice-input";

const DEFAULT_RECORDER_BINS = ["sox", "rec"];
const DEFAULT_WHISPER_BINS = ["whisper-cli", "whisper-cpp"];
const DEFAULT_TTS_BINS = ["say"];
const MAX_CAPTURE_CHARS = 8_000;
const DEFAULT_TTS_SUMMARY_MAX_CHARS = 120;

const RECORDING_STATUS = "🎙️ REC · Option+V 로 종료";
const TRANSCRIBING_STATUS = "🧠 Whisper 변환 중...";
const SPEAKING_STATUS = "🔊 응답 요약 음성 출력 중...";

type LogLevel = "info" | "warning" | "error";

type SpawnCheckResult =
	| { ok: true }
	| {
			ok: false;
			error: string;
	  };

type ProcessResult = {
	code: number;
	signal: NodeJS.Signals | null;
	stdout: string;
	stderr: string;
	errorMessage?: string;
};

type TranscriptionResult = {
	text: string;
	bin: string;
	modelPath: string;
};

function normalizeOptional(value: string | undefined): string | null {
	const trimmed = value?.trim();
	return trimmed ? trimmed : null;
}

function parseCandidateList(raw: string | undefined, fallback: string[]): string[] {
	const fromEnv = (raw ?? "")
		.split(",")
		.map((value) => value.trim())
		.filter((value) => value.length > 0);
	const values = fromEnv.length > 0 ? fromEnv : fallback;
	return Array.from(new Set(values));
}

function appendLimited(base: string, addition: string, limit: number): string {
	const merged = base + addition;
	if (merged.length <= limit) return merged;
	return merged.slice(merged.length - limit);
}

function tailText(text: string, maxChars: number): string {
	if (text.length <= maxChars) return text;
	return `...${text.slice(text.length - maxChars)}`;
}

function parseBooleanEnv(value: string | undefined, fallback: boolean): boolean {
	const normalized = normalizeOptional(value)?.toLowerCase();
	if (!normalized) return fallback;
	if (["1", "true", "yes", "y", "on"].includes(normalized)) return true;
	if (["0", "false", "no", "n", "off"].includes(normalized)) return false;
	return fallback;
}

function parseBoundedIntEnv(value: string | undefined, fallback: number, min: number, max: number): number {
	const normalized = normalizeOptional(value);
	if (!normalized) return fallback;
	const parsed = Number.parseInt(normalized, 10);
	if (!Number.isFinite(parsed)) return fallback;
	return Math.max(min, Math.min(max, parsed));
}

function ttsVoice(): string | null {
	return normalizeOptional(process.env.PI_VOICE_TTS_VOICE);
}

function ttsRate(): string | null {
	return normalizeOptional(process.env.PI_VOICE_TTS_RATE);
}

function ttsSummaryMaxChars(): number {
	return parseBoundedIntEnv(process.env.PI_VOICE_TTS_MAX_CHARS, DEFAULT_TTS_SUMMARY_MAX_CHARS, 40, 260);
}

function stripMarkdownForSpeech(text: string): string {
	return text
		.replace(/```[\s\S]*?```/g, " ")
		.replace(/`([^`]+)`/g, "$1")
		.replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
		.replace(/^\s{0,3}#{1,6}\s+/gm, "")
		.replace(/^\s*[-*+]\s+/gm, "")
		.replace(/^\s*\d+\.\s+/gm, "")
		.replace(/\s+/g, " ")
		.trim();
}

function summarizeForSpeech(text: string, maxChars: number): string {
	const normalized = stripMarkdownForSpeech(normalizeTranscript(text));
	if (!normalized) return "";

	const sentences =
		normalized
			.match(/[^.!?。！？]+[.!?。！？]?/gu)
			?.map((sentence) => sentence.trim())
			.filter(Boolean) ?? [];

	let summary = sentences[0] ?? normalized;
	if (summary.length < 18 && sentences.length > 1) {
		summary = `${summary} ${sentences[1]}`.trim();
	}

	if (summary.length > maxChars) {
		summary = `${summary.slice(0, maxChars - 1).trimEnd()}…`;
	}

	return summary;
}

function extractLatestAssistantText(messages: unknown[]): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i];
		if (!message || typeof message !== "object") continue;
		if ((message as { role?: unknown }).role !== "assistant") continue;

		const content = (message as { content?: unknown }).content;
		if (!Array.isArray(content)) continue;

		const textParts: string[] = [];
		for (const part of content) {
			if (!part || typeof part !== "object") continue;
			if ((part as { type?: unknown }).type !== "text") continue;
			const text = (part as { text?: unknown }).text;
			if (typeof text === "string" && text.trim()) {
				textParts.push(text.trim());
			}
		}

		const merged = normalizeTranscript(textParts.join(" "));
		if (merged) return merged;
	}

	return "";
}

function whisperLanguage(): string {
	return normalizeOptional(process.env.PI_VOICE_WHISPER_LANG) ?? "ko";
}

function ttsBins(): string[] {
	return parseCandidateList(process.env.PI_VOICE_TTS_BIN, DEFAULT_TTS_BINS);
}

function whisperModelCandidates(): string[] {
	const configured = normalizeOptional(process.env.PI_VOICE_WHISPER_MODEL);

	const candidates = [
		configured,
		join(os.homedir(), ".cache", "whisper", "ggml-large-v3-turbo.bin"),
		join(os.homedir(), ".cache", "whisper", "ggml-large-v3.bin"),
		join(os.homedir(), ".cache", "whisper", "models", "ggml-large-v3-turbo.bin"),
		join(os.homedir(), ".cache", "whisper", "models", "ggml-large-v3.bin"),
		join(process.cwd(), "models", "ggml-large-v3-turbo.bin"),
		join(process.cwd(), "models", "ggml-large-v3.bin"),
	].filter((value): value is string => Boolean(value));

	return Array.from(new Set(candidates));
}

function resolveWhisperModelPath(): string | null {
	for (const candidate of whisperModelCandidates()) {
		if (existsSync(candidate)) return candidate;
	}
	return null;
}

function buildTempWavPath(): string {
	return join(os.tmpdir(), `pi-voice-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.wav`);
}

function buildRecorderArgs(bin: string, wavPath: string): string[] {
	const lower = bin.toLowerCase();
	if (lower.includes("rec")) {
		return ["-q", "-r", "16000", "-c", "1", "-b", "16", wavPath];
	}

	return ["-q", "-d", "-r", "16000", "-c", "1", "-b", "16", wavPath];
}

function normalizeTranscript(text: string): string {
	return text.replace(/\s+/g, " ").trim();
}

function extractTranscriptFromStdout(stdout: string): string {
	const lines = stdout
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter(Boolean);

	const timestamped = lines
		.map((line) => {
			const match = line.match(/^\[[^\]]+\]\s*(.+)$/);
			return match?.[1]?.trim() ?? "";
		})
		.filter(Boolean);

	if (timestamped.length > 0) {
		return normalizeTranscript(timestamped.join(" "));
	}

	const filtered = lines.filter((line) => {
		if (/^(whisper_|system_info:|main:|ggml_|metal_|encode:|decode:|sampling:)/i.test(line)) return false;
		if (/^(\d+\.?\d*%|progress =)/i.test(line)) return false;
		return true;
	});

	return normalizeTranscript(filtered.join(" "));
}

async function safeUnlink(path: string | null): Promise<void> {
	if (!path) return;
	try {
		await fs.unlink(path);
	} catch {
		// Ignore missing tmp files.
	}
}

async function fileSize(path: string): Promise<number> {
	try {
		const stat = await fs.stat(path);
		return stat.size;
	} catch {
		return 0;
	}
}

function waitForSpawn(proc: ChildProcess): Promise<SpawnCheckResult> {
	return new Promise((resolve) => {
		let settled = false;

		const finish = (result: SpawnCheckResult) => {
			if (settled) return;
			settled = true;
			proc.off("spawn", onSpawn);
			proc.off("error", onError);
			resolve(result);
		};

		const onSpawn = () => finish({ ok: true });
		const onError = (error: Error) => finish({ ok: false, error: error.message });

		proc.once("spawn", onSpawn);
		proc.once("error", onError);
	});
}

function runCommand(command: string, args: string[]): Promise<ProcessResult> {
	return new Promise((resolve) => {
		const proc = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });

		let stdout = "";
		let stderr = "";
		let settled = false;

		const finish = (result: ProcessResult) => {
			if (settled) return;
			settled = true;
			resolve(result);
		};

		proc.stdout?.on("data", (chunk: Buffer | string) => {
			stdout = appendLimited(stdout, chunk.toString(), MAX_CAPTURE_CHARS);
		});

		proc.stderr?.on("data", (chunk: Buffer | string) => {
			stderr = appendLimited(stderr, chunk.toString(), MAX_CAPTURE_CHARS);
		});

		proc.on("error", (error) => {
			finish({
				code: 127,
				signal: null,
				stdout,
				stderr,
				errorMessage: error.message,
			});
		});

		proc.on("close", (code, signal) => {
			finish({
				code: typeof code === "number" ? code : 1,
				signal,
				stdout,
				stderr,
			});
		});
	});
}

async function stopProcessGracefully(proc: ChildProcess): Promise<void> {
	await new Promise<void>((resolve) => {
		let done = false;

		const finish = () => {
			if (done) return;
			done = true;
			clearTimeout(termTimer);
			clearTimeout(killTimer);
			resolve();
		};

		const termTimer = setTimeout(() => {
			if (done) return;
			try {
				proc.kill("SIGTERM");
			} catch {
				// Ignore kill errors.
			}
		}, 1200);

		const killTimer = setTimeout(() => {
			if (done) return;
			try {
				proc.kill("SIGKILL");
			} catch {
				// Ignore kill errors.
			}
			finish();
		}, 2800);

		proc.once("close", () => finish());
		proc.once("error", () => finish());

		try {
			proc.kill("SIGINT");
		} catch {
			finish();
		}
	});
}

async function transcribeWithWhisperCpp(wavPath: string): Promise<TranscriptionResult> {
	const configuredModel = normalizeOptional(process.env.PI_VOICE_WHISPER_MODEL);
	if (configuredModel && !existsSync(configuredModel)) {
		throw new Error(`PI_VOICE_WHISPER_MODEL 경로를 찾을 수 없음: ${configuredModel}`);
	}

	const modelPath = configuredModel ?? resolveWhisperModelPath();
	if (!modelPath) {
		throw new Error(
			"Whisper 모델(.bin)을 찾지 못함. PI_VOICE_WHISPER_MODEL=/절대경로/ggml-large-v3-turbo.bin 설정 필요",
		);
	}

	const whisperBins = parseCandidateList(process.env.PI_VOICE_WHISPER_BIN, DEFAULT_WHISPER_BINS);
	const language = whisperLanguage();
	const outputPrefix = join(os.tmpdir(), `pi-voice-txt-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
	const outputTxtPath = `${outputPrefix}.txt`;
	let lastError = "";

	for (const bin of whisperBins) {
		const args = ["-m", modelPath, "-f", wavPath, "-l", language, "-otxt", "-of", outputPrefix, "-nt"];

		let result = await runCommand(bin, args);

		if (
			result.code !== 0 &&
			/unknown|unrecognized|invalid option|illegal option/i.test(`${result.stderr}\n${result.stdout}`)
		) {
			const retryArgs = ["-m", modelPath, "-f", wavPath, "-l", language, "-otxt", "-of", outputPrefix];
			result = await runCommand(bin, retryArgs);
		}

		if (result.code !== 0) {
			if (result.errorMessage && /ENOENT|not found/i.test(result.errorMessage)) {
				lastError = `${bin} 실행 파일을 찾지 못함`;
				continue;
			}

			const reason = tailText(result.stderr || result.stdout || result.errorMessage || "unknown error", 220);
			lastError = `${bin} 실패 (code=${result.code}${result.signal ? `, signal=${result.signal}` : ""}): ${reason}`;
			continue;
		}

		let text = "";
		if (existsSync(outputTxtPath)) {
			const fileText = await fs.readFile(outputTxtPath, "utf8");
			text = normalizeTranscript(fileText);
		}

		if (!text) {
			text = extractTranscriptFromStdout(result.stdout);
		}

		await safeUnlink(outputTxtPath);

		if (!text) {
			lastError = `${bin} 실행은 성공했지만 인식 텍스트가 비어 있음`;
			continue;
		}

		return { text, bin, modelPath };
	}

	await safeUnlink(outputTxtPath);
	throw new Error(lastError || "사용 가능한 whisper.cpp CLI를 찾지 못함");
}

async function speakWithSystemTts(text: string): Promise<{ bin: string; spoken: string }> {
	const spoken = normalizeTranscript(text);
	if (!spoken) {
		throw new Error("읽을 텍스트가 비어 있음");
	}

	const voice = ttsVoice();
	const rate = ttsRate();
	let lastError = "";

	for (const bin of ttsBins()) {
		const args: string[] = [];
		if (voice) args.push("-v", voice);
		if (rate) args.push("-r", rate);
		args.push(spoken);

		const result = await runCommand(bin, args);
		if (result.code === 0) {
			return { bin, spoken };
		}

		if (result.errorMessage && /ENOENT|not found/i.test(result.errorMessage)) {
			lastError = `${bin} 실행 파일을 찾지 못함`;
			continue;
		}

		const reason = tailText(result.stderr || result.stdout || result.errorMessage || "unknown error", 220);
		lastError = `${bin} 실패 (code=${result.code}${result.signal ? `, signal=${result.signal}` : ""}): ${reason}`;
	}

	throw new Error(lastError || "사용 가능한 TTS 실행 파일을 찾지 못함");
}

export default function voiceInputExtension(pi: ExtensionAPI) {
	let latestCtx: ExtensionContext | undefined;
	let recorderProc: ChildProcess | null = null;
	let recordingPath: string | null = null;
	let recordingStartedAt = 0;
	let recorderStderr = "";
	let transcribing = false;
	let speaking = false;
	let agentRunning = false;
	const ttsEnabled = parseBooleanEnv(process.env.PI_VOICE_TTS_ENABLED, true);
	let pendingVoiceInputs: string[] = [];
	let queuedVoiceRuns = 0;
	let activeVoiceRun = false;

	const setStatus = (text: string | undefined) => {
		if (!latestCtx?.hasUI) return;
		latestCtx.ui.setStatus(VOICE_STATUS_KEY, text);
	};

	const notify = (message: string, level: LogLevel = "info") => {
		if (!latestCtx?.hasUI) return;
		latestCtx.ui.notify(message, level);
	};

	const queueVoiceInput = (text: string) => {
		const normalized = normalizeTranscript(text);
		if (!normalized) {
			throw new Error("음성 인식 결과가 비어 있음");
		}

		pendingVoiceInputs.push(normalized);
		try {
			if (agentRunning) {
				pi.sendUserMessage(normalized, { deliverAs: "followUp" });
			} else {
				pi.sendUserMessage(normalized);
			}
		} catch (error) {
			const idx = pendingVoiceInputs.indexOf(normalized);
			if (idx >= 0) pendingVoiceInputs.splice(idx, 1);
			throw error;
		}
	};

	const speakResponseSummary = async (responseText: string, options?: { force?: boolean }) => {
		if (!options?.force && !ttsEnabled) return false;
		if (speaking) return false;

		const summary = summarizeForSpeech(responseText, ttsSummaryMaxChars());
		if (!summary) return false;

		speaking = true;
		setStatus(SPEAKING_STATUS);

		try {
			const spoken = await speakWithSystemTts(summary);
			notify(`🔊 ${spoken.spoken}`, "info");
			return true;
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			notify(`음성 출력 실패: ${message}`, "warning");
			return false;
		} finally {
			speaking = false;
			if (!recorderProc && !transcribing) {
				setStatus(undefined);
			}
		}
	};

	const stopAndDiscardRecording = async () => {
		const proc = recorderProc;
		const wavPath = recordingPath;

		recorderProc = null;
		recordingPath = null;
		recordingStartedAt = 0;
		recorderStderr = "";
		transcribing = false;
		speaking = false;

		if (proc) {
			await stopProcessGracefully(proc);
		}

		await safeUnlink(wavPath);
		setStatus(undefined);
	};

	const startRecording = async (ctx: ExtensionContext) => {
		latestCtx = ctx;

		if (recorderProc) {
			notify("이미 녹음 중이야. Option+V 로 종료해줘.", "warning");
			return;
		}

		if (transcribing) {
			notify("현재 Whisper 변환 중이야. 잠시 후 다시 시도해줘.", "warning");
			return;
		}

		const wavPath = buildTempWavPath();
		let lastError = "";
		const recorderBins = parseCandidateList(process.env.PI_VOICE_RECORDER_BIN, DEFAULT_RECORDER_BINS);

		for (const bin of recorderBins) {
			const proc = spawn(bin, buildRecorderArgs(bin, wavPath), { stdio: ["ignore", "ignore", "pipe"] });
			const spawnResult = await waitForSpawn(proc);

			if (!spawnResult.ok) {
				lastError = `${bin}: ${spawnResult.error}`;
				continue;
			}

			recorderProc = proc;
			recordingPath = wavPath;
			recordingStartedAt = Date.now();
			recorderStderr = "";

			proc.stderr?.on("data", (chunk: Buffer | string) => {
				recorderStderr = appendLimited(recorderStderr, chunk.toString(), MAX_CAPTURE_CHARS);
			});

			proc.once("close", () => {
				if (recorderProc !== proc) return;
				recorderProc = null;
				recordingPath = null;
				recordingStartedAt = 0;
				recorderStderr = "";
				setStatus(undefined);
				if (!transcribing) {
					notify("녹음 프로세스가 종료됐어. Option+V 로 다시 시작해줘.", "warning");
				}
			});

			setStatus(RECORDING_STATUS);
			notify(`🎙️ 음성 입력 시작 (${bin})`, "info");
			return;
		}

		await safeUnlink(wavPath);
		notify(`녹음 시작 실패. sox 설치/마이크 권한 확인 필요 (${lastError || "unknown"})`, "error");
	};

	const stopRecordingAndTranscribe = async (ctx: ExtensionContext) => {
		latestCtx = ctx;

		if (!recorderProc || !recordingPath) {
			notify("지금은 녹음 중이 아니야. Option+V 로 시작해줘.", "info");
			return;
		}

		if (transcribing) {
			notify("이미 Whisper 변환 중이야.", "warning");
			return;
		}

		const proc = recorderProc;
		const wavPath = recordingPath;
		const elapsedSec = Math.max(1, Math.round((Date.now() - recordingStartedAt) / 1000));

		recorderProc = null;
		recordingPath = null;
		recordingStartedAt = 0;
		transcribing = true;

		setStatus(TRANSCRIBING_STATUS);
		notify(`🛑 녹음 종료 (${elapsedSec}초), Whisper 변환 시작`, "info");

		try {
			await stopProcessGracefully(proc);

			const size = await fileSize(wavPath);
			if (size <= 44) {
				notify("녹음 데이터가 너무 짧거나 비어 있어. 마이크 권한/입력을 확인해줘.", "warning");
				return;
			}

			const transcript = await transcribeWithWhisperCpp(wavPath);
			if (!transcript.text) {
				notify("인식 결과가 비어 있어.", "warning");
				return;
			}

			queueVoiceInput(transcript.text);
			notify(`✅ 음성 인식 완료 (${transcript.bin}, ${basename(transcript.modelPath)})`, "info");
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			const recorderLogTail = recorderStderr ? ` | recorder stderr: ${tailText(recorderStderr, 180)}` : "";
			notify(`Whisper 변환 실패: ${message}${recorderLogTail}`, "error");
		} finally {
			transcribing = false;
			recorderStderr = "";
			setStatus(undefined);
			await safeUnlink(wavPath);
		}
	};

	const toggleRecording = async (ctx: ExtensionContext) => {
		if (recorderProc) {
			await stopRecordingAndTranscribe(ctx);
			return;
		}
		await startRecording(ctx);
	};

	pi.registerShortcut(VOICE_SHORTCUT, {
		description: "Toggle voice input (sox + whisper.cpp)",
		handler: async (ctx) => {
			latestCtx = ctx;
			await toggleRecording(ctx);
		},
	});

	pi.on("input", async (event, ctx) => {
		latestCtx = ctx;
		if (event.source !== "extension") return { action: "continue" as const };

		const normalized = normalizeTranscript(event.text);
		if (!normalized) return { action: "continue" as const };

		const pendingIndex = pendingVoiceInputs.indexOf(normalized);
		if (pendingIndex >= 0) {
			pendingVoiceInputs.splice(pendingIndex, 1);
			queuedVoiceRuns += 1;
		}

		return { action: "continue" as const };
	});

	pi.on("agent_start", async (_event, ctx) => {
		agentRunning = true;
		latestCtx = ctx;
		activeVoiceRun = queuedVoiceRuns > 0;
		if (activeVoiceRun) {
			queuedVoiceRuns -= 1;
		}
	});

	pi.on("agent_end", async (event, ctx) => {
		agentRunning = false;
		latestCtx = ctx;

		if (!activeVoiceRun) return;
		activeVoiceRun = false;

		const latestAssistantText = extractLatestAssistantText(event.messages);
		if (!latestAssistantText) return;

		await speakResponseSummary(latestAssistantText);
	});

	pi.on("session_start", async (_event, ctx) => {
		agentRunning = false;
		latestCtx = ctx;
		speaking = false;
		pendingVoiceInputs = [];
		queuedVoiceRuns = 0;
		activeVoiceRun = false;
		setStatus(undefined);
	});

	pi.on("session_switch", async (_event, ctx) => {
		agentRunning = false;
		latestCtx = ctx;
		speaking = false;
		pendingVoiceInputs = [];
		queuedVoiceRuns = 0;
		activeVoiceRun = false;
		await stopAndDiscardRecording();
	});

	pi.on("session_fork", async (_event, ctx) => {
		latestCtx = ctx;
		setStatus(undefined);
	});

	pi.on("session_tree", async (_event, ctx) => {
		latestCtx = ctx;
		setStatus(undefined);
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		latestCtx = ctx;
		speaking = false;
		pendingVoiceInputs = [];
		queuedVoiceRuns = 0;
		activeVoiceRun = false;
		await stopAndDiscardRecording();
		setStatus(undefined);
	});
}
