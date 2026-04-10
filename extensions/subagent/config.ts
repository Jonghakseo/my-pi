import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAgentDir } from "@mariozechner/pi-coding-agent";

export type ClaudeRuntimeMode = "sdk" | "cli";

export interface SubagentConfig {
	claudeRuntime: ClaudeRuntimeMode;
}

interface RawSubagentConfig {
	claudeRuntime?: unknown;
}

interface RawSettingsFile extends RawSubagentConfig {
	subagent?: RawSubagentConfig;
}

interface LoadSubagentConfigOptions {
	globalPath?: string | null;
	projectPath?: string | null;
}

const DEFAULT_CONFIG: SubagentConfig = {
	claudeRuntime: "sdk",
};

function isFile(filePath: string): boolean {
	try {
		return statSync(filePath).isFile();
	} catch {
		return false;
	}
}

function normalizeClaudeRuntime(value: unknown): ClaudeRuntimeMode | undefined {
	return value === "cli" || value === "sdk" ? value : undefined;
}

function extractSubagentConfig(value: unknown): RawSubagentConfig {
	if (typeof value !== "object" || !value) return {};
	const parsed = value as RawSettingsFile;
	if (typeof parsed.subagent === "object" && parsed.subagent) return parsed.subagent;
	return parsed;
}

function readConfigFile(filePath: string | null | undefined): RawSubagentConfig {
	if (!filePath || !existsSync(filePath) || !isFile(filePath)) return {};

	try {
		const raw = readFileSync(filePath, "utf-8");
		return extractSubagentConfig(JSON.parse(raw) as unknown);
	} catch {
		return {};
	}
}

export function findNearestProjectSubagentConfig(cwd: string): string | null {
	let currentDir = cwd;

	while (true) {
		const candidate = join(currentDir, ".pi", "subagent.json");
		if (isFile(candidate)) return candidate;

		const parentDir = dirname(currentDir);
		if (parentDir === currentDir) return null;
		currentDir = parentDir;
	}
}

export function loadSubagentConfig(cwd: string, options: LoadSubagentConfigOptions = {}): SubagentConfig {
	const globalPath = options.globalPath === undefined ? join(getAgentDir(), "settings.json") : options.globalPath;
	const projectPath = options.projectPath === undefined ? findNearestProjectSubagentConfig(cwd) : options.projectPath;

	const globalConfig = readConfigFile(globalPath);
	const projectConfig = readConfigFile(projectPath);
	const claudeRuntime =
		normalizeClaudeRuntime(projectConfig.claudeRuntime) ??
		normalizeClaudeRuntime(globalConfig.claudeRuntime) ??
		DEFAULT_CONFIG.claudeRuntime;

	return {
		claudeRuntime,
	};
}

export function resolveClaudeRuntimeMode(cwd: string, options?: LoadSubagentConfigOptions): ClaudeRuntimeMode {
	return loadSubagentConfig(cwd, options).claudeRuntime;
}
