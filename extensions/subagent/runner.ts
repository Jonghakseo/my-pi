/**
 * Subagent process execution and result processing.
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import type { Message } from "@mariozechner/pi-ai";
import type { AgentConfig } from "./agents.js";
import { formatToolCallPlain } from "./format.js";
import { writePromptToTempFile } from "./session.js";
import type { AgentAliasMatch, DisplayItem, OnUpdateCallback, SingleResult, SubagentDetails } from "./types.js";

// ─── Result Helpers ──────────────────────────────────────────────────────────

export function getLastNonEmptyLine(text: string): string {
	return (
		text
			.split("\n")
			.map((line) => line.trim())
			.filter(Boolean)
			.pop() ?? ""
	);
}

export function getFinalOutput(messages: Message[]): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (msg.role === "assistant") {
			for (const part of msg.content) {
				if (part.type === "text") return part.text;
			}
		}
	}
	return "";
}

export function getDisplayItems(messages: Message[]): DisplayItem[] {
	const items: DisplayItem[] = [];
	for (const msg of messages) {
		if (msg.role === "assistant") {
			for (const part of msg.content) {
				if (part.type === "text") items.push({ type: "text", text: part.text });
				else if (part.type === "toolCall") items.push({ type: "toolCall", name: part.name, args: part.arguments });
			}
		}
	}
	return items;
}

export function getLatestActivityPreview(messages: Message[]): string | undefined {
	const items = getDisplayItems(messages);
	if (items.length === 0) return undefined;

	const lastItem = items[items.length - 1];
	if (lastItem.type === "toolCall") return `→ ${formatToolCallPlain(lastItem.name, lastItem.args)}`;

	const line = getLastNonEmptyLine(lastItem.text);
	return line || undefined;
}

// ─── Agent Matching ──────────────────────────────────────────────────────────

function normalizeAgentAlias(value: string): string {
	return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/**
 * Extract initials from agent name parts.
 * "finder" → "f", "reviewer" → "r", "verifier" → "v", "worker" → "w"
 */
function getAgentInitials(name: string): string {
	return name
		.toLowerCase()
		.split(/[^a-z0-9]+/)
		.filter(Boolean)
		.map((part) => part[0])
		.join("");
}

function uniqueAgentsByName(candidates: AgentConfig[]): AgentConfig[] {
	const map = new Map<string, AgentConfig>();
	for (const agent of candidates) {
		if (!map.has(agent.name)) map.set(agent.name, agent);
	}
	return Array.from(map.values());
}

export function matchSubCommandAgent(agents: AgentConfig[], token: string): AgentAliasMatch {
	const raw = token.trim().toLowerCase();
	if (!raw) return { ambiguousAgents: [] };

	const normalized = normalizeAgentAlias(raw);

	const exact = uniqueAgentsByName(
		agents.filter((agent) => {
			const name = agent.name.toLowerCase();
			if (name === raw) return true;
			if (normalized && normalizeAgentAlias(name) === normalized) return true;
			return false;
		}),
	);
	if (exact.length === 1) return { matchedAgent: exact[0], ambiguousAgents: [] };
	if (exact.length > 1) return { ambiguousAgents: exact };

	const prefix = uniqueAgentsByName(
		agents.filter((agent) => {
			const name = agent.name.toLowerCase();
			const nameNormalized = normalizeAgentAlias(name);
			const parts = name.split(/[^a-z0-9]+/).filter(Boolean);
			if (name.startsWith(raw)) return true;
			if (normalized && nameNormalized.startsWith(normalized)) return true;
			if (parts.some((part) => part.startsWith(raw))) return true;
			if (normalized && parts.some((part) => normalizeAgentAlias(part).startsWith(normalized))) return true;
			return false;
		}),
	);
	if (prefix.length === 1) return { matchedAgent: prefix[0], ambiguousAgents: [] };
	if (prefix.length > 1) return { ambiguousAgents: prefix };

	// Initials match: "f" → finder, "r" → reviewer, "v" → verifier
	const initialsMatch = uniqueAgentsByName(
		agents.filter((agent) => {
			const agentInitials = getAgentInitials(agent.name);
			return normalized === agentInitials;
		}),
	);
	if (initialsMatch.length === 1) return { matchedAgent: initialsMatch[0], ambiguousAgents: [] };
	if (initialsMatch.length > 1) return { ambiguousAgents: initialsMatch };

	const contains = uniqueAgentsByName(
		agents.filter((agent) => {
			const name = agent.name.toLowerCase();
			const nameNormalized = normalizeAgentAlias(name);
			if (name.includes(raw)) return true;
			if (normalized && nameNormalized.includes(normalized)) return true;
			return false;
		}),
	);
	if (contains.length === 1) return { matchedAgent: contains[0], ambiguousAgents: [] };
	if (contains.length > 1) return { ambiguousAgents: contains };

	return { ambiguousAgents: [] };
}

