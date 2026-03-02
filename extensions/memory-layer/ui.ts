/**
 * /memory overlay UI components.
 * Provides an interactive TUI for browsing, viewing, and managing memories.
 * Pattern follows todos.ts closely.
 */

import { DynamicBorder, getMarkdownTheme, type Theme } from "@mariozechner/pi-coding-agent";
import {
	Container,
	type Focusable,
	fuzzyMatch,
	getEditorKeybindings,
	Input,
	Key,
	Markdown,
	matchesKey,
	type SelectItem,
	SelectList,
	Spacer,
	Text,
	type TUI,
	truncateToWidth,
	visibleWidth,
} from "@mariozechner/pi-tui";
import type { MemoryRecord, MemoryScope } from "./types.ts";

// ── Types ────────────────────────────────────────────────────────────────────

export type MemoryOverlayAction = "back";
export type MemoryMenuAction = "view" | "archive" | "purge" | "copyContent" | "copyId";
export type ScopeFilter = "all" | "user" | "project";

// ── Helpers ──────────────────────────────────────────────────────────────────

function scopeBadge(theme: Theme, scope: MemoryScope): string {
	return scope === "user" ? theme.fg("accent", "[user]") : theme.fg("success", "[project]");
}

function statusBadge(theme: Theme, status: string): string {
	return status === "active" ? theme.fg("success", "active") : theme.fg("dim", "archived");
}

function formatDate(iso: string): string {
	if (!iso) return "unknown";
	try {
		const d = new Date(iso);
		const y = d.getFullYear();
		const m = String(d.getMonth() + 1).padStart(2, "0");
		const day = String(d.getDate()).padStart(2, "0");
		return `${y}-${m}-${day}`;
	} catch {
		return iso;
	}
}

function buildSearchText(memory: MemoryRecord): string {
	return [
		memory.id,
		memory.title,
		memory.content,
		memory.scope,
		memory.status,
		...memory.keywords,
		memory.projectId ?? "",
	]
		.join(" ")
		.toLowerCase();
}

function filterMemories(memories: MemoryRecord[], query: string, scopeFilter: ScopeFilter): MemoryRecord[] {
	let filtered = memories;

	// Scope filter
	if (scopeFilter !== "all") {
		filtered = filtered.filter((m) => m.scope === scopeFilter);
	}

	// Search query
	const trimmed = query.trim();
	if (!trimmed) return filtered;

	const tokens = trimmed
		.split(/\s+/)
		.map((t) => t.trim())
		.filter(Boolean);
	if (!tokens.length) return filtered;

	const scored: Array<{ memory: MemoryRecord; score: number }> = [];
	for (const memory of filtered) {
		const text = buildSearchText(memory);
		let totalScore = 0;
		let matched = true;
		for (const token of tokens) {
			const result = fuzzyMatch(token, text);
			if (!result.matches) {
				matched = false;
				break;
			}
			totalScore += result.score;
		}
		if (matched) {
			scored.push({ memory, score: totalScore });
		}
	}

	return scored.sort((a, b) => a.score - b.score).map((s) => s.memory);
}

function sortMemories(memories: MemoryRecord[]): MemoryRecord[] {
	return [...memories].sort((a, b) => {
		// Active first
		if (a.status !== b.status) {
			return a.status === "active" ? -1 : 1;
		}
		// Then by date (newest first)
		return (b.createdAt || "").localeCompare(a.createdAt || "");
	});
}

// ── Memory Selector Component ────────────────────────────────────────────────

export class MemorySelectorComponent extends Container implements Focusable {
	private searchInput: Input;
	private listContainer: Container;
	private allMemories: MemoryRecord[];
	private filteredMemories: MemoryRecord[];
	private selectedIndex = 0;
	private scopeFilter: ScopeFilter = "all";
	private onSelectCallback: (memory: MemoryRecord) => void;
	private onCancelCallback: () => void;
	private tui: TUI;
	private theme: Theme;
	private headerText: Text;
	private scopeText: Text;
	private hintText: Text;

	private _focused = false;
	get focused(): boolean {
		return this._focused;
	}
	set focused(value: boolean) {
		this._focused = value;
		this.searchInput.focused = value;
	}

