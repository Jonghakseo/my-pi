import type { ExtensionAPI, ExtensionContext, ToolCallEvent, ToolResultEvent } from "@mariozechner/pi-coding-agent";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";

type ClaudeHookEventName = "SessionStart" | "UserPromptSubmit" | "PreToolUse" | "PostToolUse" | "Stop";

type JsonRecord = Record<string, unknown>;

interface ClaudeCommandHook {
	type?: string;
	command?: string;
	timeout?: number;
}

interface ClaudeHookGroup {
	matcher?: string;
	hooks?: ClaudeCommandHook[];
}

interface ClaudeSettings {
	hooks?: Record<string, ClaudeHookGroup[]>;
}

interface LoadedSettings {
	path: string;
	settings: ClaudeSettings | null;
	parseError?: string;
}

interface SettingsCacheEntry {
	mtimeMs: number;
	loaded: LoadedSettings;
}

interface HookExecResult {
	command: string;
	code: number;
	stdout: string;
	stderr: string;
	timedOut: boolean;
	json: unknown | null;
}

interface HookDecision {
	action: "none" | "allow" | "ask" | "block";
	reason?: string;
}

const SETTINGS_REL_PATH = path.join(".claude", "settings.json");
const TRANSCRIPT_TMP_DIR = path.join(os.tmpdir(), "pi-claude-hooks-bridge");
const DEFAULT_HOOK_TIMEOUT_MS = 30_000;

const BUILTIN_TOOL_ALIASES: Record<string, string> = {
	bash: "Bash",
	read: "Read",
	edit: "Edit",
	write: "Write",
	grep: "Grep",
	find: "Find",
	ls: "LS",
};

const settingsCache = new Map<string, SettingsCacheEntry>();
const parseErrorNotified = new Set<string>();
const stopHookActiveBySession = new Map<string, boolean>();

function getSessionId(ctx: ExtensionContext): string {
	try {
		const id = ctx.sessionManager.getSessionId();
		return id || "unknown";
	} catch {
		return "unknown";
	}
}

function getSettingsPath(cwd: string): string {
	return path.join(cwd, SETTINGS_REL_PATH);
}

function loadSettings(cwd: string): LoadedSettings {
	const settingsPath = getSettingsPath(cwd);

	if (!existsSync(settingsPath)) {
		return { path: settingsPath, settings: null };
	}

	let mtimeMs = 0;
	try {
		mtimeMs = statSync(settingsPath).mtimeMs;
	} catch {
		return { path: settingsPath, settings: null, parseError: "settings 파일 상태를 읽을 수 없습니다." };
	}

	const cached = settingsCache.get(settingsPath);
	if (cached && cached.mtimeMs === mtimeMs) {
		return cached.loaded;
	}

	try {
		const raw = readFileSync(settingsPath, "utf8");
		const parsed = JSON.parse(raw);
		const settings = typeof parsed === "object" && parsed ? (parsed as ClaudeSettings) : null;
		const loaded: LoadedSettings = { path: settingsPath, settings };
		settingsCache.set(settingsPath, { mtimeMs, loaded });
		return loaded;
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		const loaded: LoadedSettings = {
			path: settingsPath,
			settings: null,
			parseError: `.claude/settings.json 파싱 실패: ${message}`,
		};
		settingsCache.set(settingsPath, { mtimeMs, loaded });
		return loaded;
	}
}

function getHookGroups(settings: ClaudeSettings | null, eventName: ClaudeHookEventName): ClaudeHookGroup[] {
	if (!settings?.hooks) return [];
	const groups = settings.hooks[eventName];
	if (!Array.isArray(groups)) return [];
	return groups;
}

function getClaudeToolName(toolName: string): string {
	return BUILTIN_TOOL_ALIASES[toolName] || toolName;
}

function getMatcherCandidates(toolName: string): string[] {
	const canonical = getClaudeToolName(toolName);
	const set = new Set<string>([toolName, toolName.toLowerCase(), canonical, canonical.toLowerCase()]);
	return Array.from(set);
}

