import { CustomEditor, type KeybindingsManager, type Theme } from "@mariozechner/pi-coding-agent";
import { type Component, type EditorTheme, type TUI, truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";
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

export class PolishedEditor extends CustomEditor {
	private readonly getModelMeta: () => string;
	private readonly getThinkingLevel: () => string | undefined;
	private readonly uiTheme: Theme;
	private readonly reset = "\x1b[0m";

	constructor(
		tui: TUI,
		theme: EditorTheme,
		keybindings: KeybindingsManager,
		uiTheme: Theme,
		getModelMeta: () => string,
		getThinkingLevel: () => string | undefined,
	) {
		super(tui, theme, keybindings, { paddingX: 0 });
		this.borderColor = (text: string) => uiTheme.fg("border", text);
		this.uiTheme = uiTheme;
		this.getModelMeta = getModelMeta;
		this.getThinkingLevel = getThinkingLevel;
	}

	private fillLine(content: string, width: number): string {
		const truncated = truncateToWidth(content, width, "");
		const pad = " ".repeat(Math.max(0, width - visibleWidth(truncated)));
		return `${truncated}${pad}`;
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
		const baseLabel = this.uiTheme.fg(mode.labelToken, mode.label);
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

		const editorLines = editorFrame.slice(1, -1);
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
