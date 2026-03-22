/**
 * Usage Analytics Extension
 *
 * Logs every subagent invocation and skill read to a local JSONL file,
 * then provides `/analytics` overlay to inspect usage frequency, error rates,
 * and invocation durations per day / week / month.
 *
 * Log file: ~/.pi/agent/state/usage-analytics.jsonl
 *
 * Tracked events:
 *   - subagent: logged on `tool_result` for the `subagent` tool (run/continue/batch/chain launches)
 *     and on `custom_message` session entries with completion status (done/error).
 *   - skill: logged on `tool_result` for the `read` tool when the path contains `SKILL.md`.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Container, Key, matchesKey, Spacer, Text, truncateToWidth } from "@mariozechner/pi-tui";
import { parseSubagentCommandVerb } from "./subagent/cli.ts";

// ─── Constants ───────────────────────────────────────────────────────────────

const LOG_FILE = path.join(os.homedir(), ".pi", "agent", "state", "usage-analytics.jsonl");
const MAX_LOG_AGE_DAYS = 180;
const OVERLAY_WIDTH = 90;
const OVERLAY_MAX_HEIGHT = 40;

// ─── Log entry types ─────────────────────────────────────────────────────────

interface BaseLogEntry {
	ts: string; // ISO 8601
	epoch: number; // ms since epoch
}

interface SubagentStartEntry extends BaseLogEntry {
	type: "subagent_start";
	agent: string;
	runId?: number;
	mode: "run" | "continue" | "batch" | "chain" | "unknown";
}

interface SubagentEndEntry extends BaseLogEntry {
	type: "subagent_end";
	agent: string;
	runId?: number;
	status: "done" | "error";
	elapsedMs?: number;
	model?: string;
}

interface SkillReadEntry extends BaseLogEntry {
	type: "skill_read";
	skill: string;
	path: string;
}

type LogEntry = SubagentStartEntry | SubagentEndEntry | SkillReadEntry;

// ─── Helpers ─────────────────────────────────────────────────────────────────

function ensureLogDir(): void {
	const dir = path.dirname(LOG_FILE);
	if (!fs.existsSync(dir)) {
		fs.mkdirSync(dir, { recursive: true });
	}
}

function appendLog(entry: LogEntry): void {
	try {
		ensureLogDir();
		fs.appendFileSync(LOG_FILE, `${JSON.stringify(entry)}\n`, "utf-8");
	} catch {
		/* ignore write errors */
	}
}

function readAllLogs(): LogEntry[] {
	if (!fs.existsSync(LOG_FILE)) return [];
	try {
		const raw = fs.readFileSync(LOG_FILE, "utf-8");
		const entries: LogEntry[] = [];
		for (const line of raw.split("\n")) {
			if (!line.trim()) continue;
			try {
				entries.push(JSON.parse(line) as LogEntry);
			} catch {
				/* skip malformed lines */
			}
		}
		return entries;
	} catch {
		return [];
	}
}

function now(): Pick<BaseLogEntry, "ts" | "epoch"> {
	const d = new Date();
	return { ts: d.toISOString(), epoch: d.getTime() };
}

/** Extract skill name from a SKILL.md path. */
function extractSkillName(filePath: string): string | null {
	// Patterns:
	//   .../skills/<name>/SKILL.md
	//   .../skills/<name>.md  (unlikely but handle)
	const normalized = filePath.replace(/\\/g, "/");
	const match = /\/skills\/([^/]+)\/SKILL\.md$/i.exec(normalized);
	if (match) return match[1];
	// Fallback: just the directory name before SKILL.md
	const fallback = /([^/]+)\/SKILL\.md$/i.exec(normalized);
	if (fallback) return fallback[1];
	return null;
}

/** Determine subagent launch mode from the CLI verb. */
function verbToMode(verb: string | null): SubagentStartEntry["mode"] {
	if (verb === "run") return "run";
	if (verb === "continue") return "continue";
	if (verb === "batch") return "batch";
	if (verb === "chain") return "chain";
	return "unknown";
}

// ─── Date grouping ───────────────────────────────────────────────────────────

type Period = "day" | "week" | "month";

