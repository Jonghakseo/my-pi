/**
 * Desktop TUI Extension — Fully Functional Native Chat Window
 *
 * Opens a Glimpse native webview window that mirrors the pi terminal session:
 * - Full bidirectional chat: send messages, stream responses in real-time
 * - Markdown-rendered assistant messages with syntax highlighting
 * - Tool execution indicators (tool calls, results)
 * - Sidebar: threads, skills, settings, explorer, workspace
 * - Ctrl+Alt+N or /desktop to open
 */

import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, basename, dirname, extname, resolve, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { exec, execSync } from "node:child_process";
import type { AssistantMessage } from "@mariozechner/pi-ai";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Key, matchesKey } from "@mariozechner/pi-tui";
// @ts-expect-error glimpseui does not publish TypeScript declarations.
import { open } from "glimpseui";

type GlimpseWindow = ReturnType<typeof open>;

const __dirname = dirname(fileURLToPath(import.meta.url));
const webDir = join(__dirname, "web");

// ─── Security Helpers ────────────────────────────────────────

const MAX_ATTACH_SIZE = 25 * 1024 * 1024; // 25 MB max attachment

/** Validate that a path is within allowed directories (sessions, cwd, or home). */
function isPathAllowed(filePath: string, ctx: { cwd: string } | null): boolean {
	const home = process.env.HOME || process.env.USERPROFILE || "";
	const resolved = resolve(normalize(filePath));
	const sessionsDir = resolve(join(home, ".pi", "agent", "sessions"));

	// Allow paths under the sessions directory
	if (resolved.startsWith(sessionsDir + "/") || resolved.startsWith(sessionsDir + "\\")) return true;

	// Allow paths under the current working directory
	if (ctx) {
		const cwdResolved = resolve(ctx.cwd);
		if (resolved.startsWith(cwdResolved + "/") || resolved.startsWith(cwdResolved + "\\") || resolved === cwdResolved)
			return true;
	}

	return false;
}

/** Validate that a session file path is a .jsonl file inside the sessions directory. */
function isValidSessionFile(filePath: string): boolean {
	const home = process.env.HOME || process.env.USERPROFILE || "";
	const resolved = resolve(normalize(filePath));
	const sessionsDir = resolve(join(home, ".pi", "agent", "sessions"));

	if (!resolved.endsWith(".jsonl")) return false;
	if (!resolved.startsWith(sessionsDir + "/") && !resolved.startsWith(sessionsDir + "\\")) return false;

	// Reject path traversal attempts
	if (filePath.includes("..")) return false;

	return true;
}

// ─── Hidden Workspaces Persistence ───────────────────────────

function getHiddenWorkspacesPath(): string {
	const home = process.env.HOME || process.env.USERPROFILE || "";
	return join(home, ".pi", "agent", "hidden-workspaces.json");
}

function loadHiddenWorkspaces(): Record<string, boolean> {
	try {
		const fp = getHiddenWorkspacesPath();
		if (existsSync(fp)) return JSON.parse(readFileSync(fp, "utf-8"));
	} catch {}
	return {};
}

function saveHiddenWorkspaces(hidden: Record<string, boolean>): void {
	try {
		writeFileSync(getHiddenWorkspacesPath(), JSON.stringify(hidden, null, 2));
	} catch {}
}

const BUILTIN_COMMANDS = [
	{ name: "settings", description: "Open settings menu" },
	{ name: "model", description: "Select model (opens selector UI)" },
	{ name: "scoped-models", description: "Enable/disable models for Ctrl+P cycling" },
	{ name: "export", description: "Export session (HTML default, or specify path)" },
	{ name: "import", description: "Import and resume a session from a JSONL file" },
	{ name: "share", description: "Share session as a secret GitHub gist" },
	{ name: "copy", description: "Copy last agent message to clipboard" },
	{ name: "name", description: "Set session display name" },
	{ name: "session", description: "Show session info and stats" },
	{ name: "changelog", description: "Show changelog entries" },
	{ name: "hotkeys", description: "Show all keyboard shortcuts" },
	{ name: "fork", description: "Create a new fork from a previous message" },
	{ name: "tree", description: "Navigate session tree (switch branches)" },
	{ name: "login", description: "Login with OAuth provider" },
	{ name: "logout", description: "Logout from OAuth provider" },
	{ name: "new", description: "Start a new session" },
	{ name: "compact", description: "Manually compact the session context" },
	{ name: "resume", description: "Resume a different session" },
	{ name: "reload", description: "Reload keybindings, extensions, skills, prompts, and themes" },
	{ name: "quit", description: "Quit pi" },
];

function getAllCommands(pi: ExtensionAPI) {
	const extCommands = pi.getCommands().map((c) => ({
		name: c.name,
		description: c.description || "",
		source: (c as any).sourceInfo?.source || "extension",
		scope: (c as any).sourceInfo?.scope || "",
		path: (c as any).sourceInfo?.path || "",
	}));
	const extNames = new Set(extCommands.map((c) => c.name));
	return [
		...BUILTIN_COMMANDS.filter((c) => !extNames.has(c.name)).map((c) => ({
			...c,
			source: "built-in",
			scope: "app",
			path: "",
		})),
		...extCommands,
	].sort((a, b) => a.name.localeCompare(b.name));
}

// ─── Helpers ─────────────────────────────────────────────────

function getProjectName(cwd: string): string {
	return basename(cwd);
}

function getGitBranch(cwd: string): string | null {
	try {
		const branch = execSync("git rev-parse --abbrev-ref HEAD", {
			cwd,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
		}).trim();
		return branch.length > 0 ? branch : null;
	} catch {
		return null;
	}
}