	constructor(
		tui: TUI,
		theme: Theme,
		memories: MemoryRecord[],
		onSelect: (memory: MemoryRecord) => void,
		onCancel: () => void,
		initialSearch?: string,
	) {
		super();
		this.tui = tui;
		this.theme = theme;
		this.allMemories = sortMemories(memories);
		this.filteredMemories = this.allMemories;
		this.onSelectCallback = onSelect;
		this.onCancelCallback = onCancel;

		// Build layout
		this.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
		this.addChild(new Spacer(1));

		this.headerText = new Text("", 1, 0);
		this.addChild(this.headerText);

		this.scopeText = new Text("", 1, 0);
		this.addChild(this.scopeText);
		this.addChild(new Spacer(1));

		this.searchInput = new Input();
		if (initialSearch) this.searchInput.setValue(initialSearch);
		this.searchInput.onSubmit = () => {
			const selected = this.filteredMemories[this.selectedIndex];
			if (selected) this.onSelectCallback(selected);
		};
		this.addChild(this.searchInput);

		this.addChild(new Spacer(1));
		this.listContainer = new Container();
		this.addChild(this.listContainer);

		this.addChild(new Spacer(1));
		this.hintText = new Text("", 1, 0);
		this.addChild(this.hintText);
		this.addChild(new Spacer(1));
		this.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));

		this.updateHeader();
		this.updateScopeDisplay();
		this.updateHints();
		this.applyFilter();
	}

	setMemories(memories: MemoryRecord[]): void {
		this.allMemories = sortMemories(memories);
		this.updateHeader();
		this.applyFilter();
		this.tui.requestRender();
	}

	private updateHeader(): void {
		const active = this.allMemories.filter((m) => m.status === "active").length;
		const archived = this.allMemories.length - active;
		const title = `Memories (${active} active, ${archived} archived)`;
		this.headerText.setText(this.theme.fg("accent", this.theme.bold(title)));
	}

	private updateScopeDisplay(): void {
		const labels: Record<ScopeFilter, string> = {
			all: "📋 All",
			user: "🌐 User only",
			project: "📁 Project only",
		};
		this.scopeText.setText(
			this.theme.fg("muted", `Filter: ${labels[this.scopeFilter]}`) + this.theme.fg("dim", "  (Tab to cycle)"),
		);
	}

	private updateHints(): void {
		this.hintText.setText(this.theme.fg("dim", "Type to search • ↑↓ select • Enter actions • Tab scope • Esc close"));
	}

	private applyFilter(): void {
		this.filteredMemories = filterMemories(this.allMemories, this.searchInput.getValue(), this.scopeFilter);
		this.selectedIndex = Math.min(this.selectedIndex, Math.max(0, this.filteredMemories.length - 1));
		this.updateList();
	}

	private updateList(): void {
		this.listContainer.clear();

		if (this.filteredMemories.length === 0) {
			this.listContainer.addChild(new Text(this.theme.fg("muted", "  No matching memories"), 0, 0));
			return;
		}

		const maxVisible = 10;
		const startIndex = Math.max(
			0,
			Math.min(this.selectedIndex - Math.floor(maxVisible / 2), this.filteredMemories.length - maxVisible),
		);
		const endIndex = Math.min(startIndex + maxVisible, this.filteredMemories.length);

		for (let i = startIndex; i < endIndex; i++) {
			const memory = this.filteredMemories[i];
			if (!memory) continue;
			const isSelected = i === this.selectedIndex;
			const isArchived = memory.status === "archived";

			const prefix = isSelected ? this.theme.fg("accent", "→ ") : "  ";
			const titleColor = isSelected ? "accent" : isArchived ? "dim" : "text";
			const badge = scopeBadge(this.theme, memory.scope);
			const keywords =
				memory.keywords.length > 0
					? this.theme.fg(
							"muted",
							` (${memory.keywords.slice(0, 3).join(", ")}${memory.keywords.length > 3 ? "…" : ""})`,
						)
					: "";
			const archived = isArchived ? this.theme.fg("dim", " [archived]") : "";
			const date = this.theme.fg("dim", ` ${formatDate(memory.createdAt)}`);

			const line =
				prefix +
				this.theme.fg("accent", memory.id) +
				" " +
				badge +
				" " +
				this.theme.fg(titleColor, memory.title || "(untitled)") +
				keywords +
				archived +
				date;

			this.listContainer.addChild(new Text(line, 0, 0));
		}

		if (startIndex > 0 || endIndex < this.filteredMemories.length) {
			const scrollInfo = this.theme.fg("dim", `  (${this.selectedIndex + 1}/${this.filteredMemories.length})`);
			this.listContainer.addChild(new Text(scrollInfo, 0, 0));
		}
	}

	private cycleScope(): void {
		const order: ScopeFilter[] = ["all", "user", "project"];
		const idx = order.indexOf(this.scopeFilter);
		this.scopeFilter = order[(idx + 1) % order.length];
		this.updateScopeDisplay();
		this.applyFilter();
	}

	handleInput(keyData: string): void {
		const kb = getEditorKeybindings();

		if (kb.matches(keyData, "selectUp")) {
			if (this.filteredMemories.length === 0) return;
			this.selectedIndex = this.selectedIndex === 0 ? this.filteredMemories.length - 1 : this.selectedIndex - 1;
			this.updateList();
			return;
		}
		if (kb.matches(keyData, "selectDown")) {
			if (this.filteredMemories.length === 0) return;
			this.selectedIndex = this.selectedIndex === this.filteredMemories.length - 1 ? 0 : this.selectedIndex + 1;
			this.updateList();
			return;
		}
		if (kb.matches(keyData, "selectConfirm")) {
			const selected = this.filteredMemories[this.selectedIndex];
			if (selected) this.onSelectCallback(selected);
			return;
		}
		if (kb.matches(keyData, "selectCancel")) {
			this.onCancelCallback();
			return;
		}
		if (matchesKey(keyData, Key.tab)) {
			this.cycleScope();
			return;
		}

		// Pass other input to search
		this.searchInput.handleInput(keyData);
		this.applyFilter();
	}

	override invalidate(): void {
		super.invalidate();
		this.updateHeader();
		this.updateScopeDisplay();
		this.updateHints();
		this.updateList();
	}
}

