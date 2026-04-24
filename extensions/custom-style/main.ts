import type { ExtensionAPI, ExtensionContext, KeybindingsManager } from "@mariozechner/pi-coding-agent";
import type { EditorTheme, TUI } from "@mariozechner/pi-tui";
import { type CustomStyleConfig, ensureConfigExists, loadConfig } from "./config.ts";
import { installFooter } from "./footer.ts";
import { isCodexFastModeEnabled, shouldUseCodexFastBadge } from "./footer-state.ts";
import { PolishedEditor } from "./ui.ts";

type SyncedState = {
	modelLabel: string;
};

function syncState(ctx: ExtensionContext): SyncedState {
	return {
		modelLabel: ctx.model?.id ?? "no-model",
	};
}

function installEditor(pi: ExtensionAPI, ctx: ExtensionContext, getState: () => SyncedState) {
	if (!ctx.hasUI) return;

	let currentEditor: PolishedEditor | undefined;
	let autocompleteFixed = false;

	type AutocompleteEditorInternals = {
		autocompleteProvider?: unknown;
	};

	const editorFactory = (tui: TUI, theme: EditorTheme, keybindings: KeybindingsManager) => {
		const editor = new PolishedEditor(
			tui,
			theme,
			keybindings,
			ctx.ui.theme,
			() => {
				const state = getState();
				const modelLabel = shouldUseCodexFastBadge(ctx.model?.provider, isCodexFastModeEnabled())
					? `${state.modelLabel} ⚡`
					: state.modelLabel;
				return ctx.ui.theme.fg("accent", modelLabel);
			},
			() => pi.getThinkingLevel(),
		);
		currentEditor = editor;

		const originalHandleInput = editor.handleInput.bind(editor);
		editor.handleInput = (data: string) => {
			const editorInternals = editor as unknown as AutocompleteEditorInternals;
			if (!autocompleteFixed && !editorInternals.autocompleteProvider) {
				autocompleteFixed = true;
				ctx.ui.setEditorComponent(editorFactory);
				currentEditor?.handleInput(data);
				return;
			}
			originalHandleInput(data);
		};

		return editor;
	};

	ctx.ui.setEditorComponent(editorFactory);
}

export default function (pi: ExtensionAPI) {
	let currentConfig: CustomStyleConfig = loadConfig();
	let latestSyncedState: SyncedState = {
		modelLabel: "no-model",
	};

	const doSync = (ctx: ExtensionContext) => {
		latestSyncedState = syncState(ctx);
	};

	const installUi = (ctx: ExtensionContext) => {
		if (!ctx.hasUI) return;
		ensureConfigExists();
		currentConfig = loadConfig();
		doSync(ctx);
		installFooter(pi, ctx, currentConfig);
		installEditor(pi, ctx, () => latestSyncedState);
	};

	pi.on("session_start", async (_event, ctx) => {
		installUi(ctx);
	});

	pi.on("session_tree", async (_event, ctx) => {
		installUi(ctx);
	});

	pi.on("agent_start", async (_event, ctx) => {
		doSync(ctx);
	});

	pi.on("agent_end", async (_event, ctx) => {
		doSync(ctx);
	});

	pi.on("model_select", async (_event, ctx) => {
		doSync(ctx);
	});

	pi.on("message_end", async (_event, ctx) => {
		doSync(ctx);
	});

	pi.on("tool_execution_end", async (_event, ctx) => {
		doSync(ctx);
	});

	pi.on("session_compact", async (_event, ctx) => {
		doSync(ctx);
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		if (!ctx.hasUI) return;
		ctx.ui.setFooter(undefined);
		ctx.ui.setEditorComponent(undefined);
	});
}