function getTokenStats(ctx: ExtensionContext) {
	let input = 0,
		output = 0,
		cost = 0,
		cache = 0;
	for (const e of ctx.sessionManager.getBranch()) {
		if (e.type === "message" && e.message.role === "assistant") {
			const m = e.message as AssistantMessage;
			input += m.usage.input;
			output += m.usage.output;
			cost += m.usage.cost.total;
			cache += (m.usage as any).cacheRead ?? 0;
		}
	}
	return { input, output, cost, cache };
}

function getSessionThreads(sessionDir: string | null) {
	if (!sessionDir || !existsSync(sessionDir)) return [];
	try {
		return readdirSync(sessionDir)
			.filter((f) => f.endsWith(".jsonl"))
			.map((f) => {
				const fp = join(sessionDir, f);
				const stat = statSync(fp);
				let name = f.replace(".jsonl", "");
				try {
					const content = readFileSync(fp, "utf-8");
					const line = content.split("\n").find((l) => l.includes('"role":"user"') || l.includes('"role": "user"'));
					if (line) {
						const parsed = JSON.parse(line);
						const msgContent = parsed?.message?.content;
						let text = "";
						if (Array.isArray(msgContent)) {
							const textBlock = msgContent.find((b: any) => b.type === "text");
							if (textBlock?.text) text = textBlock.text;
						} else if (typeof msgContent === "string") {
							text = msgContent;
						}
						if (text.length > 0) name = text.slice(0, 70).replace(/\n/g, " ");
					}
				} catch {}
				return { name, file: fp, date: stat.mtime };
			})
			.sort((a, b) => b.date.getTime() - a.date.getTime());
	} catch {
		return [];
	}
}