function periodLabel(epoch: number, period: Period): string {
	const d = new Date(epoch);
	const yyyy = d.getFullYear();
	const mm = String(d.getMonth() + 1).padStart(2, "0");
	const dd = String(d.getDate()).padStart(2, "0");

	if (period === "day") return `${yyyy}-${mm}-${dd}`;
	if (period === "month") return `${yyyy}-${mm}`;

	// ISO week: Monday-based
	const jan1 = new Date(yyyy, 0, 1);
	const dayOfYear = Math.floor((d.getTime() - jan1.getTime()) / 86400000) + 1;
	const weekNum = Math.ceil((dayOfYear + jan1.getDay()) / 7);
	return `${yyyy}-W${String(weekNum).padStart(2, "0")}`;
}

function periodStartEpoch(period: Period): number {
	const now = new Date();
	if (period === "day") {
		const d = new Date(now);
		d.setDate(d.getDate() - 30);
		return d.getTime();
	}
	if (period === "week") {
		const d = new Date(now);
		d.setDate(d.getDate() - 12 * 7);
		return d.getTime();
	}
	// month
	const d = new Date(now);
	d.setMonth(d.getMonth() - 12);
	return d.getTime();
}

// ─── Analytics computation ───────────────────────────────────────────────────

interface AgentStats {
	name: string;
	total: number;
	done: number;
	error: number;
	avgMs: number;
	durations: number[];
}

interface SkillStats {
	name: string;
	total: number;
}

interface PeriodStats {
	label: string;
	agents: Map<string, AgentStats>;
	skills: Map<string, SkillStats>;
}

function computeStats(entries: LogEntry[], period: Period): PeriodStats[] {
	const cutoff = periodStartEpoch(period);
	const filtered = entries.filter((e) => e.epoch >= cutoff);

	const periodMap = new Map<string, { agents: Map<string, AgentStats>; skills: Map<string, SkillStats> }>();

	function getPeriod(epoch: number) {
		const label = periodLabel(epoch, period);
		if (!periodMap.has(label)) {
			periodMap.set(label, { agents: new Map(), skills: new Map() });
		}
		return periodMap.get(label)!;
	}

	function getAgent(p: ReturnType<typeof getPeriod>, name: string): AgentStats {
		if (!p.agents.has(name)) {
			p.agents.set(name, { name, total: 0, done: 0, error: 0, avgMs: 0, durations: [] });
		}
		return p.agents.get(name)!;
	}

	function getSkill(p: ReturnType<typeof getPeriod>, name: string): SkillStats {
		if (!p.skills.has(name)) {
			p.skills.set(name, { name, total: 0 });
		}
		return p.skills.get(name)!;
	}

	for (const entry of filtered) {
		const p = getPeriod(entry.epoch);

		if (entry.type === "subagent_start") {
			const agent = getAgent(p, entry.agent);
			agent.total++;
		} else if (entry.type === "subagent_end") {
			const agent = getAgent(p, entry.agent);
			// If we only have end without start (e.g. session restore), count it
			if (!filtered.some((e) => e.type === "subagent_start" && e.epoch <= entry.epoch && (e as SubagentStartEntry).agent === entry.agent && (e as SubagentStartEntry).runId === entry.runId)) {
				agent.total++;
			}
			if (entry.status === "done") agent.done++;
			else agent.error++;
			if (entry.elapsedMs != null && entry.elapsedMs > 0) {
				agent.durations.push(entry.elapsedMs);
			}
		} else if (entry.type === "skill_read") {
			const skill = getSkill(p, entry.skill);
			skill.total++;
		}
	}

	// Compute avgMs
	for (const [, p] of periodMap) {
		for (const [, agent] of p.agents) {
			if (agent.durations.length > 0) {
				agent.avgMs = Math.round(agent.durations.reduce((a, b) => a + b, 0) / agent.durations.length);
			}
		}
	}

	// Sort periods
	const labels = Array.from(periodMap.keys()).sort();
	return labels.map((label) => ({
		label,
		agents: periodMap.get(label)!.agents,
		skills: periodMap.get(label)!.skills,
	}));
}

// ─── Overall summary (for overview tab) ──────────────────────────────────────

