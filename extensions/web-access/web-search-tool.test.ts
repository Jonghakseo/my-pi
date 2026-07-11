import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { loadCuratorBootstrap } from "./config-runtime.js";
import { registerWebSearchTool } from "./web-search-tool.js";
import { createRuntimeSupport, state, type PendingCurate } from "./runtime-support.js";

vi.mock("./config-runtime.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("./config-runtime.js")>();
	return {
		...actual,
		loadConfigForExtensionInit: vi.fn(() => ({ workflow: "summary-review" })),
		loadCuratorBootstrap: vi.fn(),
	};
});

vi.mock("./gemini-search.js", () => ({
	search: vi.fn(async () => ({ answer: "answer", results: [], provider: "gemini" })),
}));

interface Deferred<T> {
	promise: Promise<T>;
	resolve: (value: T) => void;
}

function deferred<T>(): Deferred<T> {
	let resolve = (_value: T): void => {};
	const promise = new Promise<T>((promiseResolve) => {
		resolve = promiseResolve;
	});
	return { promise, resolve };
}

const bootstrap = {
	availableProviders: { gemini: true, perplexity: false, exa: false },
	defaultProvider: "gemini" as const,
	timeoutSeconds: 60,
};

function createHarness() {
	let tool: { execute: (...args: any[]) => Promise<any> } | undefined;
	const pi = {
		registerTool(registeredTool: typeof tool) {
			tool = registeredTool;
		},
	} as unknown as ExtensionAPI;
	const support = createRuntimeSupport(pi);
	const opened: PendingCurate[] = [];
	registerWebSearchTool(pi, {
		...support,
		loadSummaryModelChoices: vi.fn(async () => ({ summaryModels: [], defaultSummaryModel: null })),
		openCuratorBrowser: vi.fn(async (pc: PendingCurate) => {
			opened.push(pc);
		}),
	});
	if (!tool) throw new Error("web_search tool was not registered");
	const registeredTool = tool;
	const execute = (query: string) =>
		registeredTool.execute("call", { query }, undefined, undefined, {
			hasUI: true,
			model: undefined,
			modelRegistry: undefined,
		});
	return { execute, opened, closeCurator: support.closeCurator };
}

async function settleWithin<T>(promise: Promise<T>, timeoutMs = 100): Promise<T> {
	return Promise.race([
		promise,
		new Promise<never>((_, reject) => setTimeout(() => reject(new Error("promise did not settle")), timeoutMs)),
	]);
}

describe("web_search curator bootstrap ownership", () => {
	beforeEach(() => {
		state.pendingCurate = null;
		state.activeCurator = null;
		state.glimpseWin = null;
		vi.mocked(loadCuratorBootstrap).mockReset();
	});

	it("cancels a stale concurrent bootstrap while the latest call remains owner", async () => {
		const firstBootstrap = deferred<typeof bootstrap>();
		const secondBootstrap = deferred<typeof bootstrap>();
		vi.mocked(loadCuratorBootstrap)
			.mockReturnValueOnce(firstBootstrap.promise)
			.mockReturnValueOnce(secondBootstrap.promise);
		const { execute, opened } = createHarness();

		const first = execute("first");
		const second = execute("second");
		secondBootstrap.resolve(bootstrap);
		await vi.waitFor(() => expect(opened).toHaveLength(1));
		const latest = opened[0];

		firstBootstrap.resolve(bootstrap);
		const staleResult = await settleWithin(first);
		expect(staleResult.details).toMatchObject({ cancelled: true, cancelReason: "stale" });
		expect(state.pendingCurate).toBe(latest);

		latest.cancel("user");
		await expect(settleWithin(second)).resolves.toMatchObject({ details: { cancelled: true, cancelReason: "user" } });
	});

	it("cancels a bootstrap when the curator is closed before it opens", async () => {
		const pendingBootstrap = deferred<typeof bootstrap>();
		vi.mocked(loadCuratorBootstrap).mockReturnValueOnce(pendingBootstrap.promise);
		const { execute, opened, closeCurator } = createHarness();

		const result = execute("closing");
		closeCurator();
		pendingBootstrap.resolve(bootstrap);

		await expect(settleWithin(result)).resolves.toMatchObject({
			details: { cancelled: true, cancelReason: "stale" },
		});
		expect(opened).toHaveLength(0);
	});

	it("preserves an ordinary single curated search", async () => {
		vi.mocked(loadCuratorBootstrap).mockResolvedValueOnce(bootstrap);
		const { execute, opened } = createHarness();

		const result = execute("single");
		await vi.waitFor(() => expect(opened).toHaveLength(1));
		opened[0].cancel("user");

		await expect(settleWithin(result)).resolves.toMatchObject({
			details: { cancelled: true, cancelReason: "user" },
		});
	});
});
