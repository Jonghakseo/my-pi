import { CustomEditor, type KeybindingsManager, type Theme } from "@mariozechner/pi-coding-agent";
import {
	type Component,
	type EditorTheme,
	matchesKey,
	truncateToWidth,
	type TUI,
	visibleWidth,
	wrapTextWithAnsi,
} from "@mariozechner/pi-tui";
import { AGENT_SYMBOL_MAP, formatSymbolHints } from "../subagent/constants.ts";

type AutocompleteEditorInternals = {
	autocompleteList?: Pick<Component, "render">;
	isShowingAutocomplete?: () => boolean;
};

type EditorMode = {
	label: string;
	borderToken: "border" | "bashMode" | "dim";
	labelToken: "muted" | "bashMode" | "dim" | "accent";
};

type PromptSuggestionAcceptKey = "space" | "right";

type PromptSuggestionEditorBridge = {
	getSuggestion: () => string | undefined;
	getSuggestionRevision: () => number;
	getAcceptKeys: () => readonly PromptSuggestionAcceptKey[];
	subscribe?: (listener: () => void) => () => void;
};

type GhostState = {
	text: string;
	suggestion: string;
	suffix: string;
	suffixLines: string[];
};

// Cursor rendering varies across themes/terminal modes. Match any ANSI-styled
// single-space cursor block plus common block cursor glyphs.
const END_CURSOR_PATTERN = "(?:\\x1b\\[[0-9;]*m \\x1b\\[[0-9;]*m|█|▌|▋|▉|▓)";
const END_CURSOR = new RegExp(END_CURSOR_PATTERN);

export class PolishedEditor extends CustomEditor {
	private readonly getModelMeta: () => string;
	private readonly getThinkingLevel: () => string | undefined;
	private readonly promptSuggestion?: PromptSuggestionEditorBridge;
	private readonly unsubscribePromptSuggestion?: () => void;
	private readonly uiTheme: Theme;
	private readonly reset = "\x1b[0m";
	private suppressGhost = false;
	private suppressGhostArmedByNonEmptyText = false;
	private lastSuggestion: string | undefined;
	private lastSuggestionRevision = -1;

	constructor(
		tui: TUI,
		theme: EditorTheme,
		keybindings: KeybindingsManager,
		uiTheme: Theme,
		getModelMeta: () => string,
		getThinkingLevel: () => string | undefined,
		promptSuggestion?: PromptSuggestionEditorBridge,
	) {
		super(tui, theme, keybindings, { paddingX: 0 });
		this.borderColor = (text: string) => uiTheme.fg("border", text);
		this.uiTheme = uiTheme;
		this.getModelMeta = getModelMeta;
		this.getThinkingLevel = getThinkingLevel;
		this.promptSuggestion = promptSuggestion;
		this.unsubscribePromptSuggestion = promptSuggestion?.subscribe?.(() => tui.requestRender());
	}

	public dispose(): void {
		this.unsubscribePromptSuggestion?.();
	}

	public override handleInput(data: string): void {
		const ghost = this.getGhostState();
		if (ghost && !this.isAutocompleteVisible() && this.shouldAcceptGhost(data, ghost)) {
			this.setText(ghost.suggestion);
			return;
		}

		if (ghost && ghost.text.length === 0 && !this.isAutocompleteVisible()) {
			this.suppressGhost = true;
			this.suppressGhostArmedByNonEmptyText = false;
		}

		super.handleInput(data);
		this.updateGhostSuppressionLifecycle();
	}

	private fillLine(content: string, width: number): string {
		const truncated = truncateToWidth(content, width, "");
		const pad = " ".repeat(Math.max(0, width - visibleWidth(truncated)));
		return `${truncated}${pad}`;
	}

	private isAutocompleteVisible(): boolean {
		const editorInternals = this as unknown as AutocompleteEditorInternals;
		return (
			typeof editorInternals.isShowingAutocomplete === "function" && Boolean(editorInternals.isShowingAutocomplete())
		);
	}

	private shouldAcceptGhost(data: string, ghost: GhostState): boolean {
		const keys = this.promptSuggestion?.getAcceptKeys() ?? [];
		return keys.some((key) => {
			if (!matchesKey(data, key)) return false;
			return key === "right" || ghost.text.length === 0;
		});
	}

	private updateGhostSuppressionLifecycle(): void {
		if (!this.suppressGhost) return;
		const text = this.getText();
		if (text.length > 0) {
			this.suppressGhostArmedByNonEmptyText = true;
			return;
		}
		if (this.suppressGhostArmedByNonEmptyText) {
			this.suppressGhost = false;
			this.suppressGhostArmedByNonEmptyText = false;
		}
	}