export function getSubCommandAgentCompletions(
	agents: AgentConfig[],
	argumentPrefix: string,
): { value: string; label: string; description?: string }[] | null {
	const trimmedStart = argumentPrefix.trimStart();
	if (trimmedStart.includes(" ")) return null;

	const raw = trimmedStart.toLowerCase();
	const normalized = normalizeAgentAlias(raw);

	const scored = agents
		.map((agent) => {
			const name = agent.name.toLowerCase();
			const nameNormalized = normalizeAgentAlias(name);
			const parts = name.split(/[^a-z0-9]+/).filter(Boolean);

			const agentInitials = getAgentInitials(name);

			let score = Number.POSITIVE_INFINITY;
			if (!raw) score = 100;
			else if (name === raw || (normalized && nameNormalized === normalized)) score = 0;
			else if (name.startsWith(raw) || (normalized && nameNormalized.startsWith(normalized))) score = 1;
			else if (
				parts.some((part) => part.startsWith(raw)) ||
				(normalized && parts.some((part) => normalizeAgentAlias(part).startsWith(normalized)))
			)
				score = 2;
			else if (normalized && agentInitials === normalized) score = 3;
			else if (name.includes(raw) || (normalized && nameNormalized.includes(normalized))) score = 4;

			return { agent, score };
		})
		.filter((row) => Number.isFinite(row.score))
		.sort((a, b) => a.score - b.score || a.agent.name.localeCompare(b.agent.name))
		.slice(0, 20)
		.map(({ agent }) => ({
			value: `${agent.name} `,
			label: agent.name,
			description: agent.description || `[${agent.source}]`,
		}));

	return scored.length > 0 ? scored : null;
}

/**
 * Compute shortest usable alias for each agent and return a formatted hint string.
 * e.g. "f→finder  w→worker  s→searcher  p→planner  r→reviewer  v→verifier"
 */
export function computeAgentAliasHints(agents: AgentConfig[]): string {
	const hints: string[] = [];

	for (const agent of agents) {
		const name = agent.name.toLowerCase();
		const initials = getAgentInitials(name);

		// Find shortest unique name-prefix via matchSubCommandAgent
		let shortestAlias = name;
		for (let i = 1; i <= name.length; i++) {
			const candidate = name.slice(0, i);
			const result = matchSubCommandAgent(agents, candidate);
			if (result.matchedAgent?.name === agent.name) {
				shortestAlias = candidate;
				break;
			}
		}

		// Try initials — prefer for multi-word agents when equally short or shorter
		if (initials.length >= 2 && initials.length <= shortestAlias.length) {
			const result = matchSubCommandAgent(agents, initials);
			if (result.matchedAgent?.name === agent.name) {
				shortestAlias = initials;
			}
		}

		hints.push(shortestAlias === name ? name : `${shortestAlias}→${name}`);
	}

	return hints.join("  ");
}

// ─── Concurrency ─────────────────────────────────────────────────────────────

export async function mapWithConcurrencyLimit<TIn, TOut>(
	items: TIn[],
	concurrency: number,
	fn: (item: TIn, index: number) => Promise<TOut>,
): Promise<TOut[]> {
	if (items.length === 0) return [];
	const limit = Math.max(1, Math.min(concurrency, items.length));
	const results: TOut[] = new Array(items.length);
	let nextIndex = 0;
	const workers = new Array(limit).fill(null).map(async () => {
		while (true) {
			const current = nextIndex++;
			if (current >= items.length) return;
			results[current] = await fn(items[current], current);
		}
	});
	await Promise.all(workers);
	return results;
}

// ─── Single Agent Execution ──────────────────────────────────────────────────

