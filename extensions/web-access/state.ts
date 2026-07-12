/**
 * Shared mutable state for the web-access extension.
 *
 * Kept dependency-free (type-only imports) so the startup path can load it
 * without pulling in the heavy extract/curator module graph.
 */
import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import type { CuratorWorkflow, ProviderAvailability } from "./config-runtime.js";
import type { CuratorServerHandle } from "./curator-server.js";
import type { ExtractedContent } from "./extract.js";
import type { ResolvedSearchProvider } from "./gemini-search.js";
import type { GlimpseWindow } from "./glimpse.js";
import type { QueryResultData } from "./storage.js";
import type { SummaryGenerationContext } from "./summary-review.js";

export const state = {
	pendingFetches: new Map<string, AbortController>(),
	sessionActive: false,
	widgetVisible: false,
	widgetUnsubscribe: null as (() => void) | null,
	activeCurator: null as CuratorServerHandle | null,
	glimpseWin: null as GlimpseWindow | null,
	pendingCurate: null as PendingCurate | null,
	curatorGeneration: 0,
};

export interface PendingCurate {
	phase: "searching" | "curating";
	workflow: CuratorWorkflow;
	summaryContext: SummaryGenerationContext;
	searchResults: Map<number, QueryResultData>;
	allInlineContent: ExtractedContent[];
	queryList: string[];
	includeContent: boolean;
	numResults?: number;
	recencyFilter?: "day" | "week" | "month" | "year";
	domainFilter?: string[];
	availableProviders: ProviderAvailability;
	defaultProvider: ResolvedSearchProvider;
	summaryModels: Array<{ value: string; label: string }>;
	defaultSummaryModel: string | null;
	timeoutSeconds: number;
	onUpdate:
		| ((update: { content: Array<{ type: string; text: string }>; details?: Record<string, unknown> }) => void)
		| undefined;
	signal: AbortSignal | undefined;
	abortSearches: () => void;
	finish: (value: AgentToolResult<Record<string, unknown>>) => void;
	cancel: (reason?: "user" | "stale") => void;
	browserPromise?: Promise<void>;
}

function cancelPendingCurate(reason: "user" | "stale" = "stale"): void {
	state.pendingCurate?.cancel(reason);
}

export function buildCurationCancelledReturn(reason: "user" | "stale"): AgentToolResult<Record<string, unknown>> {
	const message = `Search curation cancelled (${reason}).`;
	return {
		content: [{ type: "text", text: message }],
		details: {
			error: message,
			cancelled: true,
			cancelReason: reason,
		},
	};
}

export function closeCurator(): void {
	state.curatorGeneration++;
	const win = state.glimpseWin;
	state.glimpseWin = null;
	try {
		win?.close();
	} catch {}
	cancelPendingCurate();
	if (state.activeCurator) {
		state.activeCurator.close();
		state.activeCurator = null;
	}
}