	private getGhostState(): GhostState | undefined {
		if (!this.promptSuggestion) return undefined;
		const revision = this.promptSuggestion.getSuggestionRevision();
		const suggestion = this.promptSuggestion.getSuggestion()?.trim();
		if (revision !== this.lastSuggestionRevision || suggestion !== this.lastSuggestion) {
			this.lastSuggestionRevision = revision;
			this.lastSuggestion = suggestion;
			this.suppressGhost = false;
			this.suppressGhostArmedByNonEmptyText = false;
		}

		if (!suggestion || this.suppressGhost) return undefined;
		const text = this.getText();
		const cursor = this.getCursor();
		if (text.includes("\n")) return undefined;
		if (cursor.line !== 0 || cursor.col !== text.length) return undefined;
		if (!suggestion.startsWith(text)) return undefined;
		const suffix = suggestion.slice(text.length);
		if (!suffix) return undefined;
		const suffixLines = suffix.split("\n");
		if (suffixLines.length > 1 && text.length > 0) return undefined;
		return { text, suggestion, suffix, suffixLines };
	}

	private joinLine(left: string, right: string, width: number): string {
		const ellipsis = this.uiTheme.fg("dim", "…");
		const truncatedRight = truncateToWidth(right, width, ellipsis);
		const rightWidth = visibleWidth(truncatedRight);
		const leftWidth = Math.max(0, width - rightWidth - (left && right ? 1 : 0));
		const truncatedLeft = leftWidth > 0 ? truncateToWidth(left, leftWidth, ellipsis) : "";
		const gap = " ".repeat(Math.max(0, width - visibleWidth(truncatedLeft) - rightWidth));
		return `${truncatedLeft}${gap}${truncatedRight}`;
	}

	private getSubagentLabel(text: string): string | undefined {
		const inlineResumeMatch = /^#(\d+)(?:\s|$)/.exec(text);
		if (inlineResumeMatch?.[1]) {
			return `SUBAGENT · resume #${inlineResumeMatch[1]}`;
		}

		const trimmed = text.trim();
		const peekMatch = /^<>(\d+)$/.exec(trimmed);
		if (peekMatch?.[1]) {
			return `SUBAGENT · peek #${peekMatch[1]}`;
		}
		if (trimmed === "><") {
			return "SUBAGENT · back";
		}

		if (text.startsWith("<<<")) {
			return "SUBAGENT · clear";
		}
		if (text.startsWith("<<")) {
			return "SUBAGENT · manage";
		}

		const legacyHidden = text.startsWith(">>>");
		const compactHidden = text.startsWith(">") && !text.startsWith(">>") && !text.startsWith("><");
		const visible = text.startsWith(">>") && !legacyHidden;
		if (!visible && !compactHidden && !legacyHidden) {
			return undefined;
		}

		const prefix = legacyHidden ? ">>>" : compactHidden ? ">" : ">>";
		const baseLabel = legacyHidden || compactHidden ? "SUBAGENT · hidden" : "SUBAGENT";
		const forwarded = text.slice(prefix.length).trim();
		if (!forwarded) {
			return baseLabel;
		}

		const symbolAgent = AGENT_SYMBOL_MAP[forwarded[0] ?? ""];
		if (symbolAgent) {
			return `${baseLabel} · ${symbolAgent}`;
		}

		const resumeMatch = /^(\d+)(?:\s|$)/.exec(forwarded);
		if (resumeMatch?.[1]) {
			return `${baseLabel} · resume #${resumeMatch[1]}`;
		}

		return baseLabel;
	}

	private getEditorMode(text: string): EditorMode {
		if (text.startsWith("!!")) {
			return {
				label: "BASH · no ctx",
				borderToken: "dim",
				labelToken: "dim",
			};
		}
		if (text.startsWith("!")) {
			return {
				label: "BASH",
				borderToken: "bashMode",
				labelToken: "bashMode",
			};
		}
		const subagentLabel = this.getSubagentLabel(text);
		if (subagentLabel) {
			return {
				label: subagentLabel,
				borderToken: "border",
				labelToken: "accent",
			};
		}
		return {
			label: "",
			borderToken: "border",
			labelToken: "muted",
		};
	}

	private getStatusLabel(text: string, mode: EditorMode): string {
		const baseLabel = mode.label ? this.uiTheme.fg(mode.labelToken, mode.label) : "";
		const trimmed = text.trimEnd();
		if (trimmed === ">>") {
			return `${baseLabel}${this.uiTheme.fg("muted", ` · ${formatSymbolHints()}`)}`;
		}
		if (trimmed === ">" || trimmed === ">>>") {
			return `${baseLabel}${this.uiTheme.fg("muted", ` · ${formatSymbolHints(">")}`)}`;
		}
		if (trimmed.startsWith("<<<")) {
			return baseLabel;
		}
		if (trimmed.startsWith("<<")) {
			return `${baseLabel}${this.uiTheme.fg("muted", " · << abort latest  <<N abort/clear #N  <<N,M abort/clear many")}`;
		}

		return baseLabel;
	}

	private renderGhostLineAtColumn(text: string, col: number, width: number): string {
		const available = Math.max(0, width - col);
		const truncated = truncateToWidth(text, available, "");
		const used = col + visibleWidth(truncated);
		const padding = " ".repeat(Math.max(0, width - used));
		return truncateToWidth(`${" ".repeat(col)}${truncated}${padding}`, width, "");
	}

