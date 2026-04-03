import { beforeEach, describe, expect, it, vi } from "vitest";

const mockSessionManager = {
	getActive: vi.fn(),
	unregisterActive: vi.fn(),
	list: vi.fn(() => []),
	take: vi.fn(),
	get: vi.fn(),
	add: vi.fn(),
	registerActive: vi.fn(),
	remove: vi.fn(),
	writeToActive: vi.fn(),
	restore: vi.fn(),
	restartAutoCleanup: vi.fn(),
	scheduleCleanup: vi.fn(),
	killAll: vi.fn(),
};

const mockGenerateSessionId = vi.fn(() => "mock-session");
const mockLoadConfig = vi.fn(() => ({
	exitAutoCloseDelay: 10,
	overlayWidthPercent: 95,
	overlayHeightPercent: 60,
	scrollbackLines: 5000,
	ansiReemit: true,
	handoffPreviewEnabled: true,
	handoffPreviewLines: 30,
	handoffPreviewMaxChars: 2000,
	handoffSnapshotEnabled: false,
	handoffSnapshotLines: 200,
	handoffSnapshotMaxChars: 12000,
	transferLines: 200,
	transferMaxChars: 20000,
	completionNotifyLines: 50,
	completionNotifyMaxChars: 5000,
	handsFreeUpdateMode: "on-quiet",
	handsFreeUpdateInterval: 60000,
	handsFreeQuietThreshold: 8000,
	autoExitGracePeriod: 15000,
	handsFreeUpdateMaxChars: 1500,
	handsFreeMaxTotalChars: 100000,
	minQueryIntervalSeconds: 60,
}));

const mockCoordinator = {
	replaceBackgroundWidgetCleanup: vi.fn(),
	clearBackgroundWidget: vi.fn(),
	disposeAllMonitors: vi.fn(),
	deleteMonitor: vi.fn(),
	disposeMonitor: vi.fn(),
	getMonitor: vi.fn(),
	setMonitor: vi.fn(),
	markAgentHandledCompletion: vi.fn(),
	consumeAgentHandledCompletion: vi.fn(() => false),
	beginOverlay: vi.fn(() => true),
	endOverlay: vi.fn(),
	isOverlayOpen: vi.fn(() => false),
};

class MockPtyTerminalSession {
	exited = false;
	write = vi.fn();
}

class MockHeadlessDispatchMonitor {
	disposed = false;
	constructor(..._args: unknown[]) {}
	getResult() {
		return undefined;
	}
	registerCompleteCallback() {}
}

vi.mock("../interactive-shell/overlay-component.js", () => ({
	InteractiveShellOverlay: class {},
}));

vi.mock("../interactive-shell/reattach-overlay.js", () => ({
	ReattachOverlay: class {},
}));

vi.mock("../interactive-shell/pty-session.js", () => ({
	PtyTerminalSession: MockPtyTerminalSession,
}));

vi.mock("../interactive-shell/session-manager.js", () => ({
	sessionManager: mockSessionManager,
	generateSessionId: mockGenerateSessionId,
}));

vi.mock("../interactive-shell/config.js", () => ({
	loadConfig: mockLoadConfig,
}));

vi.mock("../interactive-shell/key-encoding.js", () => ({
	translateInput: (value: unknown) => value,
}));

vi.mock("../interactive-shell/headless-monitor.js", () => ({
	HeadlessDispatchMonitor: MockHeadlessDispatchMonitor,
}));

vi.mock("../interactive-shell/background-widget.js", () => ({
	setupBackgroundWidget: vi.fn(() => undefined),
}));

vi.mock("../interactive-shell/notification-utils.js", () => ({
	buildDispatchNotification: vi.fn(() => "dispatch"),
	buildHandsFreeUpdateMessage: vi.fn(() => undefined),
	buildResultNotification: vi.fn(() => "result"),
	summarizeInteractiveResult: vi.fn(() => "summary"),
}));

vi.mock("../interactive-shell/session-query.js", () => ({
	createSessionQueryState: vi.fn(() => ({ lastQueryTime: 0, incrementalReadPosition: 0 })),
	getSessionOutput: vi.fn(() => ({ output: "", truncated: false, totalBytes: 0, totalLines: 0 })),
}));