// ── Memory Action Menu Component ─────────────────────────────────────────────

export class MemoryActionMenuComponent extends Container {
	private selectList: SelectList;
	private onSelectCallback: (action: MemoryMenuAction) => void;
	private onCancelCallback: () => void;

	constructor(theme: Theme, memory: MemoryRecord, onSelect: (action: MemoryMenuAction) => void, onCancel: () => void) {
		super();
		this.onSelectCallback = onSelect;
		this.onCancelCallback = onCancel;

		const title = memory.title || "(untitled)";
		const isArchived = memory.status === "archived";

		const options: SelectItem[] = [
			{ value: "view", label: "view", description: "View full memory content" },
			...(isArchived ? [] : [{ value: "archive", label: "archive", description: "Archive this memory (soft delete)" }]),
			{ value: "purge", label: "🗑️ 영구 삭제", description: "Permanently delete this memory (irreversible)" },
			{ value: "copyContent", label: "copy content", description: "Copy memory content to clipboard" },
			{ value: "copyId", label: "copy ID", description: "Copy memory ID to clipboard" },
		];

		this.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
		this.addChild(
			new Text(
				theme.fg("accent", theme.bold(`Actions for ${memory.id} `)) +
					scopeBadge(theme, memory.scope) +
					theme.fg("muted", ` "${title}"`),
			),
		);

		this.selectList = new SelectList(options, options.length, {
			selectedPrefix: (text) => theme.fg("accent", text),
			selectedText: (text) => theme.fg("accent", text),
			description: (text) => theme.fg("muted", text),
			scrollInfo: (text) => theme.fg("dim", text),
			noMatch: (text) => theme.fg("warning", text),
		});

		this.selectList.onSelect = (item) => this.onSelectCallback(item.value as MemoryMenuAction);
		this.selectList.onCancel = () => this.onCancelCallback();

		this.addChild(this.selectList);
		this.addChild(new Text(theme.fg("dim", "Enter to confirm • Esc back")));
		this.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
	}

	handleInput(keyData: string): void {
		this.selectList.handleInput(keyData);
	}

	override invalidate(): void {
		super.invalidate();
	}
}

// ── Memory Detail Overlay Component ──────────────────────────────────────────

export class MemoryDetailOverlayComponent {
	private memory: MemoryRecord;
	private theme: Theme;
	private tui: TUI;
	private markdown: Markdown;
	private scrollOffset = 0;
	private viewHeight = 0;
	private totalLines = 0;
	private onAction: (action: MemoryOverlayAction) => void;