	private renderGhostFallback(lines: string[], ghost: GhostState, width: number): string[] {
		if (ghost.text.length > 0 || lines.length < 3) return lines;
		const nextLines = [...lines];
		const ghostLines = ghost.suggestion
			.split("\n")
			.flatMap((line) => wrapTextWithAnsi(this.uiTheme.fg("dim", line), Math.max(1, width)));
		const renderedGhostLines = (ghostLines.length > 0 ? ghostLines : [this.uiTheme.fg("dim", ghost.suggestion)]).map(
			(line) => this.renderGhostLineAtColumn(line, 0, width),
		);
		const bottomBorderIndex = nextLines.length - 1;
		nextLines.splice(1, Math.max(1, bottomBorderIndex - 1), ...renderedGhostLines);
		return nextLines;
	}

	private renderGhostInEditorFrame(lines: string[], width: number): string[] {
		const ghost = this.getGhostState();
		if (!ghost || this.isAutocompleteVisible()) return lines;
		if (lines.length < 3) return lines;

		const nextLines = [...lines];
		const contentLineIndex = 1;
		const firstContentLine = nextLines[contentLineIndex];
		if (!firstContentLine) return lines;
		const match = END_CURSOR.exec(firstContentLine);
		if (!match) return this.renderGhostFallback(lines, ghost, width);

		const cursorCol = visibleWidth(firstContentLine.slice(0, match.index));
		const lineStartCol = Math.max(0, cursorCol - visibleWidth(ghost.text));
		const firstSuffixLine = ghost.suffixLines[0] ?? "";
		const firstLineAvailable = Math.max(1, width - (cursorCol + 1));
		const firstSuffixWrapped = wrapTextWithAnsi(this.uiTheme.fg("dim", firstSuffixLine), firstLineAvailable);
		const firstLineGhost = firstSuffixWrapped[0] ?? "";

		nextLines[contentLineIndex] = truncateToWidth(
			firstContentLine.replace(END_CURSOR, (cursor) => `${cursor}${firstLineGhost}`),
			width,
			"",
		);

		const continuationLines: string[] = [];
		continuationLines.push(...firstSuffixWrapped.slice(1));
		for (let index = 1; index < ghost.suffixLines.length; index += 1) {
			continuationLines.push(
				...wrapTextWithAnsi(this.uiTheme.fg("dim", ghost.suffixLines[index] ?? ""), Math.max(1, width - lineStartCol)),
			);
		}
		if (continuationLines.length === 0) return nextLines;

		for (let index = 0; index < continuationLines.length; index += 1) {
			const ghostLine = this.renderGhostLineAtColumn(continuationLines[index] ?? "", lineStartCol, width);
			const targetIndex = contentLineIndex + 1 + index;
			const bottomBorderIndex = nextLines.length - 1;
			if (targetIndex < bottomBorderIndex) nextLines[targetIndex] = ghostLine;
			else nextLines.splice(bottomBorderIndex, 0, ghostLine);
		}

		return nextLines;
	}

	render(width: number): string[] {
		const innerWidth = Math.max(1, width - 2);
		const rendered = super.render(innerWidth);
		const editorInternals = this as unknown as AutocompleteEditorInternals;
		const isShowingAutocomplete =
			typeof editorInternals.isShowingAutocomplete === "function"
				? Boolean(editorInternals.isShowingAutocomplete())
				: false;

		if (rendered.length < 2) {
			return super.render(width);
		}

		const { autocompleteList } = editorInternals;
		const autocompleteCount =
			isShowingAutocomplete && typeof autocompleteList?.render === "function"
				? autocompleteList.render(innerWidth).length
				: 0;
		const editorFrame =
			autocompleteCount > 0 && autocompleteCount < rendered.length ? rendered.slice(0, -autocompleteCount) : rendered;
		const autocompleteLines =
			autocompleteCount > 0 && autocompleteCount < rendered.length ? rendered.slice(-autocompleteCount) : [];

		if (editorFrame.length < 2) {
			return rendered;
		}

		const editorLines = this.renderGhostInEditorFrame(editorFrame, innerWidth).slice(1, -1);
		const text = this.getText().trimStart();
		const metaParts = [this.getModelMeta()];
		const thinkingLevel = this.getThinkingLevel();
		if (thinkingLevel && thinkingLevel !== "off") {
			metaParts.push(this.uiTheme.fg("muted", thinkingLevel));
		}
		const meta = metaParts.filter(Boolean).join(this.uiTheme.fg("border", "  "));
		const mode = this.getEditorMode(text);
		const statusLine = this.joinLine(this.getStatusLabel(text, mode), meta, innerWidth);

		const rail = `${this.uiTheme.fg(mode.borderToken, "│")}${this.reset} `;
		const top = `${this.uiTheme.fg(mode.borderToken, "┌")}${this.uiTheme.fg(mode.borderToken, "─".repeat(Math.max(0, width - 1)))}`;
		const bottom = `${this.uiTheme.fg(mode.borderToken, "└")}${this.uiTheme.fg(mode.borderToken, "─".repeat(Math.max(0, width - 1)))}`;
		const lines = ["", ...editorLines, "", statusLine];

		return [top, ...lines.map((line) => `${rail}${this.fillLine(line, innerWidth)}`), bottom, ...autocompleteLines];
	}
}
