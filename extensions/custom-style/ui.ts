import { CustomEditor, type KeybindingsManager, type Theme } from "@mariozechner/pi-coding-agent";
import { type Component, type EditorTheme, type TUI, truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";

type AutocompleteEditorInternals = {
	autocompleteList?: Pick<Component, "render">;
	isShowingAutocomplete?: () => boolean;
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
		const metaParts = [this.getModelMeta()];
		const thinkingLevel = this.getThinkingLevel();
		if (thinkingLevel && thinkingLevel !== "off") {
			metaParts.push(this.uiTheme.fg("muted", thinkingLevel));
		}
		const meta = metaParts.filter(Boolean).join(this.uiTheme.fg("border", "  "));

		const rail = `${this.uiTheme.fg("border", "│")}${this.reset} `;
		const top = `${this.uiTheme.fg("border", "┌")}${this.uiTheme.fg("border", "─".repeat(Math.max(0, width - 1)))}`;
		const bottom = `${this.uiTheme.fg("border", "└")}${this.uiTheme.fg("border", "─".repeat(Math.max(0, width - 1)))}`;
		const lines = ["", ...editorLines, "", meta];

		return [top, ...lines.map((line) => `${rail}${this.fillLine(line, innerWidth)}`), bottom, ...autocompleteLines];
	}
}