interface OverallAgentSummary {
	name: string;
	total: number;
	done: number;
	error: number;
	errorRate: string;
	avgMs: number;
	avgLabel: string;
	lastUsed: number; // epoch
}

interface OverallSkillSummary {
	name: string;
	total: number;
	lastUsed: number;
}

function computeOverall(entries: LogEntry[]): {
	agents: OverallAgentSummary[];
	skills: OverallSkillSummary[];
	totalSubagentRuns: number;
	totalSkillReads: number;
} {
	const agentMap = new Map<string, { total: number; done: number; error: number; durations: number[]; lastUsed: number }>();
	const skillMap = new Map<string, { total: number; lastUsed: number }>();

	for (const entry of entries) {
		if (entry.type === "subagent_start") {
			const a = agentMap.get(entry.agent) ?? { total: 0, done: 0, error: 0, durations: [], lastUsed: 0 };
			a.total++;
			if (entry.epoch > a.lastUsed) a.lastUsed = entry.epoch;
			agentMap.set(entry.agent, a);
		} else if (entry.type === "subagent_end") {
			const a = agentMap.get(entry.agent) ?? { total: 0, done: 0, error: 0, durations: [], lastUsed: 0 };
			if (!entries.some((e) => e.type === "subagent_start" && e.epoch <= entry.epoch && (e as SubagentStartEntry).agent === entry.agent && (e as SubagentStartEntry).runId === entry.runId)) {
				a.total++;
			}
			if (entry.status === "done") a.done++;
			else a.error++;
			if (entry.elapsedMs != null && entry.elapsedMs > 0) a.durations.push(entry.elapsedMs);
			if (entry.epoch > a.lastUsed) a.lastUsed = entry.epoch;
			agentMap.set(entry.agent, a);
		} else if (entry.type === "skill_read") {
			const s = skillMap.get(entry.skill) ?? { total: 0, lastUsed: 0 };
			s.total++;
			if (entry.epoch > s.lastUsed) s.lastUsed = entry.epoch;
			skillMap.set(entry.skill, s);
		}
	}

	const agents: OverallAgentSummary[] = Array.from(agentMap.entries())
		.map(([name, a]) => {
			const avgMs = a.durations.length > 0 ? Math.round(a.durations.reduce((x, y) => x + y, 0) / a.durations.length) : 0;
			const errorRate = a.total > 0 ? `${Math.round((a.error / (a.done + a.error || 1)) * 100)}%` : "0%";
			return {
				name,
				total: a.total,
				done: a.done,
				error: a.error,
				errorRate,
				avgMs,
				avgLabel: formatDuration(avgMs),
				lastUsed: a.lastUsed,
			};
		})
		.sort((a, b) => b.total - a.total);

	const skills: OverallSkillSummary[] = Array.from(skillMap.entries())
		.map(([name, s]) => ({ name, total: s.total, lastUsed: s.lastUsed }))
		.sort((a, b) => b.total - a.total);

	return {
		agents,
		skills,
		totalSubagentRuns: agents.reduce((sum, a) => sum + a.total, 0),
		totalSkillReads: skills.reduce((sum, s) => sum + s.total, 0),
	};
}

function formatDuration(ms: number): string {
	if (ms === 0) return "-";
	if (ms < 1000) return `${ms}ms`;
	const sec = ms / 1000;
	if (sec < 60) return `${sec.toFixed(1)}s`;
	const min = Math.floor(sec / 60);
	const remainSec = Math.round(sec % 60);
	return `${min}m${remainSec}s`;
}

function formatRelativeTime(epoch: number): string {
	const diff = Date.now() - epoch;
	if (diff < 60_000) return "just now";
	if (diff < 3600_000) return `${Math.floor(diff / 60_000)}m ago`;
	if (diff < 86400_000) return `${Math.floor(diff / 3600_000)}h ago`;
	const days = Math.floor(diff / 86400_000);
	if (days === 1) return "yesterday";
	if (days < 30) return `${days}d ago`;
	return `${Math.floor(days / 30)}mo ago`;
}

// ─── Overlay ─────────────────────────────────────────────────────────────────

type Tab = "overview" | "agents" | "skills";

