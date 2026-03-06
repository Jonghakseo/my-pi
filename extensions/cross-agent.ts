/**
 * Cross-Agent — Load commands, skills, and agents from other AI coding agents
 *
 * Scans .claude/, .gemini/, .codex/ directories (project + global) for:
 *   commands/*.md  → registered as /name
 *   skills/        → listed as /skill:name (discovery only)
 *   agents/*.md    → listed as @name (discovery only)
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

// --- Synthwave palette ---
function _bg(s: string): string {
	return `\x1b[48;2;52;20;58m${s}\x1b[49m`;
}
function _pink(s: string): string {
	return `\x1b[38;2;255;126;219m${s}\x1b[39m`;
}
function _cyan(s: string): string {
	return `\x1b[38;2;54;249;246m${s}\x1b[39m`;
}
function _green(s: string): string {
	return `\x1b[38;2;114;241;184m${s}\x1b[39m`;
}
function _yellow(s: string): string {
	return `\x1b[38;2;254;222;93m${s}\x1b[39m`;
}
function _dim(s: string): string {
	return `\x1b[38;2;120;100;140m${s}\x1b[39m`;
}
function _bold(s: string): string {
	return `\x1b[1m${s}\x1b[22m`;
}

interface Discovered {
	name: string;
	description: string;
	content: string;
}

interface SourceGroup {
	source: string;
	commands: Discovered[];
	skills: string[];
	agents: Discovered[];
}

function parseFrontmatter(raw: string): { description: string; body: string; fields: Record<string, string> } {
	const match = raw.match(/^---\s*\n([\s\S]*?)\n---\s*\n([\s\S]*)$/);
	if (!match) return { description: "", body: raw, fields: {} };

	const front = match[1];
	const body = match[2];
	const fields: Record<string, string> = {};
	for (const line of front.split("\n")) {
		const idx = line.indexOf(":");
		if (idx > 0) fields[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
	}
	return { description: fields.description || "", body, fields };
}

function expandArgs(template: string, args: string): string {
	const parts = args.split(/\s+/).filter(Boolean);
	let result = template;
	result = result.replace(/\$ARGUMENTS|\$@/g, args);
	for (let i = 0; i < parts.length; i++) {
		result = result.replaceAll(`$${i + 1}`, parts[i]);
	}
	return result;
}

function scanCommands(dir: string): Discovered[] {
	if (!existsSync(dir)) return [];
	const items: Discovered[] = [];
	try {
		for (const file of readdirSync(dir)) {
			if (!file.endsWith(".md")) continue;
			const raw = readFileSync(join(dir, file), "utf-8");
			const { description, body } = parseFrontmatter(raw);
			items.push({
				name: basename(file, ".md"),
				description:
					description ||
					body
						.split("\n")
						.find((l) => l.trim())
						?.trim() ||
					"",
				content: body,
			});
		}
	} catch {}
	return items;
}

function scanSkills(dir: string): string[] {
	if (!existsSync(dir)) return [];
	const names: string[] = [];
	try {
		for (const entry of readdirSync(dir)) {
			const skillFile = join(dir, entry, "SKILL.md");
			const flatFile = join(dir, entry);
			if (existsSync(skillFile) && statSync(skillFile).isFile()) {
				names.push(entry);
			} else if (entry.endsWith(".md") && statSync(flatFile).isFile()) {
				names.push(basename(entry, ".md"));
			}
		}
	} catch {}
	return names;
}

function scanAgents(dir: string): Discovered[] {
	if (!existsSync(dir)) return [];
	const items: Discovered[] = [];
	try {
		for (const file of readdirSync(dir)) {
			if (!file.endsWith(".md")) continue;
			const raw = readFileSync(join(dir, file), "utf-8");
			const { fields } = parseFrontmatter(raw);
			items.push({
				name: fields.name || basename(file, ".md"),
				description: fields.description || "",
				content: raw,
			});
		}
	} catch {}
	return items;
}

export default function (pi: ExtensionAPI) {
	pi.on("session_start", async (_event, ctx) => {
		const home = homedir();
		const cwd = ctx.cwd;
		const providers = ["claude", "gemini", "codex"];
		const groups: SourceGroup[] = [];

		for (const p of providers) {
			for (const [dir, label] of [
				[join(cwd, `.${p}`), `.${p}`],
				[join(home, `.${p}`), `~/.${p}`],
			] as const) {
				const commands = scanCommands(join(dir, "commands"));
				const skills = scanSkills(join(dir, "skills"));
				const agents = scanAgents(join(dir, "agents"));

				if (commands.length || skills.length || agents.length) {
					groups.push({ source: label, commands, skills, agents });
				}
			}
		}

		// Also scan .pi/agents/
		const localAgents = scanAgents(join(cwd, ".pi", "agents"));
		if (localAgents.length) {
			groups.push({ source: ".pi/agents", commands: [], skills: [], agents: localAgents });
		}

		// Register commands
		const seenCmds = new Set<string>();

		for (const g of groups) {
			for (const cmd of g.commands) {
				if (seenCmds.has(cmd.name)) continue;
				seenCmds.add(cmd.name);
				pi.registerCommand(cmd.name, {
					description: `[${g.source}] ${cmd.description}`.slice(0, 120),
					handler: async (args) => {
						pi.sendUserMessage(expandArgs(cmd.content, args || ""));
					},
				});
			}
		}

		if (groups.length === 0) return;

		setTimeout(() => {
			if (!ctx.hasUI) return;
		}, 100);
	});
}