function getSkills() {
	const skills: { name: string; desc: string }[] = [];
	const home = process.env.HOME || process.env.USERPROFILE || "";
	for (const dir of [join(home, ".pi", "agent", "skills"), join(home, ".agents", "skills")]) {
		if (!existsSync(dir)) continue;
		try {
			for (const entry of readdirSync(dir)) {
				const sp = join(dir, entry, "SKILL.md");
				if (!existsSync(sp)) continue;
				let desc = "";
				try {
					const c = readFileSync(sp, "utf-8");
					const m = c.match(/description[:\s]*['"]*(.+?)['"]?\s*$/im);
					if (m) desc = m[1]!.trim().slice(0, 80);
				} catch {}
				if (!skills.find((s) => s.name === entry)) skills.push({ name: entry, desc });
			}
		} catch {}
	}
	return skills;
}

function getExtensions() {
	const extensions: { name: string; source: string; type: string }[] = [];
	const home = process.env.HOME || process.env.USERPROFILE || "";

	// Built-in extensions from ~/.pi/agent/extensions/
	const builtinDir = join(home, ".pi", "agent", "extensions");
	if (existsSync(builtinDir)) {
		try {
			for (const entry of readdirSync(builtinDir)) {
				const entryPath = join(builtinDir, entry);
				try {
					if (
						statSync(entryPath).isDirectory() &&
						(existsSync(join(entryPath, "index.ts")) || existsSync(join(entryPath, "index.js")))
					) {
						extensions.push({ name: entry, source: "built-in", type: "builtin" });
					}
				} catch {}
			}
		} catch {}
	}

	// Extensions from settings.json
	const settingsPath = join(home, ".pi", "agent", "settings.json");
	if (existsSync(settingsPath)) {
		try {
			const settings = JSON.parse(readFileSync(settingsPath, "utf-8"));

			// Direct extensions array (e.g. "+extensions/cmux/index.ts")
			if (Array.isArray(settings.extensions)) {
				for (const ext of settings.extensions) {
					if (typeof ext === "string") {
						const name = ext
							.replace(/^\+/, "")
							.replace(/\/index\.(ts|js)$/, "")
							.replace(/^extensions\//, "");
						if (!extensions.find((e) => e.name === name)) {
							extensions.push({ name, source: "local", type: "local" });
						}
					}
				}
			}

			// Package extensions from "packages" array
			if (Array.isArray(settings.packages)) {
				for (const pkg of settings.packages) {
					let source = "";
					let pkgExtensions: string[] = [];

					if (typeof pkg === "string") {
						source = pkg;
					} else if (typeof pkg === "object" && pkg.source) {
						source = pkg.source;
						if (Array.isArray(pkg.extensions)) pkgExtensions = pkg.extensions;
					}

					if (pkgExtensions.length > 0) {
						const pkgName = source
							.replace(/^(git:|npm:)/, "")
							.replace(/^github\.com\//, "")
							.replace(/^https:\/\/github\.com\//, "");
						for (const ext of pkgExtensions) {
							const extName = ext
								.replace(/^\+/, "")
								.replace(/\/index\.(ts|js)$/, "")
								.replace(/^extensions?\//, "");
							extensions.push({ name: extName, source: pkgName, type: "package" });
						}
					} else if (source) {
						const pkgName = source
							.replace(/^(git:|npm:)/, "")
							.replace(/^github\.com\//, "")
							.replace(/^https:\/\/github\.com\//, "");
						const gitDir = join(home, ".pi", "agent", "git", "github.com", ...pkgName.split("/"));
						const hasExtension =
							existsSync(join(gitDir, "extension.ts")) ||
							existsSync(join(gitDir, "extension.js")) ||
							existsSync(join(gitDir, "extension", "index.ts")) ||
							existsSync(join(gitDir, "extension", "index.js"));
						if (hasExtension) {
							extensions.push({ name: pkgName.split("/").pop() || pkgName, source: pkgName, type: "package" });
						}
					}
				}
			}
		} catch {}
	}

	return extensions;
}

function decodeSessionDirName(dirName: string): string {
	// Reverse of: `--${cwd.replace(/^[\/\\]/, "").replace(/[\/\\:]/g, "-")}--`
	// e.g. --C--Users-Jagtprit-- → C:\Users\Jagtprit
	let decoded = dirName.replace(/^--/, "").replace(/--$/, "");
	// First segment after removing leading -- is drive letter on Windows (e.g. "C")
	// Pattern: C--Users-Jagtprit → C:\Users\Jagtprit
	// The double dash after drive letter was from the colon
	const match = decoded.match(/^([A-Za-z])--(.*)$/);
	if (match) {
		decoded = match[1] + ":\\" + match[2].replace(/-/g, "\\");
	} else {
		// Unix path: --home-user-project-- → /home/user/project
		decoded = "/" + decoded.replace(/-/g, "/");
	}
	return decoded;
}

function getWorkspaces() {
	const home = process.env.HOME || process.env.USERPROFILE || "";
	const sessionsRoot = join(home, ".pi", "agent", "sessions");
	if (!existsSync(sessionsRoot)) return [];

	const workspaces: { name: string; path: string; dirName: string; sessionCount: number; lastActive: Date }[] = [];

	try {
		for (const dirName of readdirSync(sessionsRoot)) {
			const dirPath = join(sessionsRoot, dirName);
			try {
				if (!statSync(dirPath).isDirectory()) continue;
			} catch {
				continue;
			}

			// Skip temp/worktree dirs to reduce noise
			if (
				dirName.includes("pi-gui-workspace") ||
				dirName.includes("pi-gui-git-workspace") ||
				dirName.includes("worktrees")
			)
				continue;

			const decodedPath = decodeSessionDirName(dirName);
			const name = basename(decodedPath) || decodedPath;

			// Count sessions and find most recent
			let sessionCount = 0;
			let lastActive = new Date(0);
			try {
				for (const f of readdirSync(dirPath)) {
					if (!f.endsWith(".jsonl")) continue;
					sessionCount++;
					try {
						const mtime = statSync(join(dirPath, f)).mtime;
						if (mtime > lastActive) lastActive = mtime;
					} catch {}
				}
			} catch {}

			if (sessionCount === 0) continue;

			workspaces.push({ name, path: decodedPath, dirName, sessionCount, lastActive });
		}
	} catch {}

	// Sort by most recently active
	workspaces.sort((a, b) => b.lastActive.getTime() - a.lastActive.getTime());
	return workspaces;
}

function getWorkspaceSessions(dirName: string) {
	// Reject traversal attempts
	if (dirName.includes("..") || dirName.includes("/") || dirName.includes("\\")) return [];
	const home = process.env.HOME || process.env.USERPROFILE || "";
	const dirPath = join(home, ".pi", "agent", "sessions", dirName);
	return getSessionThreads(dirPath);
}

function searchSessionThreads(
	sessionDir: string | null,
	query: string,
): Array<{ name: string; file: string; date: Date; matchSnippet: string }> {
	if (!sessionDir || !existsSync(sessionDir) || !query) return [];
	const lowerQuery = query.toLowerCase();
	const results: Array<{ name: string; file: string; date: Date; matchSnippet: string }> = [];
	try {
		const files = readdirSync(sessionDir).filter((f) => f.endsWith(".jsonl"));
		for (const f of files) {
			const fp = join(sessionDir, f);
			const stat = statSync(fp);
			let threadName = f.replace(".jsonl", "");
			let matchSnippet = "";
			try {
				const content = readFileSync(fp, "utf-8");
				const lines = content.split("\n");
				let firstUserText = "";
				for (const line of lines) {
					if (!line.trim()) continue;
					try {
						const entry = JSON.parse(line);
						if (entry.type !== "message") continue;
						const msg = entry.message;
						if (!msg) continue;
						let text = "";
						if (Array.isArray(msg.content)) {
							for (const b of msg.content) {
								if (b.type === "text" && b.text) text += b.text + " ";
							}
						} else if (typeof msg.content === "string") {
							text = msg.content;
						}
						text = text.trim();
						if (!text) continue;
						if (msg.role === "user" && !firstUserText) firstUserText = text;
						if (text.toLowerCase().includes(lowerQuery)) {
							// Extract snippet around the match
							const idx = text.toLowerCase().indexOf(lowerQuery);
							const start = Math.max(0, idx - 30);
							const end = Math.min(text.length, idx + query.length + 50);
							matchSnippet =
								(start > 0 ? "..." : "") +
								text.slice(start, end).replace(/\n/g, " ") +
								(end < text.length ? "..." : "");
							break;
						}
					} catch {}
				}
				if (firstUserText) threadName = firstUserText.slice(0, 70).replace(/\n/g, " ");
				if (matchSnippet) {
					results.push({ name: threadName, file: fp, date: stat.mtime, matchSnippet });
				}
			} catch {}
		}
	} catch {}
	results.sort((a, b) => b.date.getTime() - a.date.getTime());
	return results;
}

function extractSessionMessages(ctx: ExtensionContext) {
	const messages: Array<{ role: string; content: string; toolName?: string }> = [];

	for (const e of ctx.sessionManager.getBranch()) {
		if (e.type === "compaction") {
			// Show compacted history as a summary message
			const ce = e as any;
			if (ce.summary) {
				messages.push({ role: "assistant", content: ce.summary });
			}
		}
		if (e.type === "custom_message") {
			const cm = e as any;
			if (cm.display && cm.content) {
				const text =
					typeof cm.content === "string"
						? cm.content
						: Array.isArray(cm.content)
							? cm.content
									.filter((b: any) => b.type === "text")
									.map((b: any) => b.text)
									.join("")
							: "";
				if (text.trim()) messages.push({ role: "assistant", content: text.trim() });
			}
		}
		if (e.type !== "message") continue;
		const msg = e.message;
		if (msg.role === "user") {
			let text = "";
			if (Array.isArray(msg.content)) {
				for (const block of msg.content) {
					if ((block as any).type === "text") text += (block as any).text;
				}
			} else if (typeof msg.content === "string") {
				text = msg.content;
			}
			if (text.trim()) messages.push({ role: "user", content: text.trim() });
		} else if (msg.role === "assistant") {
			let text = "";
			const toolCalls: Array<{ role: string; content: string; toolName?: string }> = [];
			if (Array.isArray(msg.content)) {
				for (const block of msg.content) {
					if ((block as any).type === "text") text += (block as any).text;
					else if ((block as any).type === "tool_use") {
						toolCalls.push({
							role: "tool",
							content: JSON.stringify((block as any).input || {}, null, 2).slice(0, 300),
							toolName: (block as any).name,
						});
					}
				}
			} else if (typeof msg.content === "string") {
				text = msg.content;
			}
			// Add tool calls before the text response
			messages.push(...toolCalls);
			if (text.trim()) messages.push({ role: "assistant", content: text.trim() });
		}
	}
	return messages;
}

function extractThreadMessages(filePath: string) {
	const messages: Array<{ role: string; content: string; toolName?: string }> = [];
	try {
		const content = readFileSync(filePath, "utf-8");
		for (const line of content.split("\n")) {
			if (!line.trim()) continue;
			try {
				const entry = JSON.parse(line);
				if (entry.type === "compaction" && entry.summary) {
					messages.push({ role: "assistant", content: entry.summary });
					continue;
				}
				if (entry.type === "custom_message" && entry.display && entry.content) {
					const text =
						typeof entry.content === "string"
							? entry.content
							: Array.isArray(entry.content)
								? entry.content
										.filter((b: any) => b.type === "text")
										.map((b: any) => b.text)
										.join("")
								: "";
					if (text.trim()) messages.push({ role: "assistant", content: text.trim() });
					continue;
				}
				if (entry.type !== "message") continue;
				const msg = entry.message;
				if (msg?.role === "user") {
					let text = "";
					if (Array.isArray(msg.content)) {
						for (const block of msg.content) {
							if (block.type === "text") text += block.text;
						}
					} else if (typeof msg.content === "string") text = msg.content;
					if (text.trim()) messages.push({ role: "user", content: text.trim() });
				} else if (msg?.role === "assistant") {
					let text = "";
					const toolCalls: typeof messages = [];
					if (Array.isArray(msg.content)) {
						for (const block of msg.content) {
							if (block.type === "text") text += block.text;
							else if (block.type === "tool_use") {
								toolCalls.push({
									role: "tool",
									content: JSON.stringify(block.input || {}, null, 2).slice(0, 300),
									toolName: block.name,
								});
							}
						}
					} else if (typeof msg.content === "string") text = msg.content;
					messages.push(...toolCalls);
					if (text.trim()) messages.push({ role: "assistant", content: text.trim() });
				}
			} catch {}
		}
	} catch {}
	return messages;
}

function getDirEntries(dir: string) {
	try {
		return readdirSync(dir)
			.filter((f) => !f.startsWith(".") && f !== "node_modules" && f !== "__pycache__")
			.map((f) => {
				try {
					const stat = statSync(join(dir, f));
					return {
						name: f,
						isDir: stat.isDirectory(),
						size: stat.isDirectory() ? "" : formatSize(stat.size),
						path: join(dir, f),
					};
				} catch {
					return { name: f, isDir: false, size: "", path: join(dir, f) };
				}
			})
			.sort((a, b) => {
				if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
				return a.name.localeCompare(b.name);
			});
	} catch {
		return [];
	}
}

function formatSize(bytes: number): string {
	if (bytes < 1024) return `${bytes}B`;
	if (bytes < 1048576) return `${(bytes / 1024).toFixed(0)}K`;
	return `${(bytes / 1048576).toFixed(1)}M`;
}

/** Escape non-ASCII chars to \uXXXX so only ASCII bytes pass through Glimpse's
 *  Windows webview bridge — prevents UTF-8 → CP1252 mojibake (e.g. — → ΓÇö). */
function escapeNonAscii(str: string): string {
	return str.replace(/[^\x00-\x7F]/g, (ch) => `\\u${ch.charCodeAt(0).toString(16).padStart(4, "0")}`);
}

// ─── HTML Builder ────────────────────────────────────────────

interface DesktopWindowData {
	projectName: string;
	gitBranch: string | null;
	model: string;
	thinkingLevel: string;
	provider: string;
	cwd: string;
	stats: { input: number; output: number; cache: number; cost: number };
	threads: Array<{ name: string; file: string; date: string }>;
	skills: Array<{ name: string; desc: string }>;
	extensions: Array<{ name: string; source: string; type: string }>;
	workspaces: Array<{ name: string; path: string; dirName: string; sessionCount: number; lastActive: string }>;
	messages: Array<{ role: string; content: string; toolName?: string }>;
	explorerFiles: Array<{ name: string; isDir: boolean; size: string; path: string }>;
	commands: Array<{ name: string; description: string; source: string; scope: string; path: string }>;
	hiddenWorkspaces: Record<string, boolean>;
}

function buildDesktopHtml(data: DesktopWindowData): string {
	const templateHtml = readFileSync(join(webDir, "index.html"), "utf8");
	const appJs = readFileSync(join(webDir, "app.js"), "utf8");

	// Base64-encode JSON to avoid Glimpse webview bridge corruption.
	// The bridge (about:blank + WebView2 on Windows) can corrupt control characters
	// and \uXXXX escapes during transfer. Base64 is pure alphanumeric + /+= and
	// survives any encoding conversion.
	const rawJson = JSON.stringify(data);
	const base64Json = Buffer.from(rawJson, "utf8").toString("base64");

	// Use split+join instead of .replace() to avoid $-pattern interpretation
	let result = templateHtml.split("__INLINE_DATA__").join(base64Json);
	result = result.split("__INLINE_JS__").join(appJs);
	return result;
}

// ─── Extension Entry Point ───────────────────────────────────

export default function desktopTuiExtension(pi: ExtensionAPI) {
	let projectName = "";
	let gitBranch: string | null = null;
	let activeWindow: GlimpseWindow | null = null;
	let lastCtx: ExtensionContext | null = null;
	let activeExplorerCwd: string | null = null; // override CWD when viewing another workspace
	let sessionReason: string = "startup";
	let planMode: boolean = false;

	const PLAN_MODE_PREFIX = `[PLAN MODE ACTIVE — You are in read-only plan mode. STRICT RULES:
1. Do NOT use edit, write, or any tool that modifies files
2. Do NOT run bash commands that create, modify, or delete files (no mkdir, rm, mv, cp, touch, tee, sed -i, etc.)
3. ONLY use: read, grep, find, ls, parallel_search, parallel_research, parallel_extract, todo, subagent (scout only)
4. Safe bash allowed: git log, git diff, git status, cat, head, tail, wc, echo, pwd, env, which, type
5. Focus on: reading code, analyzing architecture, creating plans, reviewing scaffolding, identifying patterns
6. If the user asks you to write or edit, remind them Plan Mode is active and suggest they turn it off first]

`;

	// ─── Window Communication ─────────────────────────────────

	function sendToWindow(message: any): void {
		if (!activeWindow) return;
		try {
			// Double-stringify: JSON.stringify creates a safe JS string literal,
			// JSON.parse in the webview decodes it. escapeNonAscii ensures only
			// ASCII bytes pass through Glimpse's send() — prevents UTF-8 → CP1252
			// mojibake on Windows (e.g. em dash — rendered as ΓÇö).
			const jsonStr = JSON.stringify(message);
			const js = `window.__desktopReceive(JSON.parse(${JSON.stringify(jsonStr)}))`;
			activeWindow.send(escapeNonAscii(js));
		} catch {}
	}

	function closeActiveWindow(): void {
		if (activeWindow == null) return;
		const w = activeWindow;
		activeWindow = null;
		try {
			w.close();
		} catch {}
		// Clear custom thinking label when desktop window closes
		try {
			lastCtx?.ui?.setHiddenThinkingLabel?.(undefined as any);
		} catch {}
	}

	// ─── Streaming Event Handlers (global) ────────────────────

	pi.on("agent_start", (_event, _ctx) => {
		sendToWindow({ type: "agent-start" });
	});

	pi.on("agent_end", (_event, ctx) => {
		lastCtx = ctx;
		const stats = getTokenStats(ctx);
		sendToWindow({ type: "agent-end" });
		sendToWindow({ type: "stats-update", stats });
	});

	pi.on("message_start", (event, _ctx) => {
		const msg = event.message;
		if (msg.role === "assistant") {
			sendToWindow({ type: "message-start", role: "assistant" });
		}
	});

	pi.on("message_update", (event, _ctx) => {
		const evt = event.assistantMessageEvent as any;
		switch (evt.type) {
			case "text_delta":
				sendToWindow({ type: "message-chunk", text: evt.delta });
				break;
			case "text_start":
				sendToWindow({ type: "message-chunk-start" });
				break;
			case "text_end":
				sendToWindow({ type: "message-chunk-end", content: evt.content });
				break;
			case "thinking_delta":
				sendToWindow({ type: "thinking-chunk", text: evt.delta });
				break;
			case "thinking_start":
				sendToWindow({ type: "thinking-start" });
				break;
			case "thinking_end":
				sendToWindow({ type: "thinking-end" });
				break;
			case "toolcall_start":
				sendToWindow({ type: "toolcall-stream-start", contentIndex: evt.contentIndex });
				break;
			case "toolcall_end":
				sendToWindow({ type: "toolcall-stream-end", contentIndex: evt.contentIndex, toolName: evt.toolCall?.name });
				break;
		}
	});

	pi.on("message_end", (event, ctx) => {
		lastCtx = ctx;
		const msg = event.message;
		if (msg.role === "assistant") {
			let text = "";
			if (Array.isArray(msg.content)) {
				for (const block of msg.content) {
					if ((block as any).type === "text") text += (block as any).text;
				}
			}
			sendToWindow({ type: "message-end", role: "assistant", content: text });
		}
	});

	pi.on("tool_execution_start", (event, _ctx) => {
		// Warn in desktop window if a write tool fires during plan mode
		if (planMode) {
			const writeTools = new Set(["edit", "write", "claude"]);
			if (writeTools.has(event.toolName) || (event.toolName === "bash" && event.args?.command)) {
				sendToWindow({
					type: "plan-mode-violation",
					toolName: event.toolName,
					argsPreview: JSON.stringify(event.args || {}).slice(0, 200),
				});
			}
		}

		// Format args for display
		let argsDisplay = "";
		let editDiffs: Array<{ oldText: string; newText: string }> | null = null;
		let editPath = "";
		try {
			const args = event.args;
			if (event.toolName === "bash" && args?.command) {
				argsDisplay = args.command;
			} else if (event.toolName === "read" && args?.path) {
				argsDisplay = `read ${args.path}` + (args.offset ? ` (offset: ${args.offset})` : "");
			} else if (event.toolName === "edit" && args?.path) {
				editPath = args.path;
				editDiffs = (args.edits || []).map((e: any) => ({
					oldText: e.oldText || "",
					newText: e.newText || "",
				}));
				argsDisplay = `edit ${args.path} (${(args.edits || []).length} edit(s))`;
			} else if (event.toolName === "write" && args?.path) {
				argsDisplay = `write ${args.path}`;
			} else if (event.toolName === "grep" && args?.pattern) {
				argsDisplay = `grep "${args.pattern}"` + (args.path ? ` in ${args.path}` : "");
			} else if (event.toolName === "find" && args?.path) {
				argsDisplay = `find ${args.path}` + (args.glob ? ` -name ${args.glob}` : "");
			} else if (event.toolName === "ls" && args?.path) {
				argsDisplay = `ls ${args.path}`;
			} else {
				argsDisplay = JSON.stringify(args || {}, null, 2).slice(0, 500);
			}
		} catch {
			argsDisplay = "...";
		}

		// For edit tools, encode diffs as a flat base64 string to survive Glimpse bridge
		const editDiffsB64 = editDiffs ? Buffer.from(JSON.stringify(editDiffs)).toString("base64") : "";

		sendToWindow({
			type: "tool-start",
			toolName: event.toolName,
			toolCallId: event.toolCallId,
			argsDisplay,
			editDiffsB64,
			editPath,
		});
	});

	pi.on("before_provider_request", ((event: any, _ctx: ExtensionContext) => {
		// Forward provider request metadata to desktop window for real-time model/provider display
		sendToWindow({
			type: "provider-request",
			model: event.model ?? "",
			provider: event.provider ?? "",
		});
	}) as any);

	pi.on("tool_execution_end", (event, _ctx) => {
		// Extract result text
		let resultText = "";
		try {
			const result = event.result;
			if (typeof result === "string") {
				resultText = result;
			} else if (result?.content) {
				// AgentToolResult has content array
				if (Array.isArray(result.content)) {
					resultText = result.content
						.filter((c: any) => c.type === "text")
						.map((c: any) => c.text)
						.join("\n");
				} else if (typeof result.content === "string") {
					resultText = result.content;
				}
			} else if (result != null) {
				resultText = JSON.stringify(result, null, 2);
			}
		} catch {
			resultText = "(result unavailable)";
		}

		sendToWindow({
			type: "tool-end",
			toolName: event.toolName,
			toolCallId: event.toolCallId,
			isError: event.isError,
			resultText: resultText.slice(0, 3000),
		});
	});

	// NOTE: Removed input mirroring - it caused duplicate messages.
	// The window adds user messages locally when sent from the window.
	// Terminal messages appear via the streaming events (message_start/end).

	// ─── Window Message Handler ───────────────────────────────

	function handleWindowMessage(msg: any): void {
		if (!msg || typeof msg !== "object") return;

		switch (msg.type) {
			case "send-message": {
				const text = (msg.text || "").trim();
				if (!text || text.length > 100_000) break;
				// In plan mode, prepend read-only instruction to every message
				const finalText = planMode ? PLAN_MODE_PREFIX + text : text;
				pi.sendUserMessage(finalText);
				break;
			}

			case "open-thread": {
				if (msg.file && isValidSessionFile(msg.file)) {
					const threadMsgs = extractThreadMessages(msg.file);
					sendToWindow({ type: "thread-messages", messages: threadMsgs, threadIdx: msg.index ?? 0 });
					// Switch explorer CWD when viewing another workspace's thread
					if (msg.workspace && typeof msg.workspace === "string" && msg.workspace !== "__current__") {
						const decodedPath = decodeSessionDirName(msg.workspace);
						if (existsSync(decodedPath)) {
							activeExplorerCwd = decodedPath;
						}
					} else {
						activeExplorerCwd = null; // back to current workspace
					}
				}
				break;
			}

			case "nav": {
				if (msg.action === "explorer") {
					const cwd = activeExplorerCwd || lastCtx?.cwd;
					if (cwd) {
						const files = getDirEntries(cwd);
						sendToWindow({ type: "explorer-data", files });
						sendToWindow({ type: "explorer-tree-children", parentPath: cwd, children: files });
					}
				}
				break;
			}

			case "explorer-tree-expand": {
				// Expand a directory in the sidebar tree
				const explorerCtx = activeExplorerCwd ? { cwd: activeExplorerCwd } : lastCtx;
				if (msg.path && isPathAllowed(msg.path, explorerCtx)) {
					try {
						const stat = statSync(msg.path);
						if (stat.isDirectory()) {
							const children = getDirEntries(msg.path);
							sendToWindow({ type: "explorer-tree-children", parentPath: msg.path, children });
						}
					} catch {}
				}
				break;
			}

			case "explorer-open": {
				const openCtx = activeExplorerCwd ? { cwd: activeExplorerCwd } : lastCtx;
				if (msg.path && isPathAllowed(msg.path, openCtx)) {
					try {
						const stat = statSync(msg.path);
						if (stat.isDirectory()) {
							const files = getDirEntries(msg.path);
							sendToWindow({ type: "explorer-data", files });
						} else if (stat.isFile()) {
							// Images and binaries → open with system default app
							const imageExts = new Set(["png", "jpg", "jpeg", "gif", "bmp", "svg", "webp", "ico", "tiff", "tif"]);
							const binaryExts = new Set([
								"pdf",
								"doc",
								"docx",
								"xls",
								"xlsx",
								"ppt",
								"pptx",
								"zip",
								"tar",
								"gz",
								"exe",
								"dll",
								"so",
								"dylib",
								"mp3",
								"mp4",
								"mov",
								"avi",
								"wav",
							]);
							const ext = extname(msg.path).slice(1).toLowerCase();
							if (imageExts.has(ext) || binaryExts.has(ext)) {
								// Open with system default app
								const escapedPath = msg.path.replace(/"/g, '\\"');
								const cmd =
									process.platform === "win32"
										? `start "" "${escapedPath}"`
										: process.platform === "darwin"
											? `open "${escapedPath}"`
											: `xdg-open "${escapedPath}"`;
								exec(cmd);
							} else {
								// Text file → read and send content
								const MAX_FILE_SIZE = 512 * 1024;
								if (stat.size > MAX_FILE_SIZE) {
									sendToWindow({
										type: "file-content",
										path: msg.path,
										name: basename(msg.path),
										ext,
										content: null,
										error: `File too large (${(stat.size / 1024).toFixed(0)}KB). Max: 512KB.`,
										size: stat.size,
									});
								} else {
									const content = readFileSync(msg.path, "utf8");
									sendToWindow({
										type: "file-content",
										path: msg.path,
										name: basename(msg.path),
										ext,
										content,
										size: stat.size,
									});
								}
							}
						}
					} catch {}
				}
				break;
			}

			case "get-commands": {
				sendToWindow({ type: "commands-list", commands: getAllCommands(pi) });
				break;
			}

			case "get-stats": {
				if (lastCtx) {
					const stats = getTokenStats(lastCtx);
					sendToWindow({ type: "stats-update", stats });
				}
				break;
			}

			case "refresh-threads": {
				if (lastCtx) {
					const sessionFile = (lastCtx.sessionManager as any).getSessionFile?.() ?? null;
					const sessionDir = sessionFile ? join(sessionFile, "..") : null;
					const threads = getSessionThreads(sessionDir).map((t) => ({
						name: t.name,
						file: t.file,
						date: t.date.toISOString(),
					}));
					sendToWindow({ type: "update-threads", threads });
				}
				break;
			}

			case "refresh-skills": {
				const skills = getSkills();
				const extensions = getExtensions();
				sendToWindow({ type: "update-skills", skills, extensions });
				break;
			}

			case "get-workspaces": {
				const wsList = getWorkspaces().map((w) => ({
					...w,
					lastActive: w.lastActive.toISOString(),
				}));
				sendToWindow({ type: "workspaces-list", workspaces: wsList });
				break;
			}

			case "get-workspace-sessions": {
				if (msg.dirName) {
					const sessions = getWorkspaceSessions(msg.dirName).map((t) => ({
						name: t.name,
						file: t.file,
						date: t.date.toISOString(),
					}));
					sendToWindow({ type: "workspace-sessions", dirName: msg.dirName, sessions });
				}
				break;
			}

			case "search-threads": {
				if (msg.query && typeof msg.query === "string" && msg.query.length >= 2 && msg.query.length <= 200) {
					const query = msg.query;
					const allResults: Array<{
						name: string;
						file: string;
						date: string;
						matchSnippet: string;
						workspace: string;
					}> = [];

					// Search current workspace
					if (lastCtx) {
						const sessionFile = (lastCtx.sessionManager as any).getSessionFile?.() ?? null;
						const sessionDir = sessionFile ? join(sessionFile, "..") : null;
						const results = searchSessionThreads(sessionDir, query);
						for (const r of results) {
							allResults.push({
								name: r.name,
								file: r.file,
								date: r.date.toISOString(),
								matchSnippet: r.matchSnippet,
								workspace: "__current__",
							});
						}
					}

					// Search other workspaces
					const home = process.env.HOME || process.env.USERPROFILE || "";
					const sessionsRoot = join(home, ".pi", "agent", "sessions");
					const cwd = lastCtx ? (lastCtx as any).cwd || "" : "";
					const workspaces = getWorkspaces().filter((w) => w.path !== cwd);
					for (const ws of workspaces) {
						const wsDir = join(sessionsRoot, ws.dirName);
						const results = searchSessionThreads(wsDir, query);
						for (const r of results) {
							allResults.push({
								name: r.name,
								file: r.file,
								date: r.date.toISOString(),
								matchSnippet: r.matchSnippet,
								workspace: ws.dirName,
							});
						}
					}

					sendToWindow({ type: "search-results", query, results: allResults });
				}
				break;
			}

			case "open-folder-path": {
				if (msg.path && typeof msg.path === "string" && msg.path.length < 1000) {
					// Reject path traversal attempts
					if (msg.path.includes("..")) break;

					const folderPath = msg.path.replace(/\\/g, "/").replace(/\/$/, "");
					// Encode path to session dir name format
					const safePath = `--${folderPath.replace(/^\//, "").replace(/[\/\\:]/g, "-")}--`;
					const home = process.env.HOME || process.env.USERPROFILE || "";
					const sessionsRoot = join(home, ".pi", "agent", "sessions");
					const sessionDir = join(sessionsRoot, safePath);

					// Verify the session dir is actually under sessions root (prevent traversal via crafted safePath)
					const resolvedSessionDir = resolve(normalize(sessionDir));
					const resolvedSessionsRoot = resolve(sessionsRoot);
					if (
						!resolvedSessionDir.startsWith(resolvedSessionsRoot + "/") &&
						!resolvedSessionDir.startsWith(resolvedSessionsRoot + "\\")
					)
						break;

					if (existsSync(sessionDir)) {
						// Workspace exists - expand it in sidebar
						const sessions = getSessionThreads(sessionDir).map((t) => ({
							name: t.name,
							file: t.file,
							date: t.date.toISOString(),
						}));
						sendToWindow({ type: "workspace-opened", dirName: safePath, path: msg.path, sessions });
					} else {
						// No sessions for this path yet
						sendToWindow({ type: "workspace-opened", dirName: safePath, path: msg.path, sessions: [] });
					}
				}
				break;
			}

			case "set-plan-mode": {
				planMode = msg.active === true;
				if (lastCtx) {
					lastCtx.ui.notify(
						planMode
							? "Plan Mode ON — pi will only read, search, and analyze. No writes."
							: "Plan Mode OFF — full access restored.",
						"info",
					);
				}
				break;
			}

			case "close": {
				closeActiveWindow();
				break;
			}

			case "attach-file": {
				const name = msg.name || "file";
				const mimeType = msg.mimeType || "application/octet-stream";
				const base64 = msg.base64;
				if (!base64) break;

				// Reject oversized attachments (base64 is ~4/3 of original)
				if (base64.length > MAX_ATTACH_SIZE * 1.37) {
					sendToWindow({ type: "file-attached-ack", path: "", name, error: "File too large (max 25MB)" });
					break;
				}

				try {
					const ext =
						extname(name) || (mimeType.startsWith("image/") ? "." + (mimeType.split("/")[1] || "png") : ".bin");
					// Sanitize filename: strip path separators, restrict to safe characters
					const safeExt = ext.replace(/[^a-zA-Z0-9.]/g, "").slice(0, 10);
					const fileName = `pi-attach-${randomUUID()}${safeExt}`;
					const filePath = join(tmpdir(), fileName);
					writeFileSync(filePath, Buffer.from(base64, "base64"));
					sendToWindow({ type: "file-attached-ack", path: filePath, name });
				} catch (e) {
					sendToWindow({ type: "file-attached-ack", path: "", name, error: String(e) });
				}
				break;
			}

			case "cancel-streaming": {
				if (lastCtx && !lastCtx.isIdle()) {
					lastCtx.abort();
				}
				break;
			}

			case "set-hidden-workspaces": {
				if (msg.hiddenWorkspaces && typeof msg.hiddenWorkspaces === "object") {
					// Validate shape: must be Record<string, boolean> — reject anything else
					const sanitized: Record<string, boolean> = {};
					for (const [key, val] of Object.entries(msg.hiddenWorkspaces)) {
						if (typeof key === "string" && typeof val === "boolean" && key.length < 500) {
							sanitized[key] = val;
						}
					}
					saveHiddenWorkspaces(sanitized);
				}
				break;
			}
		}
	}

	// ─── Open Window ──────────────────────────────────────────

	function collectWindowData(ctx: ExtensionContext): DesktopWindowData {
		const stats = getTokenStats(ctx);
		const model = ctx.model?.id || "no-model";
		const thinkingLevel = pi.getThinkingLevel();
		const sessionFile = (ctx.sessionManager as any).getSessionFile?.() ?? null;
		const sessionDir = sessionFile ? join(sessionFile, "..") : null;
		const threads = getSessionThreads(sessionDir).map((t) => ({
			name: t.name,
			file: t.file,
			date: t.date.toISOString(),
		}));
		const skills = getSkills();
		const extensions = getExtensions();
		const allWorkspaces = getWorkspaces().map((w) => ({
			...w,
			lastActive: w.lastActive.toISOString(),
		}));
		const messages = extractSessionMessages(ctx);
		const explorerFiles = getDirEntries(ctx.cwd);
		const commands = getAllCommands(pi);

		return {
			projectName,
			gitBranch,
			model,
			thinkingLevel,
			provider: (ctx.model as any)?.provider || "unknown",
			cwd: ctx.cwd,
			stats,
			threads,
			skills,
			extensions,
			workspaces: allWorkspaces,
			messages,
			explorerFiles,
			commands,
			hiddenWorkspaces: loadHiddenWorkspaces(),
		};
	}

	function openDesktopWindow(ctx: ExtensionContext): void {
		if (activeWindow != null) {
			ctx.ui.notify("Desktop window is already open.", "warning");
			return;
		}

		lastCtx = ctx;
		const data = collectWindowData(ctx);
		const html = buildDesktopHtml(data);
		const win = open(html, {
			width: 1400,
			height: 900,
			title: "pi Desktop",
		});
		activeWindow = win;

		// Customize thinking block label while desktop window is open (v0.64.0)
		try {
			ctx.ui.setHiddenThinkingLabel?.("thinking (visible in Desktop ◈)");
		} catch {}

		win.on("message", handleWindowMessage);
		win.on("closed", () => {
			if (activeWindow === win) activeWindow = null;
		});
		win.on("error", () => {
			if (activeWindow === win) activeWindow = null;
		});

		ctx.ui.notify("Pi Desktop window opened. Chat from here or the window — both are synced.", "info");
	}

	// ─── CLI Flag ─────────────────────────────────────────────

	pi.registerFlag("desktop", {
		description: "Auto-open Pi Desktop UI on startup",
		type: "boolean",
		default: false,
	});

	// ─── Commands ─────────────────────────────────────────────

	pi.registerCommand("desktop", {
		description: "Open pi Desktop window (fully functional chat UI)",
		handler: async (_args, ctx) => {
			openDesktopWindow(ctx);
		},
	});

	// ─── Keyboard Shortcut ────────────────────────────────────

	pi.registerShortcut(Key.ctrlAlt("n"), {
		description: "Open pi Desktop window",
		handler: async (ctx) => {
			openDesktopWindow(ctx);
		},
	});

	// ─── Session Lifecycle ────────────────────────────────────

	// Unified session lifecycle — v0.65.0 removed session_switch and session_fork.
	// Use session_start with event.reason ("startup" | "reload" | "new" | "resume" | "fork").
	pi.on("session_start", async (event, ctx) => {
		if (!ctx.hasUI) return;

		const reason = (event as any).reason || "startup";
		const previousSessionFile = (event as any).previousSessionFile || null;
		sessionReason = reason;

		projectName = getProjectName(ctx.cwd);
		gitBranch = getGitBranch(ctx.cwd);
		lastCtx = ctx;
		ctx.ui.setStatus("desktop", undefined);

		// Notify desktop window of session change with reason context
		if (reason !== "startup") {
			const messages = extractSessionMessages(ctx);
			const stats = getTokenStats(ctx);
			sendToWindow({
				type: "session-changed",
				reason,
				previousSessionFile,
				projectName,
				model: ctx.model?.id || "no-model",
				messages,
				stats,
			});
		}

		// Auto-open desktop window if --desktop flag or PI_DESKTOP env is set
		if (reason === "startup") {
			const desktopFlag = pi.getFlag("desktop");
			const desktopEnv = process.env.PI_DESKTOP === "1";
			if (desktopFlag || desktopEnv) {
				setTimeout(() => openDesktopWindow(ctx), 500);
			}
		}
	});

	pi.on("session_shutdown", async () => {
		closeActiveWindow();
	});
}