	constructor(tui: TUI, theme: Theme, memory: MemoryRecord, onAction: (action: MemoryOverlayAction) => void) {
		this.tui = tui;
		this.theme = theme;
		this.memory = memory;
		this.onAction = onAction;
		this.markdown = new Markdown(this.buildMarkdown(), 1, 0, getMarkdownTheme());
	}

	private buildMarkdown(): string {
		const m = this.memory;
		const lines: string[] = [];
		lines.push(`**${m.title || "(untitled)"}**`);
		lines.push("");
		lines.push(m.content || "_No content._");
		return lines.join("\n");
	}

	handleInput(keyData: string): void {
		const kb = getEditorKeybindings();
		if (kb.matches(keyData, "selectCancel")) {
			this.onAction("back");
			return;
		}
		if (kb.matches(keyData, "selectUp")) {
			this.scrollBy(-1);
			return;
		}
		if (kb.matches(keyData, "selectDown")) {
			this.scrollBy(1);
			return;
		}
		if (kb.matches(keyData, "selectPageUp")) {
			this.scrollBy(-this.viewHeight || -1);
			return;
		}
		if (kb.matches(keyData, "selectPageDown")) {
			this.scrollBy(this.viewHeight || 1);
			return;
		}
	}

	render(width: number): string[] {
		const maxHeight = this.getMaxHeight();
		const headerLines = 5; // title + meta lines
		const footerLines = 3;
		const borderLines = 2;
		const innerWidth = Math.max(10, width - 2);
		const contentHeight = Math.max(1, maxHeight - headerLines - footerLines - borderLines);

		const markdownLines = this.markdown.render(innerWidth);
		this.totalLines = markdownLines.length;
		this.viewHeight = contentHeight;
		const maxScroll = Math.max(0, this.totalLines - contentHeight);
		this.scrollOffset = Math.max(0, Math.min(this.scrollOffset, maxScroll));

		const visibleLines = markdownLines.slice(this.scrollOffset, this.scrollOffset + contentHeight);
		const lines: string[] = [];

		// Header
		lines.push(this.buildTitleLine(innerWidth));
		lines.push(this.buildMetaLine(innerWidth));
		lines.push(this.buildKeywordLine(innerWidth));
		lines.push(this.buildDateLine(innerWidth));
		lines.push("");

		// Content
		for (const line of visibleLines) {
			lines.push(truncateToWidth(line, innerWidth));
		}
		while (lines.length < headerLines + contentHeight) {
			lines.push("");
		}

		// Footer
		lines.push("");
		lines.push(this.buildActionLine(innerWidth));

		// Frame
		const borderColor = (text: string) => this.theme.fg("borderMuted", text);
		const top = borderColor(`┌${"─".repeat(innerWidth)}┐`);
		const bottom = borderColor(`└${"─".repeat(innerWidth)}┘`);
		const framedLines = lines.map((line) => {
			const truncated = truncateToWidth(line, innerWidth);
			const padding = Math.max(0, innerWidth - visibleWidth(truncated));
			return borderColor("│") + truncated + " ".repeat(padding) + borderColor("│");
		});

		return [top, ...framedLines, bottom].map((line) => truncateToWidth(line, width));
	}

	invalidate(): void {
		this.markdown = new Markdown(this.buildMarkdown(), 1, 0, getMarkdownTheme());
	}

	private getMaxHeight(): number {
		const rows = this.tui.terminal.rows || 24;
		return Math.max(10, Math.floor(rows * 0.8));
	}

	private buildTitleLine(width: number): string {
		const m = this.memory;
		const titleText = ` ${m.title || m.id} `;
		const titleWidth = visibleWidth(titleText);
		if (titleWidth >= width) {
			return truncateToWidth(this.theme.fg("accent", titleText.trim()), width);
		}
		const leftWidth = Math.max(0, Math.floor((width - titleWidth) / 2));
		const rightWidth = Math.max(0, width - titleWidth - leftWidth);
		return (
			this.theme.fg("borderMuted", "─".repeat(leftWidth)) +
			this.theme.fg("accent", titleText) +
			this.theme.fg("borderMuted", "─".repeat(rightWidth))
		);
	}

	private buildMetaLine(width: number): string {
		const m = this.memory;
		const line =
			this.theme.fg("accent", m.id) +
			this.theme.fg("muted", " • ") +
			scopeBadge(this.theme, m.scope) +
			this.theme.fg("muted", " • ") +
			statusBadge(this.theme, m.status) +
			(m.projectId ? this.theme.fg("muted", ` • project:${m.projectId}`) : "");
		return truncateToWidth(line, width);
	}