export async function runSingleAgent(
	defaultCwd: string,
	agents: AgentConfig[],
	agentName: string,
	task: string,
	cwd: string | undefined,
	step: number | undefined,
	signal: AbortSignal | undefined,
	onUpdate: OnUpdateCallback | undefined,
	makeDetails: (results: SingleResult[]) => SubagentDetails,
	sessionFile?: string,
): Promise<SingleResult> {
	const agent = agents.find((a) => a.name === agentName);

	if (!agent) {
		const available = agents.map((a) => `"${a.name}"`).join(", ") || "none";
		return {
			agent: agentName,
			agentSource: "unknown",
			task,
			exitCode: 1,
			messages: [],
			stderr: `Unknown agent: "${agentName}". Available agents: ${available}.`,
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
			step,
		};
	}

	const args: string[] = ["--mode", "json", "-p"];
	if (sessionFile) args.push("--session", sessionFile);
	else args.push("--no-session");
	if (agent.model) args.push("--model", agent.model);
	if (agent.tools && agent.tools.length > 0) args.push("--tools", agent.tools.join(","));

	let tmpPromptDir: string | null = null;
	let tmpPromptPath: string | null = null;

	const currentResult: SingleResult = {
		agent: agentName,
		agentSource: agent.source,
		task,
		exitCode: 0,
		messages: [],
		stderr: "",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
		model: agent.model,
		step,
	};

	const emitUpdate = () => {
		if (onUpdate) {
			onUpdate({
				content: [
					{ type: "text", text: getFinalOutput(currentResult.messages) || currentResult.liveText || "(running...)" },
				],
				details: makeDetails([currentResult]),
			});
		}
	};

	try {
		if (agent.systemPrompt.trim()) {
			const tmp = writePromptToTempFile(agent.name, agent.systemPrompt);
			tmpPromptDir = tmp.dir;
			tmpPromptPath = tmp.filePath;
			args.push("--append-system-prompt", tmpPromptPath);
		}

		args.push(task);
		let wasAborted = false;

		const exitCode = await new Promise<number>((resolve) => {
			const proc = spawn("pi", args, { cwd: cwd ?? defaultCwd, shell: false, stdio: ["ignore", "pipe", "pipe"] });
			let buffer = "";
			let procExited = false;
			let settled = false;
			let exitFallbackTimer: ReturnType<typeof setTimeout> | undefined;
			let agentEndFallbackTimer: ReturnType<typeof setTimeout> | undefined;
			let lastExitCode = 0;
			let lastEventAt = Date.now();
			let sawAgentEnd = false;

			const processLine = (line: string) => {
				if (!line.trim()) return;
				let event: any;
				try {
					event = JSON.parse(line);
				} catch {
					return;
				}
				lastEventAt = Date.now();

				if (event.type === "agent_start" || event.type === "turn_start") {
					sawAgentEnd = false;
					return;
				}

				if (event.type === "agent_end") {
					sawAgentEnd = true;
					scheduleAgentEndForceResolve();
					return;
				}

				if (event.type === "message_update") {
					const delta = event.assistantMessageEvent;
					if (delta?.type === "text_delta") {
						const chunk = typeof delta.delta === "string" ? delta.delta : "";
						if (chunk) {
							currentResult.liveText = `${currentResult.liveText ?? ""}${chunk}`;
							emitUpdate();
						}
					}
					return;
				}

				if (event.type === "tool_execution_start") {
					currentResult.liveToolCalls = (currentResult.liveToolCalls ?? 0) + 1;
					emitUpdate();
					return;
				}

				if (event.type === "message_end" && event.message) {
					const msg = event.message as Message;
					currentResult.messages.push(msg);

					if (msg.role === "assistant") {
						currentResult.liveText = undefined;
						currentResult.usage.turns++;
						const usage = msg.usage;
						if (usage) {
							currentResult.usage.input += usage.input || 0;
							currentResult.usage.output += usage.output || 0;
							currentResult.usage.cacheRead += usage.cacheRead || 0;
							currentResult.usage.cacheWrite += usage.cacheWrite || 0;
							currentResult.usage.cost += usage.cost?.total || 0;
							currentResult.usage.contextTokens = usage.totalTokens || 0;
						}
						if (!currentResult.model && msg.model) currentResult.model = msg.model;
						if (msg.stopReason) currentResult.stopReason = msg.stopReason;
						if (msg.errorMessage) currentResult.errorMessage = msg.errorMessage;

						// Extract thoughtText from thinking block first line only
						for (const part of msg.content) {
							if (part.type === "thinking") {
								const raw = typeof (part as any).thinking === "string" ? (part as any).thinking : "";
								const firstLine = raw
									.split("\n")
									.map((l: string) => l.trim())
									.filter(Boolean)[0];
								if (firstLine) {
									// Strip markdown: **bold**, *italic*, `code`, # headers
									const clean = firstLine
										.replace(/^#+\s*/, "")
										.replace(/\*{1,3}([^*]+)\*{1,3}/g, "$1")
										.replace(/`([^`]+)`/g, "$1")
										.trim();
									if (clean) currentResult.thoughtText = clean.slice(0, 80);
								}
							}
						}
					}
					emitUpdate();
					if (sawAgentEnd) scheduleAgentEndForceResolve();
					return;
				}

				if (event.type === "tool_result_end" && event.message) {
					currentResult.messages.push(event.message as Message);
					emitUpdate();
					if (sawAgentEnd) scheduleAgentEndForceResolve();
					return;
				}

				if (sawAgentEnd) scheduleAgentEndForceResolve();
			};

			const resolveOnce = (code: number) => {
				if (settled) return;
				settled = true;
				if (exitFallbackTimer) {
					clearTimeout(exitFallbackTimer);
					exitFallbackTimer = undefined;
				}
				if (agentEndFallbackTimer) {
					clearTimeout(agentEndFallbackTimer);
					agentEndFallbackTimer = undefined;
				}
				if (buffer.trim()) processLine(buffer);
				resolve(code);
			};

			// print-mode sometimes keeps the Node process alive after agent_end
			// (e.g. lingering extension timers/transports). In that case, force
			// resolve after a short quiet period so runs do not remain "running" forever.
			function scheduleAgentEndForceResolve() {
				if (!sawAgentEnd || settled || procExited) return;
				if (agentEndFallbackTimer) clearTimeout(agentEndFallbackTimer);

				const marker = lastEventAt;
				agentEndFallbackTimer = setTimeout(() => {
					if (settled || procExited || wasAborted) return;
					if (lastEventAt !== marker) return;

					const forcedCode = currentResult.stopReason === "error" || currentResult.stopReason === "aborted" ? 1 : 0;

					proc.kill("SIGTERM");
					setTimeout(() => {
						if (!procExited && proc.exitCode === null) proc.kill("SIGKILL");
					}, 5000);

					resolveOnce(forcedCode);
				}, 1500);
			}

			proc.stdout.on("data", (data) => {
				buffer += data.toString();
				const lines = buffer.split("\n");
				buffer = lines.pop() || "";
				for (const line of lines) processLine(line);
			});

			proc.stderr.on("data", (data) => {
				currentResult.stderr += data.toString();
			});

			proc.on("exit", (code) => {
				procExited = true;
				lastExitCode = code ?? 0;
				// In rare cases stdout/stderr pipes may stay open after process exit.
				// Use a short fallback so runs cannot stay "running" forever.
				exitFallbackTimer = setTimeout(() => resolveOnce(lastExitCode), 1500);
			});

			proc.on("close", (code) => {
				procExited = true;
				resolveOnce(code ?? lastExitCode ?? 0);
			});

			proc.on("error", () => {
				procExited = true;
				resolveOnce(1);
			});

			if (signal) {
				const killProc = () => {
					wasAborted = true;
					proc.kill("SIGTERM");
					setTimeout(() => {
						if (!procExited && proc.exitCode === null) proc.kill("SIGKILL");
					}, 5000);
				};
				if (signal.aborted) killProc();
				else signal.addEventListener("abort", killProc, { once: true });
			}
		});

		currentResult.exitCode = exitCode;
		if (wasAborted) throw new Error("Subagent was aborted");
		return currentResult;
	} finally {
		if (tmpPromptPath)
			try {
				fs.unlinkSync(tmpPromptPath);
			} catch {
				/* ignore */
			}
		if (tmpPromptDir)
			try {
				fs.rmdirSync(tmpPromptDir);
			} catch {
				/* ignore */
			}
	}
}
