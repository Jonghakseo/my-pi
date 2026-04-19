import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DYNAMIC_SCOPE_SENTINEL_END, DYNAMIC_SCOPE_SENTINEL_START } from "../dynamic-agents-md.ts";

const mockState = vi.hoisted(() => {
	const access = vi.fn();
	const readFile = vi.fn();
	const writeFile = vi.fn();
	const queueChains = new Map<string, Promise<unknown>>();
	const withFileMutationQueue = vi.fn(async (filePath: string, task: () => Promise<unknown>) => {
		const previous = queueChains.get(filePath) ?? Promise.resolve();
		const next = previous.then(task, task);
		queueChains.set(
			filePath,
			next.catch(() => undefined),
		);
		return next;
	});

	return {
		access,
		readFile,
		writeFile,
		withFileMutationQueue,
		reset() {
			access.mockReset();
			readFile.mockReset();
			writeFile.mockReset();
			withFileMutationQueue.mockClear();
			queueChains.clear();
		},
	};
});

vi.mock("node:fs/promises", () => ({
	default: {
		access: mockState.access,
		readFile: mockState.readFile,
		writeFile: mockState.writeFile,
	},
	access: mockState.access,
	readFile: mockState.readFile,
	writeFile: mockState.writeFile,
}));

vi.mock("@mariozechner/pi-coding-agent", () => ({
	createEditTool: vi.fn(() => ({ description: "legacy single-edit description", execute: vi.fn() })),
	withFileMutationQueue: mockState.withFileMutationQueue,
}));

vi.mock("@mariozechner/pi-tui", () => ({
	Text: class Text {
		constructor(
			public readonly text: string,
			public readonly x: number,
			public readonly y: number,
		) {}
	},
}));

afterEach(() => {
	mockState.reset();
	vi.resetModules();
});

function deferredPromise<T = void>() {
	let resolve!: (value: T | PromiseLike<T>) => void;
	let reject!: (reason?: unknown) => void;
	const promise = new Promise<T>((resolvePromise, rejectPromise) => {
		resolve = resolvePromise;
		reject = rejectPromise;
	});
	return { promise, resolve, reject };
}

async function registerEditTool() {
	const handlers = new Map<string, (...args: any[]) => unknown>();
	let registeredTool: Record<string, unknown> | undefined;
	const pi = {
		on: vi.fn((event: string, handler: (...args: any[]) => unknown) => {
			handlers.set(event, handler);
		}),
		registerTool: vi.fn((tool: Record<string, unknown>) => {
			registeredTool = tool;
		}),
	};

	const module = await import("../edit-tool-override.ts");
	module.default(pi as never);

	if (!registeredTool) {
		throw new Error("edit tool was not registered");
	}

	return {
		tool: registeredTool,
		handlers,
	};
}

function createToolContext(cwd: string) {
	return { cwd };
}