class AnalyticsOverlay {
	private tab: Tab = "overview";
	private period: Period = "week";
	private scrollOffset = 0;

	constructor(
		private entries: LogEntry[],
		private onDone: () => void,
	) {}

	private getViewport(): number {
		const rows = Math.max(10, (process.stdout as any).rows || 24);
		return Math.max(4, Math.min(rows - 8, OVERLAY_MAX_HEIGHT - 6));
	}

	handleInput(data: string, tui: any): void {
		if (matchesKey(data, Key.escape) || data === "q" || data === "Q") {
			this.onDone();
			return;
		}
		if (data === "1") this.tab = "overview";
		else if (data === "2") this.tab = "agents";
		else if (data === "3") this.tab = "skills";
		else if (data === "d") this.period = "day";
		else if (data === "w") this.period = "week";
		else if (data === "m") this.period = "month";
		else if (matchesKey(data, Key.up) || data === "k") {
			this.scrollOffset = Math.max(0, this.scrollOffset - 1);
		} else if (matchesKey(data, Key.down) || data === "j") {
			this.scrollOffset++;
		}
		tui.requestRender();
	}

	render(width: number, _height: number, theme: any): string[] {
		const container = new Container();
		const pad = "  ";
		const innerWidth = Math.max(30, width - 6);

		container.addChild(new Spacer(1));

		// Header
		const tabs = [
			this.tab === "overview" ? theme.bg("selectedBg", " 1:Overview ") : theme.fg("dim", " 1:Overview "),
			this.tab === "agents" ? theme.bg("selectedBg", " 2:Agents ") : theme.fg("dim", " 2:Agents "),
			this.tab === "skills" ? theme.bg("selectedBg", " 3:Skills ") : theme.fg("dim", " 3:Skills "),
		].join(theme.fg("muted", " │ "));
		container.addChild(new Text(`${pad}📊 ${theme.bold("Usage Analytics")}  ${tabs}`, 0, 0));

		const periods = [
			this.period === "day" ? theme.bg("selectedBg", " d:Day ") : theme.fg("dim", " d:Day "),
			this.period === "week" ? theme.bg("selectedBg", " w:Week ") : theme.fg("dim", " w:Week "),
			this.period === "month" ? theme.bg("selectedBg", " m:Month ") : theme.fg("dim", " m:Month "),
		].join(theme.fg("muted", " │ "));
		container.addChild(new Text(`${pad}${periods}`, 0, 0));
		container.addChild(new Text(pad + theme.fg("muted", "─".repeat(Math.max(10, innerWidth))), 0, 0));

		const lines: string[] = [];

		if (this.tab === "overview") {
			this.renderOverview(lines, theme, innerWidth);
		} else if (this.tab === "agents") {
			this.renderAgents(lines, theme, innerWidth);
		} else {
			this.renderSkills(lines, theme, innerWidth);
		}

		const viewport = this.getViewport();
		if (this.scrollOffset > Math.max(0, lines.length - viewport)) {
			this.scrollOffset = Math.max(0, lines.length - viewport);
		}

		const visible = lines.slice(this.scrollOffset, this.scrollOffset + viewport);
		for (const line of visible) {
			container.addChild(new Text(pad + truncateToWidth(line, innerWidth), 0, 0));
		}

		if (lines.length > viewport) {
			const scrollInfo = theme.fg("dim", `[${this.scrollOffset + 1}-${Math.min(this.scrollOffset + viewport, lines.length)}/${lines.length}]`);
			container.addChild(new Text(pad + scrollInfo, 0, 0));
		}

		container.addChild(new Text(pad + theme.fg("muted", "─".repeat(Math.max(10, innerWidth))), 0, 0));
		container.addChild(
			new Text(pad + theme.fg("dim", "1/2/3 tab · d/w/m period · ↑↓ scroll · q close"), 0, 0),
		);
		container.addChild(new Spacer(1));

		return container.render(width);
	}

