import type { PromptSuggestLiteAcceptKey, PromptSuggestLiteConfig } from "./config.ts";
import { defaultPromptSuggestLiteConfig } from "./config.ts";

export type PromptSuggestLiteRuntimeStatus = "idle" | "disabled" | "generating" | "ready" | "error";
export type PromptSuggestLiteSource = "model" | "fast-path" | "manual";
export type SteeringClassification = "accepted_exact" | "accepted_edited" | "changed_course";

export type PromptSuggestLiteSuggestion = {
	text: string;
	turnId: string;
	shownAt: string;
	source: PromptSuggestLiteSource;
};

export type PromptSuggestLiteSteeringEvent = {
	turnId: string;
	suggestedPrompt: string;
	actualUserPrompt: string;
	classification: SteeringClassification;
	similarity: number;
	timestamp: string;
};

type PromptSuggestLiteStatusSnapshot = {
	status: PromptSuggestLiteRuntimeStatus;
	lastError?: string;
	lastGeneratedAt?: string;
	lastModelRef?: string;
};

type Listener = () => void;

const STORE_KEY = Symbol.for("jonghakseo.prompt-suggest-lite.store");

class PromptSuggestLiteStore {
	private config: PromptSuggestLiteConfig = defaultPromptSuggestLiteConfig;
	private suggestion: PromptSuggestLiteSuggestion | undefined;
	private revision = 0;
	private statusSnapshot: PromptSuggestLiteStatusSnapshot = { status: "idle" };
	private steeringHistory: PromptSuggestLiteSteeringEvent[] = [];
	private listeners = new Set<Listener>();

	public getConfig(): PromptSuggestLiteConfig {
		return this.config;
	}

	public setConfig(config: PromptSuggestLiteConfig): void {
		this.config = config;
		if (!config.enabled) {
			this.clearSuggestion();
			this.setStatus({ status: "disabled" });
		} else if (this.statusSnapshot.status === "disabled") {
			this.setStatus({ status: "idle" });
		}
		this.emit();
	}

	public subscribe(listener: Listener): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	public getSuggestion(): string | undefined {
		return this.suggestion?.text;
	}

	public getSuggestionDetails(): PromptSuggestLiteSuggestion | undefined {
		return this.suggestion;
	}

	public getRevision(): number {
		return this.revision;
	}

	public getAcceptKeys(): readonly PromptSuggestLiteAcceptKey[] {
		return this.config.acceptKeys;
	}

	public setSuggestion(suggestion: PromptSuggestLiteSuggestion): void {
		this.suggestion = suggestion;
		this.revision += 1;
		this.setStatus({
			status: "ready",
			lastGeneratedAt: suggestion.shownAt,
			lastModelRef: this.config.modelRef,
		});
		this.emit();
	}

	public clearSuggestion(): void {
		if (!this.suggestion) return;
		this.suggestion = undefined;
		this.revision += 1;
		if (this.statusSnapshot.status === "ready") {
			this.statusSnapshot = { ...this.statusSnapshot, status: this.config.enabled ? "idle" : "disabled" };
		}
		this.emit();
	}

	public setStatus(status: PromptSuggestLiteStatusSnapshot): void {
		this.statusSnapshot = status;
		this.emit();
	}

	public getStatus(): PromptSuggestLiteStatusSnapshot {
		return this.statusSnapshot;
	}

	public recordSteering(event: PromptSuggestLiteSteeringEvent): void {
		if (this.config.steeringHistoryWindow <= 0) {
			this.steeringHistory = [];
			this.emit();
			return;
		}
		this.steeringHistory = [...this.steeringHistory, event].slice(-this.config.steeringHistoryWindow);
		this.emit();
	}

	public getSteeringHistory(): readonly PromptSuggestLiteSteeringEvent[] {
		return this.steeringHistory;
	}

	private emit(): void {
		for (const listener of this.listeners) listener();
	}
}

type GlobalPromptSuggestLiteStore = Record<symbol, PromptSuggestLiteStore | undefined>;

const globalStore = globalThis as GlobalPromptSuggestLiteStore;

export const promptSuggestLiteStore = globalStore[STORE_KEY] ?? new PromptSuggestLiteStore();
globalStore[STORE_KEY] = promptSuggestLiteStore;
