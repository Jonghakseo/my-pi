/**
 * Session replay viewer — reads session JSONL files and renders an
 * interactive TUI overlay for browsing past subagent conversations.
 */

import * as fs from "node:fs";
import { Container, Key, Spacer, Text, matchesKey, truncateToWidth, wrapTextWithAnsi } from "@mariozechner/pi-tui";
import { formatUsageStats } from "./format.js";
import type { CommandRunState, SessionReplayItem } from "./types.js";

// ─── Replay Helpers ──────────────────────────────────────────────────────────

function truncateSingleLine(value: string, max: number): string {
	if (value.length <= max) return value;
	if (max <= 3) return value.slice(0, max);
	return `${value.slice(0, max - 3)}...`;
}

function formatReplayTime(date: Date): string {
	return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function formatElapsedDuration(start: Date, end: Date): string {
	const diffSec = Math.max(0, Math.floor((end.getTime() - start.getTime()) / 1000));
	if (diffSec < 60) return `${diffSec}s`;
	const diffMin = Math.floor(diffSec / 60);
	return `${diffMin}m ${diffSec % 60}s`;
}

function parseDateSafely(raw: unknown): Date {
	if (typeof raw === "number") {
		const d = new Date(raw);
		if (!Number.isNaN(d.getTime())) return d;
	}
	if (typeof raw === "string") {
		const d = new Date(raw);
		if (!Number.isNaN(d.getTime())) return d;
	}
	return new Date();
}

function summarizeJson(value: unknown, max = 140): string {
	if (value === undefined || value === null) return "";
	let text = "";
	try {
		text = JSON.stringify(value);
	} catch {
		text = String(value);
	}
	if (!text || text === "{}") return "";
	return truncateSingleLine(text, max);
}

function extractReplayContent(content: any): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";

	const parts: string[] = [];
	for (const part of content) {
		if (!part || typeof part !== "object") continue;
		if (part.type === "text" && typeof part.text === "string" && part.text.trim()) {
			parts.push(part.text);
			continue;
		}
		if (part.type === "toolCall") {
			const name = typeof part.name === "string" ? part.name : "tool";
			const args = summarizeJson((part as any).arguments, 120);
			parts.push(args ? `→ ${name} ${args}` : `→ ${name}`);
		}
	}

	return parts.join("\n");
}

/** Max characters kept per replay item content to avoid memory blowup. */
const REPLAY_CONTENT_MAX_CHARS = 1000;

function truncateReplayContent(text: string, max = REPLAY_CONTENT_MAX_CHARS): string {
	if (text.length <= max) return text;
	return `${text.slice(0, max)}\n… [truncated ${text.length - max} chars]`;
}

// ─── Public API ──────────────────────────────────────────────────────────────

export function readSessionReplayItems(sessionFile: string): SessionReplayItem[] {
	if (!sessionFile || !fs.existsSync(sessionFile)) return [];

	let raw = "";
	try {
		raw = fs.readFileSync(sessionFile, "utf-8");
	} catch {
		return [];
	}
	if (!raw.trim()) return [];

	const items: SessionReplayItem[] = [];
	let prevTime: Date | null = null;

	for (const line of raw.split(/\r?\n/)) {
		if (!line.trim()) continue;
		let entry: any;
		try {
			entry = JSON.parse(line);
		} catch {
			continue;
		}

		if (entry?.type !== "message" || !entry.message) continue;
		const msg = entry.message;
		const ts = parseDateSafely(msg.timestamp ?? entry.timestamp);
		const elapsed = prevTime ? formatElapsedDuration(prevTime, ts) : undefined;
		prevTime = ts;

		if (msg.role === "user") {
			const content = truncateReplayContent(extractReplayContent(msg.content).trim());
			if (!content) continue;
			items.push({ type: "user", title: "User", content, timestamp: ts, elapsed });
			continue;
		}

		if (msg.role === "assistant") {
			const content = truncateReplayContent(extractReplayContent(msg.content).trim());
			if (!content) continue;
			items.push({ type: "assistant", title: "Assistant", content, timestamp: ts, elapsed });
			continue;
		}

		if (msg.role === "toolResult") {
			const toolName = typeof msg.toolName === "string" ? msg.toolName : "tool";
			let content = extractReplayContent(msg.content).trim();
			if (!content && msg.details !== undefined) {
				const detailPreview = summarizeJson(msg.details, 300);
				if (detailPreview) content = `details: ${detailPreview}`;
			}
			if (!content) content = "(no output)";
			items.push({ type: "tool", title: `Tool: ${toolName}`, content: truncateReplayContent(content), timestamp: ts, elapsed });
		}
	}

	return items;
}