	private renderOverview(lines: string[], theme: any, _width: number): void {
		const overall = computeOverall(this.entries);

		lines.push(theme.bold(`Total: ${overall.totalSubagentRuns} subagent runs · ${overall.totalSkillReads} skill reads`));
		lines.push("");

		// Top agents
		lines.push(theme.bold("🤖 Subagents  (by frequency)"));
		if (overall.agents.length === 0) {
			lines.push(theme.fg("dim", "  No subagent usage recorded yet."));
		} else {
			const maxNameLen = Math.max(...overall.agents.map((a) => a.name.length), 6);
			lines.push(
				theme.fg("dim", `  ${"Agent".padEnd(maxNameLen)}  ${"Runs".padStart(5)}  ${"Done".padStart(5)}  ${"Err".padStart(4)}  ${"Err%".padStart(5)}  ${"Avg".padStart(8)}  Last used`),
			);
			for (const a of overall.agents) {
				const errColor = a.error > 0 ? "error" : "dim";
				lines.push(
					`  ${theme.fg("accent", a.name.padEnd(maxNameLen))}  ${String(a.total).padStart(5)}  ${theme.fg("success", String(a.done).padStart(5))}  ${theme.fg(errColor, String(a.error).padStart(4))}  ${theme.fg(errColor, a.errorRate.padStart(5))}  ${a.avgLabel.padStart(8)}  ${theme.fg("dim", formatRelativeTime(a.lastUsed))}`,
				);
			}
		}

		lines.push("");

		// Top skills
		lines.push(theme.bold("📚 Skills  (by frequency)"));
		if (overall.skills.length === 0) {
			lines.push(theme.fg("dim", "  No skill usage recorded yet."));
		} else {
			const maxNameLen = Math.max(...overall.skills.map((s) => s.name.length), 6);
			lines.push(theme.fg("dim", `  ${"Skill".padEnd(maxNameLen)}  ${"Reads".padStart(6)}  Last used`));
			for (const s of overall.skills) {
				lines.push(
					`  ${theme.fg("accent", s.name.padEnd(maxNameLen))}  ${String(s.total).padStart(6)}  ${theme.fg("dim", formatRelativeTime(s.lastUsed))}`,
				);
			}
		}
	}

	private renderAgents(lines: string[], theme: any, _width: number): void {
		const stats = computeStats(this.entries, this.period);

		lines.push(theme.bold(`🤖 Subagent usage by ${this.period}`));
		lines.push("");

		if (stats.length === 0) {
			lines.push(theme.fg("dim", "  No data for this period range."));
			return;
		}

		for (const ps of stats) {
			const agentList = Array.from(ps.agents.values()).sort((a, b) => b.total - a.total);
			if (agentList.length === 0) continue;

			lines.push(theme.bold(`  ${ps.label}`));
			for (const a of agentList) {
				const errColor = a.error > 0 ? "error" : "dim";
				const avgLabel = formatDuration(a.avgMs);
				lines.push(
					`    ${theme.fg("accent", a.name.padEnd(14))} ${String(a.total).padStart(3)} runs  ${theme.fg("success", `${a.done}✓`)}  ${theme.fg(errColor, `${a.error}✗`)}  avg ${avgLabel}`,
				);
			}
			lines.push("");
		}
	}

	private renderSkills(lines: string[], theme: any, _width: number): void {
		const stats = computeStats(this.entries, this.period);

		lines.push(theme.bold(`📚 Skill usage by ${this.period}`));
		lines.push("");

		if (stats.length === 0) {
			lines.push(theme.fg("dim", "  No data for this period range."));
			return;
		}

		for (const ps of stats) {
			const skillList = Array.from(ps.skills.values()).sort((a, b) => b.total - a.total);
			if (skillList.length === 0) continue;

			lines.push(theme.bold(`  ${ps.label}`));
			for (const s of skillList) {
				lines.push(`    ${theme.fg("accent", s.name.padEnd(20))} ${String(s.total).padStart(3)} reads`);
			}
			lines.push("");
		}
	}
}