describe("edit-tool-override", () => {
	it("registers an explicit edits[] description with replaceAll guidance", async () => {
		const { tool } = await registerEditTool();
		const description = tool.description;

		expect(typeof description).toBe("string");
		expect(description).toContain("single file");
		expect(description).toContain("edits[]");
		expect(description).toContain("replaceAll");
		expect(description).toContain("unique");
	});

	it("serializes execute calls that target the same file path", async () => {
		const { tool } = await registerEditTool();
		const execute = tool.execute as (...args: any[]) => Promise<any>;
		const cwd = "/tmp/project";
		const firstWrite = deferredPromise<void>();
		const absolutePath = path.join(cwd, "sample.txt");

		mockState.access.mockResolvedValue(undefined);
		mockState.readFile
			.mockResolvedValueOnce(Buffer.from("foo\n", "utf8"))
			.mockResolvedValueOnce(Buffer.from("foo\n", "utf8"))
			.mockResolvedValueOnce(Buffer.from("bar\n", "utf8"))
			.mockResolvedValueOnce(Buffer.from("bar\n", "utf8"));
		mockState.writeFile.mockImplementationOnce(() => firstWrite.promise).mockResolvedValueOnce(undefined);

		const firstRun = execute(
			"tool-1",
			{ path: "sample.txt", edits: [{ oldText: "foo\n", newText: "bar\n" }] },
			undefined,
			undefined,
			createToolContext(cwd),
		);
		await Promise.resolve();
		await Promise.resolve();
		expect(mockState.access).toHaveBeenCalledTimes(1);
		expect(mockState.withFileMutationQueue).toHaveBeenNthCalledWith(1, absolutePath, expect.any(Function));

		const secondRun = execute(
			"tool-2",
			{ path: "sample.txt", edits: [{ oldText: "bar\n", newText: "baz\n" }] },
			undefined,
			undefined,
			createToolContext(cwd),
		);
		await Promise.resolve();
		await Promise.resolve();
		expect(mockState.access).toHaveBeenCalledTimes(1);

		firstWrite.resolve();
		const [firstResult, secondResult] = await Promise.all([firstRun, secondRun]);
		expect(firstResult.isError).toBe(false);
		expect(secondResult.isError).toBe(false);
		expect(mockState.access).toHaveBeenCalledTimes(2);
	});

	it("blocks writes when aborted before the write step", async () => {
		const { tool } = await registerEditTool();
		const execute = tool.execute as (...args: any[]) => Promise<any>;
		const controller = new AbortController();

		mockState.access.mockResolvedValue(undefined);
		mockState.readFile.mockResolvedValueOnce(Buffer.from("foo\n", "utf8")).mockImplementationOnce(async () => {
			controller.abort();
			return Buffer.from("foo\n", "utf8");
		});

		const result = await execute(
			"tool-1",
			{ path: "sample.txt", edits: [{ oldText: "foo\n", newText: "bar\n" }] },
			controller.signal,
			undefined,
			createToolContext("/tmp/project"),
		);

		expect(result.isError).toBe(true);
		expect(result.content[0]?.text).toContain("Operation aborted");
		expect(mockState.writeFile).not.toHaveBeenCalled();
	});

	it("does not flip to an abort error after the write already completed", async () => {
		const { tool } = await registerEditTool();
		const execute = tool.execute as (...args: any[]) => Promise<any>;
		const controller = new AbortController();

		mockState.access.mockResolvedValue(undefined);
		mockState.readFile.mockResolvedValue(Buffer.from("foo\n", "utf8"));
		mockState.writeFile.mockImplementationOnce(async () => {
			controller.abort();
		});

		const result = await execute(
			"tool-1",
			{ path: "sample.txt", edits: [{ oldText: "foo\n", newText: "bar\n" }] },
			controller.signal,
			undefined,
			createToolContext("/tmp/project"),
		);

		expect(result.isError).toBe(false);
		expect(result.content[0]?.text).toContain("Updated sample.txt with 1 edit.");
		expect(mockState.writeFile).toHaveBeenCalledTimes(1);
	});

	it("uses the read tool_result payload as the stale baseline without re-reading the file", async () => {
		const { tool, handlers } = await registerEditTool();
		const execute = tool.execute as (...args: any[]) => Promise<any>;
		const cwd = "/tmp/project";

		await handlers.get("tool_result")?.(
			{
				toolName: "read",
				isError: false,
				input: { path: "sample.txt" },
				details: undefined,
				content: [{ type: "text", text: "foo\nbar\n" }],
			},
			{ cwd },
		);
		expect(mockState.readFile).not.toHaveBeenCalled();

		mockState.access.mockResolvedValue(undefined);
		mockState.readFile.mockResolvedValue(Buffer.from("qux\nbar\n", "utf8"));

		const result = await execute(
			"tool-1",
			{ path: "sample.txt", edits: [{ oldText: "bar\n", newText: "baz\n" }] },
			undefined,
			undefined,
			createToolContext(cwd),
		);

		expect(result.isError).toBe(true);
		expect(result.content[0]?.text).toContain("File changed since its last read.");
		expect(mockState.writeFile).not.toHaveBeenCalled();
	});

	it("tracks offset: 1 read payloads as whole-file stale baselines", async () => {
		const { tool, handlers } = await registerEditTool();
		const execute = tool.execute as (...args: any[]) => Promise<any>;
		const cwd = "/tmp/project";

		await handlers.get("tool_result")?.(
			{
				toolName: "read",
				isError: false,
				input: { path: "sample.txt", offset: 1 },
				details: undefined,
				content: [{ type: "text", text: "foo\nbar\n" }],
			},
			{ cwd },
		);
		expect(mockState.readFile).not.toHaveBeenCalled();

		mockState.access.mockResolvedValue(undefined);
		mockState.readFile.mockResolvedValue(Buffer.from("qux\nbar\n", "utf8"));

		const result = await execute(
			"tool-1",
			{ path: "sample.txt", edits: [{ oldText: "bar\n", newText: "baz\n" }] },
			undefined,
			undefined,
			createToolContext(cwd),
		);

		expect(result.isError).toBe(true);
		expect(result.content[0]?.text).toContain("File changed since its last read.");
		expect(mockState.writeFile).not.toHaveBeenCalled();
	});

	it("tracks offset: 1 + generous limit read payloads when the payload covers the whole file", async () => {
		const { tool, handlers } = await registerEditTool();
		const execute = tool.execute as (...args: any[]) => Promise<any>;
		const cwd = "/tmp/project";

		await handlers.get("tool_result")?.(
			{
				toolName: "read",
				isError: false,
				input: { path: "sample.txt", offset: 1, limit: 100 },
				details: undefined,
				content: [{ type: "text", text: "foo\nbar\n" }],
			},
			{ cwd },
		);

		mockState.access.mockResolvedValue(undefined);
		mockState.readFile.mockResolvedValue(Buffer.from("qux\nbar\n", "utf8"));

		const result = await execute(
			"tool-1",
			{ path: "sample.txt", edits: [{ oldText: "bar\n", newText: "baz\n" }] },
			undefined,
			undefined,
			createToolContext(cwd),
		);

		expect(result.isError).toBe(true);
		expect(result.content[0]?.text).toContain("File changed since its last read.");
		expect(mockState.writeFile).not.toHaveBeenCalled();
	});

	it("preserves file content that ends with the legacy marker text without sentinels", async () => {
		const { tool, handlers } = await registerEditTool();
		const execute = tool.execute as (...args: any[]) => Promise<any>;
		const cwd = "/tmp/project";
		const fileContent =
			"foo\nbar\n\n---\n📋 [Dynamic scope context: /tmp/project/AGENTS.md]\n\nexample block in file body\n---";

		await handlers.get("tool_result")?.(
			{
				toolName: "read",
				isError: false,
				input: { path: "sample.txt" },
				details: undefined,
				content: [{ type: "text", text: fileContent }],
			},
			{ cwd },
		);

		mockState.access.mockResolvedValue(undefined);
		mockState.readFile
			.mockResolvedValueOnce(Buffer.from(fileContent, "utf8"))
			.mockResolvedValueOnce(Buffer.from(fileContent, "utf8"));
		mockState.writeFile.mockResolvedValue(undefined);

		const result = await execute(
			"tool-1",
			{ path: "sample.txt", edits: [{ oldText: "bar\n", newText: "baz\n" }] },
			undefined,
			undefined,
			createToolContext(cwd),
		);

		expect(result.isError).toBe(false);
		expect(result.content[0]?.text).toContain("Updated sample.txt with 1 edit.");
		expect(mockState.writeFile).toHaveBeenCalledTimes(1);
	});

	it("strips trailing sentinel-wrapped dynamic scope injections before hashing read baselines", async () => {
		const { tool, handlers } = await registerEditTool();
		const execute = tool.execute as (...args: any[]) => Promise<any>;
		const cwd = "/tmp/project";
		const injectedRead =
			"foo\nbar\n" +
			`\n\n${DYNAMIC_SCOPE_SENTINEL_START}\n📋 [Dynamic scope context: /tmp/project/AGENTS.md]\n\nscoped instructions\n${DYNAMIC_SCOPE_SENTINEL_END}` +
			`\n\n${DYNAMIC_SCOPE_SENTINEL_START}\n📋 [Dynamic scope context: /tmp/project/docs/AGENTS.md]\n\nmore scoped instructions\n${DYNAMIC_SCOPE_SENTINEL_END}`;

		await handlers.get("tool_result")?.(
			{
				toolName: "read",
				isError: false,
				input: { path: "sample.txt" },
				details: undefined,
				content: [{ type: "text", text: injectedRead }],
			},
			{ cwd },
		);

		mockState.access.mockResolvedValue(undefined);
		mockState.readFile
			.mockResolvedValueOnce(Buffer.from("foo\nbar\n", "utf8"))
			.mockResolvedValueOnce(Buffer.from("foo\nbar\n", "utf8"));
		mockState.writeFile.mockResolvedValue(undefined);

		const result = await execute(
			"tool-1",
			{ path: "sample.txt", edits: [{ oldText: "bar\n", newText: "baz\n" }] },
			undefined,
			undefined,
			createToolContext(cwd),
		);

		expect(result.isError).toBe(false);
		expect(result.content[0]?.text).toContain("Updated sample.txt with 1 edit.");
		expect(mockState.writeFile).toHaveBeenCalledTimes(1);
	});

	it("ignores limit-based read payloads that explicitly advertise continuation", async () => {
		const { tool, handlers } = await registerEditTool();
		const execute = tool.execute as (...args: any[]) => Promise<any>;
		const cwd = "/tmp/project";

		await handlers.get("tool_result")?.(
			{
				toolName: "read",
				isError: false,
				input: { path: "sample.txt", offset: 1, limit: 1 },
				details: undefined,
				content: [{ type: "text", text: "foo\n\n[1 more lines in file. Use offset=2 to continue.]" }],
			},
			{ cwd },
		);

		mockState.access.mockResolvedValue(undefined);
		mockState.readFile
			.mockResolvedValueOnce(Buffer.from("foo\nbar\n", "utf8"))
			.mockResolvedValueOnce(Buffer.from("foo\nbar\n", "utf8"));
		mockState.writeFile.mockResolvedValue(undefined);

		const result = await execute(
			"tool-1",
			{ path: "sample.txt", edits: [{ oldText: "bar\n", newText: "baz\n" }] },
			undefined,
			undefined,
			createToolContext(cwd),
		);

		expect(result.isError).toBe(false);
		expect(result.content[0]?.text).toContain("Updated sample.txt with 1 edit.");
		expect(mockState.writeFile).toHaveBeenCalledTimes(1);
	});

	it("uses write input content as the stale baseline without re-reading the file", async () => {
		const { tool, handlers } = await registerEditTool();
		const execute = tool.execute as (...args: any[]) => Promise<any>;
		const cwd = "/tmp/project";

		await handlers.get("tool_result")?.(
			{
				toolName: "write",
				isError: false,
				input: { path: "sample.txt", content: "foo\nbar\n" },
				details: undefined,
				content: [{ type: "text", text: "Wrote sample.txt" }],
			},
			{ cwd },
		);
		expect(mockState.readFile).not.toHaveBeenCalled();

		mockState.access.mockResolvedValue(undefined);
		mockState.readFile.mockResolvedValue(Buffer.from("qux\nbar\n", "utf8"));

		const result = await execute(
			"tool-1",
			{ path: "sample.txt", edits: [{ oldText: "bar\n", newText: "baz\n" }] },
			undefined,
			undefined,
			createToolContext(cwd),
		);

		expect(result.isError).toBe(true);
		expect(result.content[0]?.text).toContain("File changed since its last write.");
		expect(mockState.writeFile).not.toHaveBeenCalled();
	});
});