function matcherMatches(matcher: string | undefined, toolName: string): boolean {
	if (!matcher || matcher.trim() === "") return true;

	const candidates = getMatcherCandidates(toolName);

	try {
		const re = new RegExp(`^(?:${matcher})$`);
		if (candidates.some((name) => re.test(name))) return true;
	} catch {
		// matcher가 정규식으로 유효하지 않아도 fallback 비교를 시도한다.
	}

	const tokens = matcher
		.split("|")
		.map((token) => token.trim())
		.filter(Boolean);

	if (tokens.length === 0) return false;
	return tokens.some((token) =>
		candidates.some((name) => name === token || name.toLowerCase() === token.toLowerCase()),
	);
}

function getCommandHooks(
	settings: ClaudeSettings | null,
	eventName: ClaudeHookEventName,
	toolName?: string,
): ClaudeCommandHook[] {
	const groups = getHookGroups(settings, eventName);
	const hooks: ClaudeCommandHook[] = [];

	for (const group of groups) {
		if (toolName && !matcherMatches(group.matcher, toolName)) continue;
		if (!Array.isArray(group.hooks)) continue;

		for (const hook of group.hooks) {
			if (!hook || typeof hook !== "object") continue;
			if (hook.type !== "command") continue;
			if (typeof hook.command !== "string" || hook.command.trim() === "") continue;
			hooks.push(hook);
		}
	}

	return hooks;
}

function resolveMaybePath(inputPath: string, cwd: string): string {
	if (path.isAbsolute(inputPath)) return path.normalize(inputPath);
	return path.resolve(cwd, inputPath);
}

function normalizeToolInput(toolName: string, rawInput: unknown, cwd: string): JsonRecord {
	const input: JsonRecord = rawInput && typeof rawInput === "object" ? { ...(rawInput as JsonRecord) } : {};

	const pathCandidate =
		typeof input.path === "string"
			? input.path
			: typeof input.file_path === "string"
				? input.file_path
				: typeof input.filePath === "string"
					? input.filePath
					: undefined;

	if (pathCandidate) {
		const absolute = resolveMaybePath(pathCandidate, cwd);
		input.path = absolute;
		input.file_path = absolute;
		input.filePath = absolute;
	}

	if (toolName === "bash" && typeof input.command !== "string") {
		input.command = "";
	}

	return input;
}

function extractTextFromBlocks(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";

	const lines: string[] = [];
	for (const block of content) {
		if (!block || typeof block !== "object") continue;
		const text = (block as JsonRecord).text;
		if (typeof text === "string") lines.push(text);
	}
	return lines.join("");
}

function toClaudeTranscriptLines(ctx: ExtensionContext): string[] {
	const lines: string[] = [];
	const entries = ctx.sessionManager.getEntries();

	for (const entry of entries) {
		// SessionEntry is a discriminated union on `type`; narrowing to "message"
		// gives SessionMessageEntry whose `message` field is AgentMessage.
		if (!entry || entry.type !== "message") continue;
		const { message } = entry;

		if (message.role === "assistant") {
			const mapped: JsonRecord[] = [];
			for (const block of message.content) {
				if (block.type === "text") {
					mapped.push({ type: "text", text: block.text });
					continue;
				}
				if (block.type === "toolCall") {
					mapped.push({
						type: "tool_use",
						id: block.id,
						name: block.name,
						input: block.arguments,
					});
				}
			}

			if (mapped.length > 0) {
				lines.push(JSON.stringify({ type: "assistant", message: { content: mapped } }));
			}
			continue;
		}

		if (message.role === "user") {
			const mapped: JsonRecord[] = [];
			if (Array.isArray(message.content)) {
				for (const block of message.content) {
					if (block.type === "text") {
						mapped.push({ type: "text", text: block.text });
					}
				}
			}
			if (mapped.length > 0) {
				lines.push(JSON.stringify({ type: "user", message: { content: mapped } }));
			}
			continue;
		}

		if (message.role === "toolResult") {
			const toolUseId = message.toolCallId;
			const text = extractTextFromBlocks(message.content);
			lines.push(
				JSON.stringify({
					type: "user",
					message: {
						content: [
							{
								type: "tool_result",
								tool_use_id: toolUseId,
								content: [{ type: "text", text }],
							},
						],
					},
				}),
			);
		}
	}

	return lines;
}