export class SubagentSessionReplayOverlay {
	private selectedIndex = 0;
	private expandedIndex: number | null = null;
	private listScrollOffset = 0;
	private detailScrollOffset = 0;
	private cachedDetailWidth = -1;
	private detailWrapCache = new Map<number, string[]>();

	constructor(
		private run: CommandRunState,
		private items: SessionReplayItem[],
		private onDone: () => void,
	) {
		this.selectedIndex = Math.max(0, items.length - 1);
	}

	private getTerminalRows(): number {
		return Math.max(20, (process.stdout as any).rows || 40);
	}

	private getViewportSizes(hasDetail: boolean, hasUsage: boolean): { list: number; detail: number } {
		const rows = this.getTerminalRows();
		const reserved = 7 + (hasUsage ? 1 : 0); // top/header/task/sep/footer/help/bottom
		const body = Math.max(6, rows - reserved);
		if (!hasDetail) return { list: Math.max(4, body), detail: 0 };

		const detailBody = Math.max(8, body - 2); // detail separator + detail header
		const list = Math.max(4, Math.min(12, Math.floor(detailBody * 0.4)));
		const detail = Math.max(4, detailBody - list);
		return { list, detail };
	}

	private onSelectionMoved(): void {
		if (this.expandedIndex !== null) {
			this.expandedIndex = this.selectedIndex;
			this.detailScrollOffset = 0;
		}
	}

	private ensureListVisible(listViewport: number): void {
		if (this.selectedIndex < this.listScrollOffset) {
			this.listScrollOffset = this.selectedIndex;
		} else if (this.selectedIndex >= this.listScrollOffset + listViewport) {
			this.listScrollOffset = this.selectedIndex - listViewport + 1;
		}
		const maxOffset = Math.max(0, this.items.length - listViewport);
		if (this.listScrollOffset > maxOffset) this.listScrollOffset = maxOffset;
	}

	private getDetailLines(itemIndex: number, contentWidth: number): string[] {
		if (this.cachedDetailWidth !== contentWidth) {
			this.cachedDetailWidth = contentWidth;
			this.detailWrapCache.clear();
		}
		const cached = this.detailWrapCache.get(itemIndex);
		if (cached) return cached;

		const raw = this.items[itemIndex]?.content ?? "";
		const normalized = raw.replace(/\r/g, "");
		const lines: string[] = [];
		for (const sourceLine of normalized.split("\n")) {
			if (!sourceLine) {
				lines.push("");
				continue;
			}
			const targetWidth = Math.max(8, contentWidth);
			const wrapped = wrapTextWithAnsi(sourceLine, targetWidth);
			if (wrapped.length === 0) {
				lines.push(sourceLine);
				continue;
			}
			if (wrapped.length === 1 && wrapped[0].length > targetWidth) {
				for (let i = 0; i < sourceLine.length; i += targetWidth) {
					lines.push(sourceLine.slice(i, i + targetWidth));
				}
				continue;
			}
			lines.push(...wrapped);
		}
		if (lines.length === 0) lines.push("(empty)");

		this.detailWrapCache.set(itemIndex, lines);
		return lines;
	}

