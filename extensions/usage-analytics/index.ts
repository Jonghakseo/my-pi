/** biome-ignore-all lint/suspicious/noExplicitAny: analytics reads heterogeneous session entries and custom TUI callback shapes. */
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
 *   - subagent_start: logged on `tool_result` for the `subagent` tool (run/continue/batch/chain launches)
 *   - subagent_end:   logged when session entries contain completion custom_messages
 *     (single runs or grouped batch/chain completion summaries)
 *   - skill_read:     logged on `tool_result` for the `read` tool when the path contains `SKILL.md`
 *
 * Counting strategy (deduped hybrid):
 *   - `subagent_end` is the **primary source** for total/done/error/duration.
 *   - `subagent_start` is retained for mode distribution and as a fallback for
 *     legacy/incomplete batch/chain runs that do not have matching end entries.
 *   - When a start/end pair can be matched by runId (or grouped step metadata),
 *     totals are counted from end only to avoid double-counting.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Container, Key, matchesKey, Spacer, Text, truncateToWidth } from "@mariozechner/pi-tui";
import { parseSubagentCommandVerb } from "../subagent/cli.ts";

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
	mode: "run" | "continue" | "batch" | "chain" | "unknown";
	runId?: number;
	batchId?: string;
	pipelineId?: string;
	stepIndex?: number;
}