	private buildKeywordLine(width: number): string {
		const m = this.memory;
		const kw = m.keywords.length > 0 ? m.keywords.join(", ") : "none";
		return truncateToWidth(this.theme.fg("muted", `Keywords: ${kw}`), width);
	}

	private buildDateLine(width: number): string {
		const m = this.memory;
		const created = formatDate(m.createdAt);
		const updated = formatDate(m.updatedAt);
		return truncateToWidth(this.theme.fg("dim", `Created: ${created} • Updated: ${updated}`), width);
	}

	private buildActionLine(width: number): string {
		const back = this.theme.fg("dim", "esc back • ↑↓ scroll");
		let line = back;
		if (this.totalLines > this.viewHeight) {
			const start = Math.min(this.totalLines, this.scrollOffset + 1);
			const end = Math.min(this.totalLines, this.scrollOffset + this.viewHeight);
			const scrollInfo = this.theme.fg("dim", ` ${start}-${end}/${this.totalLines}`);
			line += scrollInfo;
		}
		return truncateToWidth(line, width);
	}

	private scrollBy(delta: number): void {
		const maxScroll = Math.max(0, this.totalLines - this.viewHeight);
		this.scrollOffset = Math.max(0, Math.min(this.scrollOffset + delta, maxScroll));
	}
}

// ── Archive Confirmation Component ───────────────────────────────────────────

export class MemoryArchiveConfirmComponent extends Container {
	private selectList: SelectList;
	private onConfirm: (confirmed: boolean) => void;

	constructor(theme: Theme, message: string, onConfirm: (confirmed: boolean) => void) {
		super();
		this.onConfirm = onConfirm;

		const options: SelectItem[] = [
			{ value: "yes", label: "Yes, archive it" },
			{ value: "no", label: "No, keep it" },
		];

		this.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
		this.addChild(new Text(theme.fg("warning", message)));

		this.selectList = new SelectList(options, options.length, {
			selectedPrefix: (text) => theme.fg("accent", text),
			selectedText: (text) => theme.fg("accent", text),
			description: (text) => theme.fg("muted", text),
			scrollInfo: (text) => theme.fg("dim", text),
			noMatch: (text) => theme.fg("warning", text),
		});

		this.selectList.onSelect = (item) => this.onConfirm(item.value === "yes");
		this.selectList.onCancel = () => this.onConfirm(false);

		this.addChild(this.selectList);
		this.addChild(new Text(theme.fg("dim", "Enter to confirm • Esc cancel")));
		this.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
	}

	handleInput(keyData: string): void {
		this.selectList.handleInput(keyData);
	}

	override invalidate(): void {
		super.invalidate();
	}
}

// ── Purge Confirmation Component ─────────────────────────────────────────────

export class MemoryPurgeConfirmComponent extends Container {
	private selectList: SelectList;
	private onConfirm: (confirmed: boolean) => void;

	constructor(theme: Theme, message: string, onConfirm: (confirmed: boolean) => void) {
		super();
		this.onConfirm = onConfirm;

		const options: SelectItem[] = [
			{ value: "yes", label: "Yes, permanently delete it" },
			{ value: "no", label: "No, keep it" },
		];

		this.addChild(new DynamicBorder((s: string) => theme.fg("error", s)));
		this.addChild(new Text(theme.fg("error", message)));

		this.selectList = new SelectList(options, options.length, {
			selectedPrefix: (text) => theme.fg("error", text),
			selectedText: (text) => theme.fg("error", text),
			description: (text) => theme.fg("muted", text),
			scrollInfo: (text) => theme.fg("dim", text),
			noMatch: (text) => theme.fg("warning", text),
		});

		this.selectList.onSelect = (item) => this.onConfirm(item.value === "yes");
		this.selectList.onCancel = () => this.onConfirm(false);

		this.addChild(this.selectList);
		this.addChild(new Text(theme.fg("dim", "Enter to confirm • Esc cancel")));
		this.addChild(new DynamicBorder((s: string) => theme.fg("error", s)));
	}

	handleInput(keyData: string): void {
		this.selectList.handleInput(keyData);
	}

	override invalidate(): void {
		super.invalidate();
	}
}