// ─── Extension entry point ───────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
	// ── Subagent tracking: listen on custom_message events for start/end ──
	// We listen on `tool_result` for the `subagent` tool to capture launches.
	pi.on("tool_result", async (event, _ctx) => {
		// Track subagent launches
		if (event.toolName === "subagent" && !event.isError) {
			const input = event.input as Record<string, unknown> | undefined;
			const verb = parseSubagentCommandVerb(input?.command);
			if (verb === "run" || verb === "continue" || verb === "batch" || verb === "chain") {
				// Extract agent name from the command if possible
				const command = String(input?.command ?? "");
				const agentMatch = /(?:run|continue)\s+(\S+)/i.exec(command);
				const agent = agentMatch?.[1] ?? "unknown";
				const { ts, epoch } = now();
				appendLog({
					type: "subagent_start",
					ts,
					epoch,
					agent,
					mode: verbToMode(verb),
				});
			}
		}

		// Track skill reads
		if (event.toolName === "read" && !event.isError) {
			const input = event.input as Record<string, unknown> | undefined;
			const filePath = typeof input?.path === "string" ? input.path : null;
			if (filePath && /SKILL\.md$/i.test(filePath)) {
				const skill = extractSkillName(filePath);
				if (skill) {
					const { ts, epoch } = now();
					appendLog({ type: "skill_read", ts, epoch, skill, path: filePath });
				}
			}
		}
	});

	// ── Subagent completion tracking via sendMessage custom_message entries ──
	// The subagent extension sends followUp messages with customType "subagent-command" or
	// "subagent-tool" containing details like status, agent, elapsedMs.
	// We hook into session entries on session_start to retroactively log completions
	// we might have missed (e.g., across session restarts).
	// But primarily we listen for the message_end event or custom followUps.
	//
	// Better approach: listen directly on the session entry append.
	// Pi doesn't have a direct "entry_appended" hook, so we use a periodic scan
	// approach OR we hook into the custom_message on each turn.

	// Track subagent completions by listening to session entries on each turn.
	let lastProcessedEntryCount = 0;

	pi.on("message_end", async (_event, ctx) => {
		try {
			const entries = ctx.sessionManager.getEntries();
			if (entries.length <= lastProcessedEntryCount) return;

			const newEntries = entries.slice(lastProcessedEntryCount);
			lastProcessedEntryCount = entries.length;

			for (const entry of newEntries) {
				if ((entry as any).type !== "custom_message") continue;
				const cm = entry as any;
				if (cm.customType !== "subagent-command" && cm.customType !== "subagent-tool") continue;

				const d = cm.details;
				if (!d || typeof d.runId !== "number") continue;

				const content = typeof cm.content === "string" ? cm.content : "";
				const status = typeof d.status === "string" ? d.status.toLowerCase() : "";
				const isCompleted = status === "done" || status === "completed" || content.includes("] completed");
				const isError = status === "error" || status === "failed" || content.includes("] failed");

				if (!isCompleted && !isError) continue;

				const { ts, epoch } = now();
				appendLog({
					type: "subagent_end",
					ts,
					epoch,
					agent: d.agent ?? "unknown",
					runId: d.runId,
					status: isError ? "error" : "done",
					elapsedMs: typeof d.elapsedMs === "number" ? d.elapsedMs : undefined,
					model: typeof d.model === "string" ? d.model : undefined,
				});
			}
		} catch {
			/* ignore */
		}
	});

	pi.on("session_start", async (_event, _ctx) => {
		lastProcessedEntryCount = 0;
	});

	pi.on("session_switch", async (_event, _ctx) => {
		lastProcessedEntryCount = 0;
	});

	// ── /analytics command ──
	pi.registerCommand("analytics", {
		description: "Show subagent & skill usage analytics overlay",
		handler: async (_args, ctx) => {
			if (!ctx.hasUI) {
				ctx.ui.notify("Analytics overlay requires a UI.", "warning");
				return;
			}

			const entries = readAllLogs();

			await ctx.ui.custom(
				(tui, theme, _kb, done) => {
					const overlay = new AnalyticsOverlay(entries, () => done(undefined));
					return {
						render: (w) => overlay.render(w, 0, theme),
						handleInput: (data) => overlay.handleInput(data, tui),
						invalidate: () => {},
					};
				},
				{
					overlay: true,
					overlayOptions: { width: OVERLAY_WIDTH, maxHeight: OVERLAY_MAX_HEIGHT, anchor: "center" },
				},
			);
		},
	});
}