interface SubagentEndEntry extends BaseLogEntry {
	type: "subagent_end";
	agent: string;
	runId?: number;
	batchId?: string;
	pipelineId?: string;
	stepIndex?: number;
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

/**
 * Rotate log file: remove entries older than MAX_LOG_AGE_DAYS.
 * Called once on session_start to prevent unbounded growth.
 */
function rotateLog(): void {
	if (!fs.existsSync(LOG_FILE)) return;
	try {
		const cutoff = Date.now() - MAX_LOG_AGE_DAYS * 86400_000;
		const raw = fs.readFileSync(LOG_FILE, "utf-8");
		const lines = raw.split("\n");
		const kept: string[] = [];
		let dropped = 0;
		for (const line of lines) {
			if (!line.trim()) continue;
			try {
				const entry = JSON.parse(line) as LogEntry;
				if (entry.epoch >= cutoff) {
					kept.push(line);
				} else {
					dropped++;
				}
			} catch {
				/* drop malformed lines */
				dropped++;
			}
		}
		if (dropped > 0) {
			ensureLogDir();
			fs.writeFileSync(LOG_FILE, kept.length > 0 ? `${kept.join("\n")}\n` : "", "utf-8");
		}
	} catch {
		/* ignore rotation errors */
	}
}

function now(): Pick<BaseLogEntry, "ts" | "epoch"> {
	const d = new Date();
	return { ts: d.toISOString(), epoch: d.getTime() };
}

/** Extract skill name from a SKILL.md path. */
function extractSkillName(filePath: string): string | null {
	const normalized = filePath.replace(/\\/g, "/");
	const match = /\/skills\/([^/]+)\/SKILL\.md$/i.exec(normalized);
	if (match) return match[1];
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

function getRunAnalyticsKeys(entry: {
	runId?: number;
	batchId?: string;
	pipelineId?: string;
	stepIndex?: number;
}): string[] {
	const keys: string[] = [];
	if (typeof entry.runId === "number") keys.push(`run:${entry.runId}`);
	if (entry.batchId && typeof entry.stepIndex === "number") keys.push(`batch:${entry.batchId}:${entry.stepIndex}`);
	if (entry.pipelineId && typeof entry.stepIndex === "number")
		keys.push(`chain:${entry.pipelineId}:${entry.stepIndex}`);
	return keys;
}

function extractSubagentEndEntriesFromCustomMessage(customMessage: {
	content?: unknown;
	details?: Record<string, unknown>;
}): Array<Omit<SubagentEndEntry, "type" | "ts" | "epoch">> {
	const d = customMessage.details;
	if (!d) return [];

	const content = typeof customMessage.content === "string" ? customMessage.content : "";
	const statusRaw = typeof d.status === "string" ? d.status.toLowerCase() : "";
	const isCompleted = statusRaw === "done" || statusRaw === "completed" || content.includes("] completed");
	const isError = statusRaw === "error" || statusRaw === "failed" || content.includes("] failed");
	if (!isCompleted && !isError) return [];

	const status: "done" | "error" = isError ? "error" : "done";
	const elapsedMs = typeof d.elapsedMs === "number" ? d.elapsedMs : undefined;
	const model = typeof d.model === "string" ? d.model : undefined;

	if (typeof d.runId === "number") {
		return [
			{
				agent: typeof d.agent === "string" ? d.agent : "unknown",
				runId: d.runId,
				batchId: typeof d.batchId === "string" ? d.batchId : undefined,
				pipelineId: typeof d.pipelineId === "string" ? d.pipelineId : undefined,
				stepIndex: typeof d.pipelineStepIndex === "number" ? d.pipelineStepIndex : undefined,
				status,
				elapsedMs,
				model,
			},
		];
	}

	const runSummaries = Array.isArray(d.runSummaries) ? d.runSummaries : [];
	if (runSummaries.length === 0) return [];

	return runSummaries.flatMap((summary) => {
		if (!summary || typeof summary !== "object") return [];
		return [
			{
				agent: typeof summary.agent === "string" ? summary.agent : "unknown",
				runId: typeof summary.runId === "number" ? summary.runId : undefined,
				batchId: typeof summary.batchId === "string" ? summary.batchId : undefined,
				pipelineId: typeof summary.pipelineId === "string" ? summary.pipelineId : undefined,
				stepIndex: typeof summary.stepIndex === "number" ? summary.stepIndex : undefined,
				status: typeof summary.status === "string" && summary.status.toLowerCase() === "error" ? "error" : "done",
				elapsedMs: typeof summary.elapsedMs === "number" ? summary.elapsedMs : undefined,
				model: typeof summary.model === "string" ? summary.model : undefined,
			},
		];
	});
}

// ─── Date grouping ───────────────────────────────────────────────────────────

type Period = "day" | "week" | "month";

/**
 * ISO 8601 week number (Thursday-based).
 * Returns { year, week } where year may differ from the calendar year
 * for dates near year boundaries.
 */
function isoWeek(d: Date): { year: number; week: number } {
	const date = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
	// Set to nearest Thursday: current date + 4 - current day (Mon=1, Sun=7)
	const dayOfWeek = date.getUTCDay() || 7; // Convert Sun=0 to Sun=7
	date.setUTCDate(date.getUTCDate() + 4 - dayOfWeek);
	const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
	const weekNum = Math.ceil(((date.getTime() - yearStart.getTime()) / 86400_000 + 1) / 7);
	return { year: date.getUTCFullYear(), week: weekNum };
}

function periodLabel(epoch: number, period: Period): string {
	const d = new Date(epoch);
	const yyyy = d.getFullYear();
	const mm = String(d.getMonth() + 1).padStart(2, "0");
	const dd = String(d.getDate()).padStart(2, "0");

	if (period === "day") return `${yyyy}-${mm}-${dd}`;
	if (period === "month") return `${yyyy}-${mm}`;

	const { year, week } = isoWeek(d);
	return `${year}-W${String(week).padStart(2, "0")}`;
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

/**
 * Compute per-period stats.
 *
 * Counting strategy (deduped hybrid):
 *   - `subagent_end` is the primary source: provides total, done/error, duration.
 *   - `subagent_start` with mode=batch/chain is only used as a fallback when
 *     no matching end entry exists for the same run/group step.
 *   - `_continue` placeholder agents from legacy start records are excluded.
 */
function computeStats(entries: LogEntry[], period: Period): PeriodStats[] {
	const cutoff = periodStartEpoch(period);
	const filtered = entries.filter((e) => e.epoch >= cutoff);
	const completedKeys = new Set(
		filtered
			.filter((entry): entry is SubagentEndEntry => entry.type === "subagent_end")
			.flatMap((entry) => getRunAnalyticsKeys(entry)),
	);

	const periodMap = new Map<string, { agents: Map<string, AgentStats>; skills: Map<string, SkillStats> }>();

	function getPeriod(epoch: number) {
		const label = periodLabel(epoch, period);
		if (!periodMap.has(label)) {
			periodMap.set(label, { agents: new Map(), skills: new Map() });
		}
		const periodEntry = periodMap.get(label);
		if (!periodEntry) throw new Error(`Missing period for label: ${label}`);
		return periodEntry;
	}

	function getAgent(p: ReturnType<typeof getPeriod>, name: string): AgentStats {
		if (!p.agents.has(name)) {
			p.agents.set(name, { name, total: 0, done: 0, error: 0, avgMs: 0, durations: [] });
		}
		const agent = p.agents.get(name);
		if (!agent) throw new Error(`Missing agent bucket: ${name}`);
		return agent;
	}

	function getSkill(p: ReturnType<typeof getPeriod>, name: string): SkillStats {
		if (!p.skills.has(name)) {
			p.skills.set(name, { name, total: 0 });
		}
		const skill = p.skills.get(name);
		if (!skill) throw new Error(`Missing skill bucket: ${name}`);
		return skill;
	}

	for (const entry of filtered) {
		const p = getPeriod(entry.epoch);

		if (entry.type === "subagent_end") {
			const agent = getAgent(p, entry.agent);
			agent.total++;
			if (entry.status === "done") agent.done++;
			else agent.error++;
			if (entry.elapsedMs != null && entry.elapsedMs > 0) {
				agent.durations.push(entry.elapsedMs);
			}
		} else if (entry.type === "subagent_start") {
			if (shouldCountFallbackStart(entry as SubagentStartEntry, completedKeys)) {
				getAgent(p, entry.agent).total++;
			}
		} else if (entry.type === "skill_read") {
			const skill = getSkill(p, entry.skill);
			skill.total++;
		}
	}

	for (const [, p] of periodMap) {
		for (const [, agent] of p.agents) {
			if (agent.durations.length > 0) {
				agent.avgMs = Math.round(agent.durations.reduce((a, b) => a + b, 0) / agent.durations.length);
			}
		}
	}

	const labels = Array.from(periodMap.keys()).sort();
	return labels.map((label) => {
		const period = periodMap.get(label);
		if (!period) throw new Error(`Missing period bucket for label: ${label}`);
		return {
			label,
			agents: period.agents,
			skills: period.skills,
		};
	});
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

/**
 * Compute overall stats.
 * Deduped hybrid counting: end is primary, batch/chain starts are fallback.
 */
function updateOverallAgentSummary(
	agentMap: Map<string, { total: number; done: number; error: number; durations: number[]; lastUsed: number }>,
	name: string,
	update: Partial<{ total: number; done: number; error: number; elapsedMs: number; epoch: number }>,
): void {
	const agent = agentMap.get(name) ?? { total: 0, done: 0, error: 0, durations: [], lastUsed: 0 };
	agent.total += update.total ?? 0;
	agent.done += update.done ?? 0;
	agent.error += update.error ?? 0;
	if ((update.elapsedMs ?? 0) > 0) {
		agent.durations.push(update.elapsedMs as number);
	}
	if ((update.epoch ?? 0) > agent.lastUsed) {
		agent.lastUsed = update.epoch as number;
	}
	agentMap.set(name, agent);
}

function updateOverallSkillSummary(
	skillMap: Map<string, { total: number; lastUsed: number }>,
	entry: SkillReadEntry,
): void {
	const skill = skillMap.get(entry.skill) ?? { total: 0, lastUsed: 0 };
	skill.total += 1;
	if (entry.epoch > skill.lastUsed) {
		skill.lastUsed = entry.epoch;
	}
	skillMap.set(entry.skill, skill);
}

/**
 * Decide whether an unmatched batch/chain `subagent_start` should be counted
 * as a fallback (interrupted run with no completion event).
 *
 * Excludes:
 *   - non-batch/chain starts (run/continue handled via subagent_end)
 *   - `_continue` placeholder records
 *   - phantom starts with no runId/batchId/stepIndex (legacy logging bug)
 *   - starts whose run/group step already has a matching subagent_end
 */
function shouldCountFallbackStart(start: SubagentStartEntry, completedKeys: Set<string>): boolean {
	if ((start.mode !== "batch" && start.mode !== "chain") || start.agent === "_continue") {
		return false;
	}
	const keys = getRunAnalyticsKeys(start);
	if (keys.length === 0) return false;
	return !keys.some((key) => completedKeys.has(key));
}

function computeOverall(entries: LogEntry[]): {
	agents: OverallAgentSummary[];
	skills: OverallSkillSummary[];
	totalSubagentRuns: number;
	totalSkillReads: number;
} {
	const agentMap = new Map<
		string,
		{ total: number; done: number; error: number; durations: number[]; lastUsed: number }
	>();
	const skillMap = new Map<string, { total: number; lastUsed: number }>();
	const completedKeys = new Set(
		entries
			.filter((entry): entry is SubagentEndEntry => entry.type === "subagent_end")
			.flatMap((entry) => getRunAnalyticsKeys(entry)),
	);

	for (const entry of entries) {
		if (entry.type === "subagent_end") {
			updateOverallAgentSummary(agentMap, entry.agent, {
				total: 1,
				done: entry.status === "done" ? 1 : 0,
				error: entry.status === "error" ? 1 : 0,
				elapsedMs: entry.elapsedMs,
				epoch: entry.epoch,
			});
			continue;
		}
		if (entry.type === "subagent_start") {
			const start = entry as SubagentStartEntry;
			if (shouldCountFallbackStart(start, completedKeys)) {
				updateOverallAgentSummary(agentMap, start.agent, { total: 1, epoch: start.epoch });
			}
			continue;
		}
		if (entry.type === "skill_read") {
			updateOverallSkillSummary(skillMap, entry);
		}
	}

	const agents: OverallAgentSummary[] = Array.from(agentMap.entries())
		.map(([name, a]) => {
			const avgMs =
				a.durations.length > 0 ? Math.round(a.durations.reduce((x, y) => x + y, 0) / a.durations.length) : 0;
			const completedCount = a.done + a.error;
			const errorRate = completedCount > 0 ? `${Math.round((a.error / completedCount) * 100)}%` : "0%";
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
			this.renderOverview(lines, theme);
		} else if (this.tab === "agents") {
			this.renderAgents(lines, theme);
		} else {
			this.renderSkills(lines, theme);
		}

		const viewport = this.getViewport();
		if (this.scrollOffset > Math.max(0, lines.length - viewport)) {
			this.scrollOffset = Math.max(0, lines.length - viewport);
		}

		const visible = lines.slice(this.scrollOffset, this.scrollOffset + viewport);
		for (const line of visible) {
			container.addChild(new Text(pad + truncateToWidth(line, innerWidth, theme.fg("dim", "...")), 0, 0));
		}

		if (lines.length > viewport) {
			const scrollInfo = theme.fg(
				"dim",
				`[${this.scrollOffset + 1}-${Math.min(this.scrollOffset + viewport, lines.length)}/${lines.length}]`,
			);
			container.addChild(new Text(pad + scrollInfo, 0, 0));
		}

		container.addChild(new Text(pad + theme.fg("muted", "─".repeat(Math.max(10, innerWidth))), 0, 0));
		container.addChild(new Text(pad + theme.fg("dim", "1/2/3 tab · d/w/m period · ↑↓ scroll · q close"), 0, 0));
		container.addChild(new Spacer(1));

		return container.render(width);
	}

	private renderOverview(lines: string[], theme: any): void {
		const overall = computeOverall(this.entries);

		lines.push(
			theme.bold(`Total: ${overall.totalSubagentRuns} subagent runs · ${overall.totalSkillReads} skill reads`),
		);
		lines.push("");

		// Top agents
		lines.push(theme.bold("🤖 Subagents  (by frequency)"));
		if (overall.agents.length === 0) {
			lines.push(theme.fg("dim", "  No subagent usage recorded yet."));
		} else {
			const maxNameLen = Math.max(...overall.agents.map((a) => a.name.length), 6);
			lines.push(
				theme.fg(
					"dim",
					`  ${"Agent".padEnd(maxNameLen)}  ${"Runs".padStart(5)}  ${"Done".padStart(5)}  ${"Err".padStart(4)}  ${"Err%".padStart(5)}  ${"Avg".padStart(8)}  Last used`,
				),
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

	private renderAgents(lines: string[], theme: any): void {
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

	private renderSkills(lines: string[], theme: any): void {
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

export const __test__ = {
	computeStats,
	computeOverall,
	getRunAnalyticsKeys,
	extractSubagentEndEntriesFromCustomMessage,
};

const SKILL_DEBOUNCE_MS = 10_000; // 같은 스킬의 10초 내 중복 read를 무시

/**
 * Log subagent launches from `tool_result` events.
 *
 * Only logs when `details.launches` is populated by the subagent runner.
 * Empty launches indicates a rejected/error result (e.g. "batch supports at
 * most 12 runs"); pi-agent-core does not propagate the tool's `isError: true`
 * because `AgentToolResult` has no `isError` field, so we cannot rely on
 * `event.isError` to filter rejections. Trusting `launches` as the single
 * source of truth avoids phantom starts from command-line fallback parsing.
 */
function logSubagentLaunch(event: { input?: unknown; details?: unknown; toolName: string; isError?: boolean }): void {
	if (event.toolName !== "subagent" || event.isError) return;
	const input = event.input as Record<string, unknown> | undefined;
	const details = event.details as Record<string, unknown> | undefined;
	const verb = parseSubagentCommandVerb(input?.command);
	if (verb !== "run" && verb !== "continue" && verb !== "batch" && verb !== "chain") return;

	const launches = Array.isArray(details?.launches) ? details.launches : [];
	if (launches.length === 0) return;

	const mode = verbToMode(verb);
	const { ts, epoch } = now();
	for (const launch of launches) {
		if (!launch || typeof launch !== "object") continue;
		appendLog({
			type: "subagent_start",
			ts,
			epoch,
			agent: typeof launch.agent === "string" ? launch.agent : "unknown",
			mode,
			runId: typeof launch.runId === "number" ? launch.runId : undefined,
			batchId: typeof launch.batchId === "string" ? launch.batchId : undefined,
			pipelineId: typeof launch.pipelineId === "string" ? launch.pipelineId : undefined,
			stepIndex: typeof launch.stepIndex === "number" ? launch.stepIndex : undefined,
		});
	}
}

function logSkillRead(
	event: { input?: unknown; toolName: string; isError?: boolean },
	skillLastLogged: Map<string, number>,
): void {
	if (event.toolName !== "read" || event.isError) return;
	const input = event.input as Record<string, unknown> | undefined;
	const filePath = typeof input?.path === "string" ? input.path : null;
	if (!filePath || !/SKILL\.md$/i.test(filePath)) return;

	const skill = extractSkillName(filePath);
	if (!skill) return;
	const { ts, epoch } = now();
	const lastEpoch = skillLastLogged.get(skill) ?? 0;
	if (epoch - lastEpoch < SKILL_DEBOUNCE_MS) return;
	skillLastLogged.set(skill, epoch);
	appendLog({ type: "skill_read", ts, epoch, skill, path: filePath });
}

export default function (pi: ExtensionAPI) {
	// Track the number of session entries already processed to avoid
	// re-scanning historical completion events on session_start.
	let lastProcessedEntryCount = -1;
	// Debounce: skill → last logged epoch
	const skillLastLogged = new Map<string, number>();

	// ── Subagent launch tracking ──
	pi.on("tool_result", async (event, _ctx) => {
		logSubagentLaunch(event);
		logSkillRead(event, skillLastLogged);
	});

	// ── Subagent completion tracking ──
	// Scan new session entries on each message_end to find completion custom_messages.
	pi.on("message_end", async (_event, ctx) => {
		try {
			const entries = ctx.sessionManager.getEntries();
			// Initialize on first call: skip all existing entries to avoid duplicates.
			if (lastProcessedEntryCount < 0) {
				lastProcessedEntryCount = entries.length;
				return;
			}
			if (entries.length <= lastProcessedEntryCount) return;

			const newEntries = entries.slice(lastProcessedEntryCount);
			lastProcessedEntryCount = entries.length;

			for (const entry of newEntries) {
				if ((entry as any).type !== "custom_message") continue;
				const cm = entry as any;
				if (cm.customType !== "subagent-command" && cm.customType !== "subagent-tool") continue;

				const endEntries = extractSubagentEndEntriesFromCustomMessage(cm);
				for (const endEntry of endEntries) {
					const { ts, epoch } = now();
					appendLog({ type: "subagent_end", ts, epoch, ...endEntry });
				}
			}
		} catch {
			/* ignore */
		}
	});

	// ── Session lifecycle ──
	pi.on("session_start", async (event, ctx) => {
		// Initialize entry count to current length to skip all historical entries.
		try {
			lastProcessedEntryCount = ctx.sessionManager.getEntries().length;
		} catch {
			lastProcessedEntryCount = 0;
		}
		// Rotate old log entries only on fresh startup
		if (event.reason === "startup") {
			rotateLog();
		}
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
