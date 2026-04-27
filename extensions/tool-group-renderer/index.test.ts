import { visibleWidth } from "@mariozechner/pi-tui";
import { describe, expect, it } from "vitest";
import { __test__ } from "./index.ts";

const patchStateKey = Symbol.for("creatrip.tool-group-renderer.patch-state");

class DummyToolExecutionComponent {
	args: unknown;
	isStarted = false;
	isArgsComplete = false;
	result: unknown;
	isPartial = false;

	constructor(_toolName: string, _toolCallId: string, args: unknown) {
		this.args = args;
	}

	updateArgs(args: unknown): void {
		this.args = args;
	}

	markExecutionStarted(): void {
		this.isStarted = true;
	}

	setArgsComplete(): void {
		this.isArgsComplete = true;
	}

	updateResult(result: unknown, isPartial = false): void {
		this.result = result;
		this.isPartial = isPartial;
	}

	setExpanded(): void {}
}

function createMockMode() {
	const children: unknown[] = [];
	return {
		chatContainer: {
			children,
			addChild: (child: unknown) => children.push(child),
			removeChild: (child: unknown) => {
				const index = children.indexOf(child);
				if (index !== -1) children.splice(index, 1);
			},
			clear: () => {
				children.length = 0;
			},
		},
		pendingTools: new Map<string, unknown>(),
		settingsManager: {
			getShowImages: () => false,
			getImageWidthCells: () => 80,
		},
		getRegisteredToolDefinition: () => ({}),
		ui: { requestRender: () => {} },
		sessionManager: { getCwd: () => "/tmp" },
		toolOutputExpanded: false,
	};
}

describe("tool-group-renderer bash preview", () => {
	it("renders multiline bash commands as a single inline preview", () => {
		const preview = __test__.formatBashCommandPreview("cd /tmp\npnpm test");

		expect(preview).toBe("$ cd /tmp pnpm test");
		expect(preview).not.toContain("\n");
	});

	it("normalizes CRLF commands without breaking the preview line", () => {
		const preview = __test__.formatBashCommandPreview("echo one\r\necho two");

		expect(preview).toBe("$ echo one echo two");
		expect(preview).not.toContain("\r");
		expect(preview).not.toContain("\n");
	});

	it("truncates bash command previews to a requested visual width", () => {
		const preview = __test__.formatBashCommandPreview("find /usr/local/lib/node_modules -type f -name '*.js'", 24);

		expect(visibleWidth(preview)).toBeLessThanOrEqual(24);
		expect(preview).toContain("...");
		expect(preview).not.toContain("\n");
	});

	it("keeps grouped bash lines to one visual row at the render width", () => {
		const line = __test__.formatBashLine(
			{
				title: "askUserQuestion 관련 파일 검색",
				command: "find /usr/local/lib/node_modules/@mariozechner/pi-coding-agent -type f -name '*.js'",
			},
			{
				toolName: "bash",
				toolCallId: "call-1",
				args: {},
				executionStarted: true,
				argsComplete: true,
				isPartial: false,
				isError: false,
			},
			70,
		);

		expect(visibleWidth(line)).toBeLessThanOrEqual(70);
		expect(line).toContain("...");
		expect(line).toContain("$ find");
		expect(line).not.toContain("\n");
	});

	it("uses the same accent color as read and edit for completed bash titles", () => {
		__test__.setRuntimeThemeForTest({
			fg: (color, text) => `<${color}>${text}</${color}>`,
			bg: (_color, text) => text,
			bold: (text) => text,
		});
		try {
			const line = __test__.formatBashLine(
				{
					title: "interactive-mode addMessageToChat 위치 검색",
					command: "rg -n addMessageToChat interactive-mode.js",
				},
				{
					toolName: "bash",
					toolCallId: "call-1",
					args: {},
					executionStarted: true,
					argsComplete: true,
					isPartial: false,
					isError: false,
					result: { content: [{ type: "text", text: "ok" }] },
				},
			);

			expect(line).toContain("<accent>interactive-mode addMessageToChat 위치 검색</accent>");
		} finally {
			__test__.setRuntimeThemeForTest(undefined);
		}
	});

	it("hides grouped bash command previews when the row is too narrow", () => {
		const line = __test__.formatBashLine(
			{
				title: "askUserQuestion 관련 파일 검색",
				command: "find /usr/local/lib/node_modules/@mariozechner/pi-coding-agent -type f -name '*.js'",
			},
			{
				toolName: "bash",
				toolCallId: "call-1",
				args: {},
				executionStarted: true,
				argsComplete: true,
				isPartial: false,
				isError: false,
			},
			32,
		);

		expect(visibleWidth(line)).toBeLessThanOrEqual(32);
		expect(line).not.toContain("$ find");
		expect(line).not.toContain("(");
		expect(line).toContain("askUserQuestion");
	});
});