	private scrollDetail(delta: number): void {
		if (this.expandedIndex === null) return;
		this.detailScrollOffset = Math.max(0, this.detailScrollOffset + delta);
	}

	handleInput(data: string, tui: any): void {
		const listPage = Math.max(1, Math.floor(this.getTerminalRows() / 4));
		const detailPage = Math.max(4, Math.floor(this.getTerminalRows() / 5));
		const hasDetailOpen = this.expandedIndex !== null;

		if ((matchesKey(data, Key.left) || data === "h") && hasDetailOpen) {
			this.scrollDetail(-1);
		} else if ((matchesKey(data, Key.right) || data === "l") && hasDetailOpen) {
			this.scrollDetail(1);
		} else if (matchesKey(data, Key.ctrl("u")) && hasDetailOpen) {
			this.scrollDetail(-detailPage);
		} else if (matchesKey(data, Key.ctrl("d")) && hasDetailOpen) {
			this.scrollDetail(detailPage);
		} else if (matchesKey(data, Key.up) || data === "k") {
			this.selectedIndex = Math.max(0, this.selectedIndex - 1);
			this.onSelectionMoved();
		} else if (matchesKey(data, Key.down) || data === "j") {
			this.selectedIndex = Math.min(this.items.length - 1, this.selectedIndex + 1);
			this.onSelectionMoved();
		} else if (data === "\x1b[5~" /* PageUp */) {
			this.selectedIndex = Math.max(0, this.selectedIndex - listPage);
			this.onSelectionMoved();
		} else if (data === "\x1b[6~" /* PageDown */) {
			this.selectedIndex = Math.min(this.items.length - 1, this.selectedIndex + listPage);
			this.onSelectionMoved();
		} else if (data === "g") {
			this.selectedIndex = 0;
			this.onSelectionMoved();
		} else if (data === "G") {
			this.selectedIndex = Math.max(0, this.items.length - 1);
			this.onSelectionMoved();
		} else if (matchesKey(data, Key.enter)) {
			if (this.expandedIndex === this.selectedIndex) {
				this.expandedIndex = null;
				this.detailScrollOffset = 0;
			} else {
				this.expandedIndex = this.selectedIndex;
				this.detailScrollOffset = 0;
			}
		} else if (matchesKey(data, Key.escape) || data === "q" || data === "Q") {
			this.onDone();
			return;
		}
		tui.requestRender();
	}

