import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { registerCommands } from "./commands.js";
import { loadCuratorBootstrap } from "./config-runtime.js";
import { startCuratorServer, type CuratorServerHandle } from "./curator-server.js";
import { createRuntimeSupport, state } from "./runtime-support.js";

vi.mock("node:os", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:os")>();
	return { ...actual, platform: () => "linux" as NodeJS.Platform };
});

vi.mock("./config-runtime.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("./config-runtime.js")>();
	return {
		...actual,
		loadCuratorBootstrap: vi.fn(),
	};
});

vi.mock("./curator-server.js", () => ({
	startCuratorServer: vi.fn(),
}));

vi.mock("./glimpse.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("./glimpse.js")>();
	return {
		...actual,
		openInBrowser: vi.fn(async () => {}),
	};
});

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

function createHandle(url: string): CuratorServerHandle {
	return {
		server: {} as CuratorServerHandle["server"],
		url,
		close: vi.fn(),
		pushResult: vi.fn(),
		pushError: vi.fn(),
		searchesDone: vi.fn(),
	};
}

function createHarness() {
	let handler: ((args: string, ctx: any) => Promise<void>) | undefined;
	const pi = {
		registerCommand(name: string, command: { handler: typeof handler }) {
			if (name === "websearch") handler = command.handler;
		},
		sendMessage: vi.fn(),
	} as unknown as ExtensionAPI;
	const support = createRuntimeSupport(pi);
	registerCommands(pi, {
		...support,
		loadSummaryModelChoices: vi.fn(async () => ({ summaryModels: [], defaultSummaryModel: null })),
	});
	if (!handler) throw new Error("websearch command was not registered");
	const registeredHandler = handler;
	const ctx = {
		model: undefined,
		modelRegistry: undefined,
		ui: { notify: vi.fn() },
	};
	return { execute: (args = "") => registeredHandler(args, ctx), ctx };
}

describe("websearch command curator startup ownership", () => {
	beforeEach(() => {
		state.pendingCurate = null;
		state.activeCurator = null;
		state.glimpseWin = null;
		vi.mocked(loadCuratorBootstrap).mockReset();
		vi.mocked(startCuratorServer).mockReset();
	});

	it("does not let a stale bootstrap replace a newer command curator", async () => {
		const firstBootstrap = deferred<typeof bootstrap>();
		const latestHandle = createHandle("http://latest");
		vi.mocked(loadCuratorBootstrap).mockReturnValueOnce(firstBootstrap.promise).mockResolvedValueOnce(bootstrap);
		vi.mocked(startCuratorServer).mockResolvedValueOnce(latestHandle);
		const { execute } = createHarness();

		const stale = execute();
		await execute();
		firstBootstrap.resolve(bootstrap);
		await stale;

		expect(startCuratorServer).toHaveBeenCalledTimes(1);
		expect(state.activeCurator).toBe(latestHandle);
	});

	it("closes a stale server handle that resolves after a newer curator starts", async () => {
		const staleServer = deferred<CuratorServerHandle>();
		const staleHandle = createHandle("http://stale");
		const latestHandle = createHandle("http://latest");
		vi.mocked(loadCuratorBootstrap).mockResolvedValue(bootstrap);
		vi.mocked(startCuratorServer).mockReturnValueOnce(staleServer.promise).mockResolvedValueOnce(latestHandle);
		const { execute } = createHarness();

		const stale = execute();
		await vi.waitFor(() => expect(startCuratorServer).toHaveBeenCalledTimes(1));
		await execute();
		staleServer.resolve(staleHandle);
		await stale;

		expect(staleHandle.close).toHaveBeenCalledOnce();
		expect(state.activeCurator).toBe(latestHandle);
	});

	it("opens one current handle for an ordinary command startup", async () => {
		const handle = createHandle("http://single");
		vi.mocked(loadCuratorBootstrap).mockResolvedValueOnce(bootstrap);
		vi.mocked(startCuratorServer).mockResolvedValueOnce(handle);
		const { execute } = createHarness();

		await execute();

		expect(startCuratorServer).toHaveBeenCalledOnce();
		expect(state.activeCurator).toBe(handle);
		expect(handle.searchesDone).toHaveBeenCalledOnce();
	});
});