describe("tool-group-renderer lazy grouping", () => {
	it("does not break a streaming group when visible assistant text has tool calls", () => {
		const message = {
			role: "assistant",
			content: [
				{ type: "text", text: "커밋하겠습니다." },
				{ type: "toolCall", id: "call-1", name: "bash", arguments: { command: "git status" } },
			],
		};

		expect(__test__.shouldBreakGroupForMessageUpdate(message as never)).toBe(false);
	});

	it("still breaks a streaming group for visible assistant text without tool calls", () => {
		const message = {
			role: "assistant",
			content: [{ type: "text", text: "중간 설명입니다." }],
		};

		expect(__test__.shouldBreakGroupForMessageUpdate(message as never)).toBe(true);
	});

	it("groups streamed bash tool calls even when the assistant message has visible text", () => {
		(globalThis as typeof globalThis & { [patchStateKey]?: unknown })[patchStateKey] = {
			toolExecutionComponent: DummyToolExecutionComponent,
		};
		const mode = createMockMode();

		__test__.updateStreamingAssistantToolCalls(
			mode as never,
			{
				role: "assistant",
				content: [
					{ type: "text", text: "커밋하겠습니다." },
					{ type: "toolCall", id: "call-1", name: "bash", arguments: { title: "first", command: "git status" } },
				],
			} as never,
		);
		__test__.updateStreamingAssistantToolCalls(
			mode as never,
			{
				role: "assistant",
				content: [
					{ type: "text", text: "커밋하겠습니다." },
					{ type: "toolCall", id: "call-1", name: "bash", arguments: { title: "first", command: "git status" } },
					{ type: "toolCall", id: "call-2", name: "bash", arguments: { title: "second", command: "git diff" } },
				],
			} as never,
		);

		expect(mode.chatContainer.children).toHaveLength(1);
		expect(mode.chatContainer.children[0]).not.toBeInstanceOf(DummyToolExecutionComponent);
	});

	it("renders a single groupable tool call with the normal renderer first", () => {
		(globalThis as typeof globalThis & { [patchStateKey]?: unknown })[patchStateKey] = {
			toolExecutionComponent: DummyToolExecutionComponent,
		};
		const mode = createMockMode();

		__test__.ensureToolHandle(mode as never, "bash", "call-1", {
			title: "first",
			command: "echo first",
		});

		expect(mode.chatContainer.children).toHaveLength(1);
		expect(mode.chatContainer.children[0]).toBeInstanceOf(DummyToolExecutionComponent);
	});

	it("promotes consecutive same-tool calls to the grouped renderer when the group is confirmed", () => {
		(globalThis as typeof globalThis & { [patchStateKey]?: unknown })[patchStateKey] = {
			toolExecutionComponent: DummyToolExecutionComponent,
		};
		const mode = createMockMode();

		const firstHandle = __test__.ensureToolHandle(mode as never, "bash", "call-1", {
			title: "first",
			command: "echo first",
		});
		firstHandle.markExecutionStarted();

		__test__.ensureToolHandle(mode as never, "bash", "call-2", {
			title: "second",
			command: "echo second",
		});

		expect(mode.chatContainer.children).toHaveLength(1);
		expect(mode.chatContainer.children[0]).not.toBeInstanceOf(DummyToolExecutionComponent);
	});

	it("promotes consecutive mixed groupable tool calls to one grouped renderer", () => {
		(globalThis as typeof globalThis & { [patchStateKey]?: unknown })[patchStateKey] = {
			toolExecutionComponent: DummyToolExecutionComponent,
		};
		const mode = createMockMode();

		__test__.ensureToolHandle(mode as never, "bash", "call-1", {
			title: "first",
			command: "echo first",
		});
		__test__.ensureToolHandle(mode as never, "read", "call-2", {
			path: "README.md",
		});
		__test__.ensureToolHandle(mode as never, "edit", "call-3", {
			path: "README.md",
		});

		expect(mode.chatContainer.children).toHaveLength(1);
		expect(mode.chatContainer.children[0]).not.toBeInstanceOf(DummyToolExecutionComponent);
	});

	it("keeps image read tool calls on the normal renderer", () => {
		(globalThis as typeof globalThis & { [patchStateKey]?: unknown })[patchStateKey] = {
			toolExecutionComponent: DummyToolExecutionComponent,
		};
		const mode = createMockMode();

		__test__.ensureToolHandle(mode as never, "bash", "call-1", {
			title: "first",
			command: "echo first",
		});
		__test__.ensureToolHandle(mode as never, "read", "call-2", {
			path: "/tmp/screenshot.PNG",
		});

		expect(mode.chatContainer.children).toHaveLength(2);
		expect(mode.chatContainer.children[0]).toBeInstanceOf(DummyToolExecutionComponent);
		expect(mode.chatContainer.children[1]).toBeInstanceOf(DummyToolExecutionComponent);
	});

	it("does not promote a read candidate after its path updates to an image extension", () => {
		(globalThis as typeof globalThis & { [patchStateKey]?: unknown })[patchStateKey] = {
			toolExecutionComponent: DummyToolExecutionComponent,
		};
		const mode = createMockMode();

		const firstHandle = __test__.ensureToolHandle(mode as never, "read", "call-1", {
			path: "README.md",
		});
		firstHandle.updateArgs({ path: "/tmp/photo.webp" });
		__test__.ensureToolHandle(mode as never, "bash", "call-2", {
			title: "second",
			command: "echo second",
		});

		expect(mode.chatContainer.children).toHaveLength(2);
		expect(mode.chatContainer.children[0]).toBeInstanceOf(DummyToolExecutionComponent);
		expect(mode.chatContainer.children[1]).toBeInstanceOf(DummyToolExecutionComponent);
	});

	it("keeps separated same-tool singleton calls on the normal renderer", () => {
		(globalThis as typeof globalThis & { [patchStateKey]?: unknown })[patchStateKey] = {
			toolExecutionComponent: DummyToolExecutionComponent,
		};
		const mode = createMockMode();

		const firstHandle = __test__.ensureToolHandle(mode as never, "bash", "call-1", {
			title: "first",
			command: "echo first",
		});
		firstHandle.markExecutionStarted();
		firstHandle.updateResult({ content: [{ type: "text", text: "ok" }] });
		mode.pendingTools.delete("call-1");

		const visibleInterveningComponent = { render: () => ["Thinking..."] };
		mode.chatContainer.children.push(visibleInterveningComponent);

		__test__.ensureToolHandle(mode as never, "bash", "call-2", {
			title: "second",
			command: "echo second",
		});

		expect(mode.chatContainer.children[0]).toBeInstanceOf(DummyToolExecutionComponent);
		expect(mode.chatContainer.children[1]).toBe(visibleInterveningComponent);
		expect(mode.chatContainer.children[2]).toBeInstanceOf(DummyToolExecutionComponent);
	});
});