function createTranscriptFile(ctx: ExtensionContext, sessionId: string): string | undefined {
	try {
		const lines = toClaudeTranscriptLines(ctx);
		mkdirSync(TRANSCRIPT_TMP_DIR, { recursive: true });
		const safeSessionId = sessionId.replace(/[^a-zA-Z0-9_-]/g, "_");
		const transcriptPath = path.join(TRANSCRIPT_TMP_DIR, `${safeSessionId}.jsonl`);
		const content = lines.length > 0 ? `${lines.join("\n")}\n` : "";
		writeFileSync(transcriptPath, content, "utf8");
		return transcriptPath;
	} catch {
		return undefined;
	}
}

function parseJsonFromStdout(stdout: string): unknown | null {
	const trimmed = stdout.trim();
	if (!trimmed) return null;

	try {
		return JSON.parse(trimmed);
	} catch {
		// pass
	}

	const lines = trimmed
		.split("\n")
		.map((line) => line.trim())
		.filter(Boolean);

	for (let i = lines.length - 1; i >= 0; i -= 1) {
		try {
			return JSON.parse(lines[i]);
		} catch {
			// pass
		}
	}

	return null;
}

function fallbackReason(stderr: string, stdout: string): string | undefined {
	const text = stderr.trim() || stdout.trim();
	if (!text) return undefined;
	return text.length > 2000 ? `${text.slice(0, 2000)}...` : text;
}

function extractDecision(result: HookExecResult): HookDecision {
	const payload = result.json;
	const asObj = payload && typeof payload === "object" ? (payload as JsonRecord) : undefined;
	const hookSpecific = asObj?.hookSpecificOutput;
	const hookSpecificObj = hookSpecific && typeof hookSpecific === "object" ? (hookSpecific as JsonRecord) : undefined;

	const decisionRaw =
		(typeof hookSpecificObj?.permissionDecision === "string" && hookSpecificObj.permissionDecision) ||
		(typeof asObj?.permissionDecision === "string" && asObj.permissionDecision) ||
		(typeof hookSpecificObj?.decision === "string" && hookSpecificObj.decision) ||
		(typeof asObj?.decision === "string" && asObj.decision) ||
		"";

	const reason =
		(typeof hookSpecificObj?.permissionDecisionReason === "string" && hookSpecificObj.permissionDecisionReason) ||
		(typeof asObj?.permissionDecisionReason === "string" && asObj.permissionDecisionReason) ||
		(typeof hookSpecificObj?.reason === "string" && hookSpecificObj.reason) ||
		(typeof asObj?.reason === "string" && asObj.reason) ||
		fallbackReason(result.stderr, result.stdout);

	const decision = decisionRaw.toLowerCase();
	if (decision === "allow") return { action: "allow", reason };
	if (decision === "ask") return { action: "ask", reason };
	if (decision === "deny" || decision === "block") return { action: "block", reason };

	if (result.code === 2) {
		return { action: "block", reason: reason || "Hook requested block (exit code 2)." };
	}

	return { action: "none", reason };
}

async function execCommandHook(
	command: string,
	cwd: string,
	payload: JsonRecord,
	timeoutMs: number,
): Promise<HookExecResult> {
	return new Promise((resolve) => {
		const child = spawn("bash", ["-lc", command], {
			cwd,
			env: {
				...process.env,
				CLAUDE_PROJECT_DIR: cwd,
				PWD: cwd,
			},
			stdio: ["pipe", "pipe", "pipe"],
		});

		let stdout = "";
		let stderr = "";
		let settled = false;
		let timedOut = false;

		const finalize = (code: number) => {
			if (settled) return;
			settled = true;
			const json = parseJsonFromStdout(stdout);
			resolve({ command, code, stdout, stderr, timedOut, json });
		};

		let timeout: NodeJS.Timeout | undefined;
		if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
			timeout = setTimeout(() => {
				timedOut = true;
				child.kill("SIGTERM");
				setTimeout(() => child.kill("SIGKILL"), 1000);
			}, timeoutMs);
		}

		child.stdout.on("data", (chunk: Buffer | string) => {
			stdout += chunk.toString();
		});

		child.stderr.on("data", (chunk: Buffer | string) => {
			stderr += chunk.toString();
		});

		child.on("error", (error) => {
			if (timeout) clearTimeout(timeout);
			stderr += `\n${error instanceof Error ? error.message : String(error)}`;
			finalize(1);
		});

		child.on("close", (code) => {
			if (timeout) clearTimeout(timeout);
			finalize(typeof code === "number" ? code : 1);
		});

		try {
			child.stdin.write(`${JSON.stringify(payload)}\n`);
			child.stdin.end();
		} catch (error) {
			stderr += `\nstdin write failed: ${error instanceof Error ? error.message : String(error)}`;
			finalize(1);
		}
	});
}

