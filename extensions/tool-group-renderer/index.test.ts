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
});

describe("tool-group-renderer lazy grouping", () => {
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
