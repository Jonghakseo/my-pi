import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { KeyId } from "@earendil-works/pi-tui";
import { activityMonitor } from "./activity.js";
import { updateWidget } from "./activity-widget.js";
import { DEFAULT_SHORTCUTS, loadConfigForExtensionInit } from "./config-runtime.js";
import { clearCloneCache } from "./github-extract.js";
import { clearResults, restoreFromSession } from "./storage.js";
import { registerCommands } from "./commands.js";
import { registerContentTools } from "./content-tools.js";
import { createRuntimeSupport, state } from "./runtime-support.js";
import { registerWebSearchTool } from "./web-search-tool.js";

function abortPendingFetches(): void {
	for (const controller of state.pendingFetches.values()) controller.abort();
	state.pendingFetches.clear();
}

export default function initializeWebAccess(pi: ExtensionAPI): void {
	const initConfig = loadConfigForExtensionInit();
	const curateKey = initConfig.shortcuts?.curate || DEFAULT_SHORTCUTS.curate;
	const activityKey = initConfig.shortcuts?.activity || DEFAULT_SHORTCUTS.activity;
	const support = createRuntimeSupport(pi);
	const handleSessionChange = (ctx: ExtensionContext) => {
		abortPendingFetches();
		support.closeCurator();
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
			if (!state.pendingCurate) return;

			if (state.pendingCurate.phase === "searching") {
				state.pendingCurate.browserPromise = support.openCuratorBrowser(state.pendingCurate, false);
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
		support.closeCurator();
		clearCloneCache();
		clearResults();
		// Unsubscribe before clear() to avoid callback with stale ctx
		state.widgetUnsubscribe?.();
		state.widgetUnsubscribe = null;
		activityMonitor.clear();
		state.widgetVisible = false;
	});

	registerWebSearchTool(pi, support);
	registerContentTools(pi);
	registerCommands(pi, support);
}
