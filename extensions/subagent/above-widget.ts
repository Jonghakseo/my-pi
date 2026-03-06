/**
	* Above-editor subagent widget is disabled.
	*
	* All subagent runs are rendered in the below-editor widget regardless of launch source.
	*/

import type { SubagentStore } from "./store.js";

export function updatePixelWidget(store: SubagentStore, ctx?: any): void {
	const activeCtx = ctx ?? store.pixelWidgetCtx;
	if (!activeCtx?.hasUI) return;
	store.pixelWidgetCtx = activeCtx;
	activeCtx.ui.setWidget("pixel-subagents", undefined);
}

export function cleanupPixelTimer(): void {
	// no-op: above-editor widget is disabled
	return;
}
