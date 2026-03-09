import { describe, expect, it } from "vitest";
import overrideBuiltinTools from "../override-builtin-tools.ts";

interface WidthAwareComponent {
	render(width: number): string[];
}

type RenderResult = WidthAwareComponent | { text?: string };

type RegisteredTool = {
	name: string;
	renderCall?: (args: Record<string, unknown>, theme: TestTheme) => RenderResult;
	renderResult?: (
		result: { content: Array<{ type: string; text?: string }>; details?: unknown },
		options: { expanded: boolean },
		theme: TestTheme,
	) => RenderResult;
};

type TestTheme = {
	fg: (_color: string, text: string) => string;
	bold: (text: string) => string;
};

function createTheme(): TestTheme {
	return {
		fg: (_color, text) => text,
		bold: (text) => text,
	};
}

/** Extract text from a render result (supports both Text and TruncatedText). */
function getText(result: RenderResult): string {
	if (typeof (result as WidthAwareComponent).render === "function") {
		return (result as WidthAwareComponent).render(500).join("\n");
	}
	return (result as { text?: string }).text ?? "";
}

function getWriteTool(): RegisteredTool {
	const tools = new Map<string, RegisteredTool>();
	overrideBuiltinTools({
		on: () => {},
		registerTool: (tool: RegisteredTool) => {
			tools.set(tool.name, tool);
		},
	} as never);

	const writeTool = tools.get("write");
	if (!writeTool) throw new Error("write tool not registered");
	return writeTool;
}

describe("override-builtin-tools write renderer", () => {
	it("does not repeat the write preview in collapsed result output", () => {
		const writeTool = getWriteTool();
		const theme = createTheme();
		const content = ["alpha", "beta", "gamma"].join("\n");

		const callResult = writeTool.renderCall?.({ path: "docs/test.md", content }, theme);
		const callText = callResult ? getText(callResult) : "";
		const resultObj = writeTool.renderResult?.(
			{
				content: [],
				details: {
					path: "docs/test.md",
					lineCount: 3,
					byteCount: Buffer.byteLength(content, "utf8"),
					preview: content,
				},
			},
			{ expanded: false },
			theme,
		);
		const resultText = resultObj ? getText(resultObj) : "";

		expect(callText).toContain("Write docs/test.md");
		expect(callText).toContain("3 lines");
		expect(callText).toContain("alpha");
		expect(resultText).toBe("");
	});

	it("shows full content in expanded result without repeating the write header", () => {
		const writeTool = getWriteTool();
		const theme = createTheme();
		const content = ["first", "second", "third"].join("\n");

		const resultObj = writeTool.renderResult?.(
			{
				content: [{ type: "text", text: "Successfully wrote file." }],
				details: {
					path: "docs/test.md",
					lineCount: 3,
					byteCount: Buffer.byteLength(content, "utf8"),
					preview: content,
				},
			},
			{ expanded: true },
			theme,
		);
		const resultText = resultObj ? getText(resultObj) : "";

		expect(resultText).toContain("first");
		expect(resultText).toContain("second");
		expect(resultText).toContain("third");
		expect(resultText).toContain("Successfully wrote file.");
		expect(resultText).not.toContain("Write docs/test.md");
		expect(resultText).not.toContain("3 lines •");
	});
});
