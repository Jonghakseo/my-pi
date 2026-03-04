/**
 * Agent discovery and configuration
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { parseFrontmatter } from "@mariozechner/pi-coding-agent";
import {
	AGENT_THINKING_LEVELS,
	normalizeModel,
	normalizeThinkingLevel,
	normalizeTools,
	type AgentThinkingLevel,
} from "../utils/agent-utils.js";

export const THINKING_LEVELS = AGENT_THINKING_LEVELS;

export interface AgentConfig {
	name: string;
	description: string;
	tools?: string[];
	model?: string;
	thinking?: AgentThinkingLevel;
	systemPrompt: string;
	source: "user" | "project";
	filePath: string;
	/** Pixel art character for the above-editor widget (e.g. "fox", "blue-slime"). */
	character?: string;
}

export interface AgentDiscoveryResult {
	agents: AgentConfig[];
	projectAgentsDir: string | null;
}

interface LoadAgentsOptions {
	recursive?: boolean;
	format?: "pi" | "claude";
}

const COMMON_SUBAGENT_NO_RECURSION_RULE = [
	"Global Runtime Rule (subagent):",
	"- Never invoke the `subagent` tool.",
	"- Never trigger subagent commands/shorthands such as `/sub:*` or `>>` or `>>>`.",
	"- If delegation is requested, explain that recursive subagent invocation is disabled and continue with available tools.",
].join("\n");

function attachCommonSubagentRule(systemPrompt: string): string {
	const trimmed = systemPrompt.trimEnd();
	if (trimmed.includes("Global Runtime Rule (subagent):")) return trimmed;
	return trimmed ? `${trimmed}\n\n${COMMON_SUBAGENT_NO_RECURSION_RULE}` : COMMON_SUBAGENT_NO_RECURSION_RULE;
}

function listMarkdownFiles(dir: string, recursive: boolean): string[] {
	const files: string[] = [];
	const stack: string[] = [dir];

	while (stack.length > 0) {
		const currentDir = stack.pop() as string;
		let entries: fs.Dirent[];
		try {
			entries = fs.readdirSync(currentDir, { withFileTypes: true });
		} catch {
			continue;
		}

		for (const entry of entries) {
			const fullPath = path.join(currentDir, entry.name);
			if (entry.isDirectory()) {
				if (recursive) stack.push(fullPath);
				continue;
			}

			if (!entry.name.endsWith(".md")) continue;
			if (!entry.isFile() && !entry.isSymbolicLink()) continue;
			files.push(fullPath);
		}
	}

	files.sort((a, b) => a.localeCompare(b));
	return files;
}

function loadAgentsFromDir(dir: string, source: "user" | "project", options: LoadAgentsOptions = {}): AgentConfig[] {
	const agents: AgentConfig[] = [];
	const recursive = options.recursive ?? false;
	const format = options.format ?? "pi";

	if (!fs.existsSync(dir)) {
		return agents;
	}

	const files = listMarkdownFiles(dir, recursive);
	for (const filePath of files) {
		let content: string;
		try {
			content = fs.readFileSync(filePath, "utf-8");
		} catch {
			continue;
		}

		const { frontmatter, body } = parseFrontmatter<Record<string, string>>(content);
		if (!frontmatter.name || !frontmatter.description) continue;

		const tools = normalizeTools(frontmatter.tools, format);
		const model = normalizeModel(frontmatter.model, format);
		const thinking = normalizeThinkingLevel(frontmatter.thinking);

		agents.push({
			name: frontmatter.name,
			description: frontmatter.description,
			tools,
			model,
			thinking,
			systemPrompt: attachCommonSubagentRule(body),
			source,
			filePath,
			character: frontmatter.character || undefined,
		});
	}

	return agents;
}

function isDirectory(p: string): boolean {
	try {
		return fs.statSync(p).isDirectory();
	} catch {
		return false;
	}
}

function findNearestProjectAgentsDir(cwd: string): string | null {
	let currentDir = cwd;
	while (true) {
		const candidate = path.join(currentDir, ".pi", "agents");
		if (isDirectory(candidate)) return candidate;

		const parentDir = path.dirname(currentDir);
		if (parentDir === currentDir) return null;
		currentDir = parentDir;
	}
}

function findNearestClaudeAgentsDir(cwd: string): string | null {
	let currentDir = cwd;
	while (true) {
		const candidate = path.join(currentDir, ".claude", "agents");
		if (isDirectory(candidate)) return candidate;

		const parentDir = path.dirname(currentDir);
		if (parentDir === currentDir) return null;
		currentDir = parentDir;
	}
}

export function discoverAgents(cwd: string): AgentDiscoveryResult {
	const userDir = path.join(os.homedir(), ".pi", "agent", "agents");
	const projectAgentsDir = findNearestProjectAgentsDir(cwd);
	const claudeAgentsDir = findNearestClaudeAgentsDir(cwd);

	const userAgents = loadAgentsFromDir(userDir, "user", { format: "pi" });
	const projectPiAgents = projectAgentsDir ? loadAgentsFromDir(projectAgentsDir, "project", { format: "pi" }) : [];
	const projectClaudeAgents = claudeAgentsDir
		? loadAgentsFromDir(claudeAgentsDir, "project", { format: "claude", recursive: true })
		: [];

	// 우선순위: user < .claude/agents < .pi/agents
	const projectAgents = [...projectClaudeAgents, ...projectPiAgents];

	const agentMap = new Map<string, AgentConfig>();
	for (const agent of userAgents) agentMap.set(agent.name, agent);
	for (const agent of projectAgents) agentMap.set(agent.name, agent);

	const projectSources = [projectAgentsDir, claudeAgentsDir].filter((dir): dir is string => Boolean(dir));

	return {
		agents: Array.from(agentMap.values()),
		projectAgentsDir: projectSources.length > 0 ? projectSources.join(", ") : null,
	};
}

export function formatAgentList(agents: AgentConfig[], maxItems: number): { text: string; remaining: number } {
	if (agents.length === 0) return { text: "none", remaining: 0 };
	const listed = agents.slice(0, maxItems);
	const remaining = agents.length - listed.length;
	return {
		text: listed.map((a) => `${a.name} (${a.source}): ${a.description}`).join("; "),
		remaining,
	};
}