	render(width: number, _height: number, theme: any): string[] {
		const container = new Container();
		const pad = "  ";
		const innerWidth = Math.max(24, width - 6);
		const elapsedSec = Math.max(0, Math.round(this.run.elapsedMs / 1000));
		const usageLine = this.run.usage ? formatUsageStats(this.run.usage, this.run.model) : "";
		const task = this.run.task.replace(/\s*\n+\s*/g, " ").replace(/\s{2,}/g, " ").trim();
		const hasDetailOpen = this.expandedIndex !== null;
		const { list: listViewport, detail: detailViewport } = this.getViewportSizes(hasDetailOpen, Boolean(usageLine));

		this.ensureListVisible(listViewport);

		container.addChild(new Spacer(1));
		container.addChild(
			new Text(
				pad +
					theme.fg("toolTitle", theme.bold(`#${this.run.id} ${this.run.agent}`)) +
					theme.fg(
						"dim",
						`  [${this.run.status}] ctx:${this.run.contextMode ?? "sub"} turn:${this.run.turnCount ?? 1}  ${elapsedSec}s  tools:${this.run.toolCalls}`,
					),
				0,
				0,
			),
		);
		container.addChild(
			new Text(
				pad + theme.fg("dim", `Task: ${truncateSingleLine(task, Math.max(10, innerWidth - 8))}`),
				0,
				0,
			),
		);
		if (usageLine) container.addChild(new Text(pad + theme.fg("dim", usageLine), 0, 0));
		container.addChild(new Text(pad + theme.fg("muted", "─".repeat(Math.max(10, innerWidth))), 0, 0));

		for (let row = 0; row < listViewport; row++) {
			const idx = this.listScrollOffset + row;
			const item = this.items[idx];
			if (!item) {
				container.addChild(new Text("", 0, 0));
				continue;
			}

			const isSelected = idx === this.selectedIndex;
			let icon = "○";
			let color: "success" | "accent" | "warning" | "dim" = "dim";
			if (item.type === "user") {
				icon = "👤";
				color = "success";
			} else if (item.type === "assistant") {
				icon = "🤖";
				color = "accent";
			} else if (item.type === "tool") {
				icon = "🛠️";
				color = "warning";
			}

			const timeLabel = `[${formatReplayTime(item.timestamp)}${item.elapsed ? ` +${item.elapsed}` : ""}]`;
			const marker = isSelected ? "▸" : " ";
			const preview = item.content.replace(/\s*\n+\s*/g, " ").replace(/\s{2,}/g, " ").trim() || "(empty)";
			let line =
				`${marker} ${theme.fg(color, icon)} ${theme.bold(item.title)} ` +
				theme.fg("dim", timeLabel) +
				" " +
				theme.fg("muted", truncateSingleLine(preview, Math.max(18, Math.floor(innerWidth / 2))));
			line = truncateToWidth(line, innerWidth);
			if (isSelected) line = theme.bg("selectedBg", line);
			container.addChild(new Text(pad + line, 0, 0));
		}

		if (hasDetailOpen) {
			container.addChild(new Text(pad + theme.fg("muted", "─".repeat(Math.max(10, innerWidth))), 0, 0));
			const detailIndex = this.expandedIndex ?? this.selectedIndex;
			const detailItem = this.items[detailIndex];
			const detailLines = this.getDetailLines(detailIndex, Math.max(8, innerWidth - 4));
			const maxDetailOffset = Math.max(0, detailLines.length - detailViewport);
			if (this.detailScrollOffset > maxDetailOffset) this.detailScrollOffset = maxDetailOffset;
			const start = this.detailScrollOffset;
			const end = Math.min(detailLines.length, start + detailViewport);
			const range =
				detailLines.length === 0
					? "0-0/0"
					: `${start + 1}-${Math.max(start + 1, end)}/${detailLines.length}`;
			container.addChild(
				new Text(
					pad +
						theme.fg("accent", theme.bold(`Detail: ${detailItem?.title ?? "entry"}`)) +
						theme.fg("dim", `  (${range})`),
					0,
					0,
				),
			);

			for (let i = start; i < end; i++) {
				const line = detailLines[i] ?? "";
				container.addChild(
					new Text(pad + theme.fg("toolOutput", `  ${truncateToWidth(line, Math.max(8, innerWidth - 2))}`), 0, 0),
				);
			}
		}

		container.addChild(new Text(pad + theme.fg("muted", "─".repeat(Math.max(10, innerWidth))), 0, 0));
		const listStart = this.items.length === 0 ? 0 : this.listScrollOffset + 1;
		const listEnd = Math.min(this.items.length, this.listScrollOffset + listViewport);
		const listRange = `${listStart}-${listEnd}/${this.items.length}`;
		const helpText = hasDetailOpen
			? "↑↓/jk list · Enter close detail · ←/→ or h/l detail scroll · Ctrl+u/d detail page · PgUp/Dn list · Esc close"
			: "↑↓/jk navigate · Enter open detail · PgUp/Dn page · g/G top/end · Esc close";
		container.addChild(
			new Text(
				pad +
					truncateToWidth(
						theme.fg("dim", helpText) + "  " + theme.fg("accent", listRange),
						innerWidth,
					),
				0,
				0,
			),
		);
		container.addChild(new Spacer(1));

		return container.render(width);
	}
}