function makeBasePayload(eventName: ClaudeHookEventName, ctx: ExtensionContext): JsonRecord {
	return {
		hook_event_name: eventName,
		session_id: getSessionId(ctx),
		cwd: ctx.cwd,
	};
}

function buildPreToolUsePayload(event: ToolCallEvent, ctx: ExtensionContext): JsonRecord {
	const toolInput = normalizeToolInput(event.toolName, event.input as unknown, ctx.cwd);
	return {
		...makeBasePayload("PreToolUse", ctx),
		tool_name: getClaudeToolName(event.toolName),
		tool_input: toolInput,
		tool_call_id: event.toolCallId,
	};
}

function buildPostToolUsePayload(event: ToolResultEvent, ctx: ExtensionContext): JsonRecord {
	const toolInput = normalizeToolInput(event.toolName, event.input as unknown, ctx.cwd);
	return {
		...makeBasePayload("PostToolUse", ctx),
		tool_name: getClaudeToolName(event.toolName),
		tool_input: toolInput,
		tool_response: {
			is_error: Boolean(event.isError),
			content: event.content,
			details: event.details,
		},
		tool_call_id: event.toolCallId,
	};
}

function notifyOnceForParseError(ctx: ExtensionContext, loaded: LoadedSettings): void {
	if (!loaded.parseError) return;
	if (!ctx.hasUI) return;
	if (parseErrorNotified.has(loaded.path)) return;
	parseErrorNotified.add(loaded.path);
	ctx.ui.notify(`[claude-hooks-bridge] ${loaded.parseError}`, "warning");
}

function countHooks(settings: ClaudeSettings): number {
	if (!settings.hooks) return 0;
	let total = 0;
	for (const groups of Object.values(settings.hooks)) {
		if (!Array.isArray(groups)) continue;
		for (const group of groups) {
			if (!Array.isArray(group.hooks)) continue;
			total += group.hooks.filter((hook) => hook?.type === "command" && typeof hook.command === "string").length;
		}
	}
	return total;
}

function toBlockReason(reason: string | undefined, fallback: string): string {
	const text = (reason || "").trim();
	if (!text) return fallback;
	if (text.length <= 2000) return text;
	return `${text.slice(0, 2000)}...`;
}

async function runHooks(
	settings: ClaudeSettings | null,
	eventName: ClaudeHookEventName,
	ctx: ExtensionContext,
	payload: JsonRecord,
	toolNameForMatcher?: string,
): Promise<HookExecResult[]> {
	const hooks = getCommandHooks(settings, eventName, toolNameForMatcher);
	if (hooks.length === 0) return [];

	const results: HookExecResult[] = [];

	for (const hook of hooks) {
		const timeoutMs =
			typeof hook.timeout === "number" && Number.isFinite(hook.timeout) && hook.timeout > 0
				? hook.timeout
				: DEFAULT_HOOK_TIMEOUT_MS;
		const result = await execCommandHook(hook.command as string, ctx.cwd, payload, timeoutMs);
		results.push(result);
	}

	return results;
}

