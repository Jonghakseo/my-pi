import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { KeyId } from "@earendil-works/pi-tui";
import { activityMonitor } from "./activity.js";
import { updateWidget } from "./activity-widget.js";
import { clearCloneCache } from "./clone-cache.js";
import { DEFAULT_SHORTCUTS, loadConfigForExtensionInit } from "./config-runtime.js";
import { clearResults, restoreFromSession } from "./storage.js";
import { closeCurator, state } from "./state.js";
import { registerCommands } from "./commands.js";
import { registerContentTools } from "./content-tools.js";
import type { createRuntimeSupport } from "./runtime-support.js";
import { registerWebSearchTool } from "./web-search-tool.js";

export type RuntimeSupport = ReturnType<typeof createRuntimeSupport>;
export type GetRuntimeSupport = () => Promise<RuntimeSupport>;

function abortPendingFetches(): void {
	for (const controller of state.pendingFetches.values()) controller.abort();
	state.pendingFetches.clear();
}

export default function initializeWebAccess(pi: ExtensionAPI): void {
	const initConfig = loadConfigForExtensionInit();
	const curateKey = initConfig.shortcuts?.curate || DEFAULT_SHORTCUTS.curate;
	const activityKey = initConfig.shortcuts?.activity || DEFAULT_SHORTCUTS.activity;
	// Lazily load the heavy runtime (extract/curator/summary modules) on first use
	// so extension startup stays cheap.
	let supportPromise: Promise<RuntimeSupport> | null = null;
	const getSupport: GetRuntimeSupport = () => {
		supportPromise ??= import("./runtime-support.js").then((m) => m.createRuntimeSupport(pi));
		return supportPromise;
	};
	const handleSessionChange = (ctx: ExtensionContext) => {
		abortPendingFetches();
		closeCurator();
		clearCloneCache();
		state.sessionActive = true;
		restoreFromSession(ctx);
		state.widgetUnsubscribe?.();
		state.widgetUnsubscribe = null;
		activityMonitor.clear();
		if (state.widgetVisible) {
			state.widgetUnsubscribe = activityMonitor.onUpdate(() => updateWidget(ctx));
			updateWidget(ctx);
		}
	};

	pi.registerShortcut(curateKey as KeyId, {
		description: "Review search results",
		handler: async (ctx) => {
			const pendingCurate = state.pendingCurate;
			if (!pendingCurate) return;

			if (pendingCurate.phase === "searching") {
				pendingCurate.browserPromise = getSupport().then((support) => support.openCuratorBrowser(pendingCurate, false));
				ctx.ui.notify("Opening curator — remaining searches will stream in", "info");
				return;
			}
		},
	});

	pi.registerShortcut(activityKey as KeyId, {
		description: "Toggle web search activity",
		handler: async (ctx) => {
			state.widgetVisible = !state.widgetVisible;
			if (state.widgetVisible) {
				state.widgetUnsubscribe = activityMonitor.onUpdate(() => updateWidget(ctx));
				updateWidget(ctx);
			} else {
				state.widgetUnsubscribe?.();
				state.widgetUnsubscribe = null;
				ctx.ui.setWidget("web-activity", undefined);
			}
		},
	});

	pi.on("session_start", async (_event, ctx) => handleSessionChange(ctx));
	pi.on("session_tree", async (_event, ctx) => handleSessionChange(ctx));

	pi.on("session_shutdown", () => {
		state.sessionActive = false;
		abortPendingFetches();
		closeCurator();
		clearCloneCache();
		clearResults();
		// Unsubscribe before clear() to avoid callback with stale ctx
		state.widgetUnsubscribe?.();
		state.widgetUnsubscribe = null;
		activityMonitor.clear();
		state.widgetVisible = false;
	});

	registerWebSearchTool(pi, getSupport);
	registerContentTools(pi);
	registerCommands(pi, getSupport);
}
