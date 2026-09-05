import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";

const runtime = vi.hoisted(() => ({
	InteractiveMode: class {
		handleEvent() {}
		renderSessionContext() {}
		addMessageToChat() {}
	},
	ToolExecutionComponent: class {},
}));

vi.mock("@earendil-works/pi-coding-agent", () => runtime);

import toolGroupRenderer, { __test__ } from "./index.ts";

const patchStateKey = Symbol.for("pi.tool-group-renderer.patch-state");
const originalPrototype = { ...Object.getOwnPropertyDescriptors(runtime.InteractiveMode.prototype) };

afterEach(() => {
	Reflect.deleteProperty(globalThis, patchStateKey);
	Object.defineProperties(runtime.InteractiveMode.prototype, originalPrototype);
	__test__.setRuntimeThemeForTest(undefined);
});

describe("tool-group-renderer runtime loading", () => {
	it("patches the host-provided classes without importing an installed Pi dist tree", async () => {
		const on = vi.fn();
		await toolGroupRenderer({ on } as unknown as ExtensionAPI);

		expect(runtime.InteractiveMode.prototype.handleEvent).not.toBe(originalPrototype.handleEvent.value);
		expect(Reflect.get(globalThis, patchStateKey).toolExecutionComponent).toBe(runtime.ToolExecutionComponent);
		expect(on).toHaveBeenCalledWith("session_start", expect.any(Function));
	});

	it("reads the current UI theme after a theme switch", async () => {
		const on = vi.fn();
		await toolGroupRenderer({ on } as unknown as ExtensionAPI);
		const firstTheme = { fg: vi.fn((_color, text) => text), bg: vi.fn(), bold: vi.fn() };
		const nextTheme = { fg: vi.fn((_color, text) => text), bg: vi.fn(), bold: vi.fn() };
		const ui = { theme: firstTheme };
		const handler = on.mock.calls.find(([event]) => event === "session_start")?.[1];
		handler({}, { ui } as unknown as ExtensionContext);
		ui.theme = nextTheme;

		__test__.formatBashLine(
			{ command: "pwd" },
			{
				toolCallId: "bash-1",
				toolName: "bash",
				args: {},
				executionStarted: false,
				argsComplete: false,
				isPartial: false,
				isError: false,
			},
		);
		expect(nextTheme.fg).toHaveBeenCalled();
		expect(firstTheme.fg).not.toHaveBeenCalled();
	});
});