vi.mock("../interactive-shell/runtime-coordinator.js", () => ({
	InteractiveShellCoordinator: class {
		replaceBackgroundWidgetCleanup = mockCoordinator.replaceBackgroundWidgetCleanup;
		clearBackgroundWidget = mockCoordinator.clearBackgroundWidget;
		disposeAllMonitors = mockCoordinator.disposeAllMonitors;
		deleteMonitor = mockCoordinator.deleteMonitor;
		disposeMonitor = mockCoordinator.disposeMonitor;
		getMonitor = mockCoordinator.getMonitor;
		setMonitor = mockCoordinator.setMonitor;
		markAgentHandledCompletion = mockCoordinator.markAgentHandledCompletion;
		consumeAgentHandledCompletion = mockCoordinator.consumeAgentHandledCompletion;
		beginOverlay = mockCoordinator.beginOverlay;
		endOverlay = mockCoordinator.endOverlay;
		isOverlayOpen = mockCoordinator.isOverlayOpen;
	},
}));

function createPi() {
	let tool: any;
	return {
		api: {
			on: vi.fn(),
			registerTool: vi.fn((definition: any) => {
				tool = definition;
			}),
			registerCommand: vi.fn(),
			sendMessage: vi.fn(),
			events: { emit: vi.fn() },
		},
		getTool: () => tool,
	};
}

async function loadTool() {
	vi.resetModules();
	const mod = await import("../interactive-shell/index.js");
	const pi = createPi();
	mod.default(pi.api as never);
	return pi.getTool();
}

function createCtx(overrides: Partial<{ hasUI: boolean; cwd: string }> = {}) {
	return {
		hasUI: false,
		cwd: "/tmp/project",
		...overrides,
	};
}

describe("interactive-shell tool contract", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockSessionManager.list.mockReturnValue([]);
		mockSessionManager.take.mockReturnValue(undefined);
		mockCoordinator.isOverlayOpen.mockReturnValue(false);
		mockCoordinator.beginOverlay.mockReturnValue(true);
		mockCoordinator.getMonitor.mockReturnValue(undefined);
		mockGenerateSessionId.mockReturnValue("mock-session");
	});

	it("registers the interactive_shell tool", async () => {
		const tool = await loadTool();
		expect(tool?.name).toBe("interactive_shell");
	});

	it("returns structured details for attach/background conflicts", async () => {
		const tool = await loadTool();
		const result = await tool.execute(
			"call-1",
			{ attach: "abc123", background: true },
			undefined,
			undefined,
			createCtx({ hasUI: true }),
		);

		expect(result.isError).toBe(true);
		expect(result.details).toEqual({
			error: "attach_and_background_conflict",
			attach: "abc123",
			background: true,
		});
	});

	it("returns structured details when attach is requested without UI", async () => {
		const tool = await loadTool();
		const result = await tool.execute("call-1", { attach: "abc123" }, undefined, undefined, createCtx());

		expect(result.isError).toBe(true);
		expect(result.details).toEqual({
			error: "interactive_mode_required",
			attach: "abc123",
		});
	});

	it("returns empty background list details", async () => {
		const tool = await loadTool();
		const result = await tool.execute("call-1", { listBackground: true }, undefined, undefined, createCtx());

		expect(result.isError).toBeUndefined();
		expect(result.details).toEqual({ sessions: [], count: 0 });
	});

	it("returns structured details when dismiss target is missing", async () => {
		const tool = await loadTool();
		const result = await tool.execute(
			"call-1",
			{ dismissBackground: "missing-session" },
			undefined,
			undefined,
			createCtx(),
		);

		expect(result.isError).toBe(true);
		expect(result.details).toEqual({
			error: "background_session_not_found",
			sessionId: "missing-session",
		});
	});

	it("returns structured details when required parameters are missing", async () => {
		const tool = await loadTool();
		const result = await tool.execute("call-1", {}, undefined, undefined, createCtx());

		expect(result.isError).toBe(true);
		expect(result.details).toEqual({ error: "missing_required_parameter" });
	});

	it("returns structured details when background mode is invalid for a new session", async () => {
		const tool = await loadTool();
		const result = await tool.execute(
			"call-1",
			{ command: "printf hi", background: true, mode: "hands-free" },
			undefined,
			undefined,
			createCtx({ hasUI: true }),
		);

		expect(result.isError).toBe(true);
		expect(result.details).toEqual({
			error: "background_requires_dispatch",
			mode: "hands-free",
			background: true,
		});
	});

	it("starts a headless dispatch session without UI", async () => {
		const tool = await loadTool();
		const result = await tool.execute(
			"call-1",
			{ command: "printf hi", mode: "dispatch", background: true },
			undefined,
			undefined,
			createCtx(),
		);

		expect(result.isError).toBeUndefined();
		expect(result.details).toMatchObject({
			sessionId: "mock-session",
			backgroundId: "mock-session",
			mode: "dispatch",
			background: true,
		});
		expect(mockSessionManager.add).toHaveBeenCalled();
		expect(mockSessionManager.registerActive).toHaveBeenCalled();
	});
});