export default function claudeHooksBridge(pi: ExtensionAPI) {
	pi.on("session_start", async (_event, ctx) => {
		const loaded = loadSettings(ctx.cwd);
		notifyOnceForParseError(ctx, loaded);
		const settings = loaded.settings;

		const sessionId = getSessionId(ctx);
		stopHookActiveBySession.set(sessionId, false);

		if (settings && ctx.hasUI) {
			const total = countHooks(settings);
			if (total > 0) {
				ctx.ui.notify(`[claude-hooks-bridge] loaded ${total} hook(s) from ${SETTINGS_REL_PATH}`, "info");
			}
		}

		if (!settings) return;

		const payload = makeBasePayload("SessionStart", ctx);
		const results = await runHooks(settings, "SessionStart", ctx, payload);

		if (!ctx.hasUI) return;
		for (const result of results) {
			const out = result.stdout.trim();
			const err = result.stderr.trim();
			if (out) {
				ctx.ui.notify(
					`[claude-hooks-bridge:SessionStart]\n${out.length > 1200 ? `${out.slice(0, 1200)}...` : out}`,
					"info",
				);
			}
			if (err) {
				ctx.ui.notify(
					`[claude-hooks-bridge:SessionStart stderr]\n${err.length > 1200 ? `${err.slice(0, 1200)}...` : err}`,
					"warning",
				);
			}
		}
	});

	pi.on("session_switch", async (_event, ctx) => {
		const sessionId = getSessionId(ctx);
		stopHookActiveBySession.set(sessionId, false);
	});

	pi.on("session_shutdown", async () => {
		stopHookActiveBySession.clear();
	});

	pi.on("before_agent_start", async (event, ctx) => {
		const loaded = loadSettings(ctx.cwd);
		notifyOnceForParseError(ctx, loaded);
		const settings = loaded.settings;
		if (!settings) return;

		const payload: JsonRecord = {
			...makeBasePayload("UserPromptSubmit", ctx),
			prompt: event.prompt,
		};
		await runHooks(settings, "UserPromptSubmit", ctx, payload);
	});

	pi.on("tool_call", async (event, ctx) => {
		const loaded = loadSettings(ctx.cwd);
		notifyOnceForParseError(ctx, loaded);
		const settings = loaded.settings;
		if (!settings) return;

		const payload = buildPreToolUsePayload(event, ctx);
		const results = await runHooks(settings, "PreToolUse", ctx, payload, event.toolName);

		for (const result of results) {
			const decision = extractDecision(result);

			if (decision.action === "ask") {
				const reason = toBlockReason(decision.reason, "Hook requested permission.");

				if (!ctx.hasUI) {
					return { block: true, reason: `Blocked (no UI): ${reason}` };
				}

				const ok = await ctx.ui.confirm("Claude hook permission", reason, { timeout: 30_000 });
				if (!ok) {
					return {
						block: true,
						reason: toBlockReason(decision.reason, "Blocked by user confirmation from .claude hook."),
					};
				}
				continue;
			}

			if (decision.action === "block") {
				return {
					block: true,
					reason: toBlockReason(decision.reason, "Blocked by .claude PreToolUse hook."),
				};
			}
		}

		return undefined;
	});

	pi.on("tool_result", async (event, ctx) => {
		const loaded = loadSettings(ctx.cwd);
		notifyOnceForParseError(ctx, loaded);
		const settings = loaded.settings;
		if (!settings) return;

		const payload = buildPostToolUsePayload(event, ctx);
		await runHooks(settings, "PostToolUse", ctx, payload, event.toolName);
	});

	pi.on("agent_end", async (_event, ctx) => {
		const loaded = loadSettings(ctx.cwd);
		notifyOnceForParseError(ctx, loaded);
		const settings = loaded.settings;
		if (!settings) return;

		const sessionId = getSessionId(ctx);
		const stopHookActive = stopHookActiveBySession.get(sessionId) || false;
		const transcriptPath = createTranscriptFile(ctx, sessionId);

		const payload: JsonRecord = {
			...makeBasePayload("Stop", ctx),
			stop_hook_active: stopHookActive,
		};
		if (transcriptPath) payload.transcript_path = transcriptPath;

		const results = await runHooks(settings, "Stop", ctx, payload);

		let blockedReason: string | undefined;
		for (const result of results) {
			const decision = extractDecision(result);
			if (decision.action === "block") {
				blockedReason = toBlockReason(
					decision.reason,
					"Stop hook blocked completion. Continue the remaining work before finishing.",
				);
				break;
			}
		}

		if (!blockedReason) {
			stopHookActiveBySession.set(sessionId, false);
			return;
		}

		if (!stopHookActive) {
			stopHookActiveBySession.set(sessionId, true);
			pi.sendUserMessage(blockedReason, { deliverAs: "followUp" });
			if (ctx.hasUI) {
				ctx.ui.notify("[claude-hooks-bridge] Stop hook blocked end and queued follow-up.", "info");
			}
			return;
		}

		// 무한 루프 보호: 이미 stop_hook_active=true 인 상태에서 다시 block이면 자동 재시도하지 않는다.
		stopHookActiveBySession.set(sessionId, false);
		if (ctx.hasUI) {
			ctx.ui.notify(`[claude-hooks-bridge] Stop hook blocked again (loop guard): ${blockedReason}`, "warning");
		}
	});
}
