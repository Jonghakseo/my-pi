import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import readToolOverride from "../read-tool-override.ts";
import { registerReadTool } from "./read-tool-ui.ts";

async function withTempFile(
	name: string,
	content: string,
	run: (args: { cwd: string; path: string }) => Promise<void>,
) {
	await mkdir(join(process.cwd(), ".tmp"), { recursive: true });
	const cwd = await mkdtemp(join(process.cwd(), ".tmp/read-ui-test-"));
	const path = join(cwd, name);
	try {
		await writeFile(path, content, "utf8");
		await run({ cwd, path });
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
}

function makeFakePiRegistry() {
	const tools = new Map<string, any>();
	return {
		pi: {
			registerTool(tool: any) {
				tools.set(tool.name, tool);
			},
		} as any,
		getTool(name: string) {
			const tool = tools.get(name);
			if (!tool) throw new Error(`Tool not registered: ${name}`);
			return tool;
		},
	};
}

const theme = {
	fg: (_token: string, text: string) => text,
	bold: (text: string) => text,
};

describe("read tool UI override", () => {
	it("registers the built-in read tool with custom UI rendering", () => {
		const { pi, getTool } = makeFakePiRegistry();
		readToolOverride(pi);

		const tool = getTool("read");
		expect(tool.description).toContain("Read the contents of a file");
		expect(tool.promptSnippet).toContain("Read file contents");
	});

	it("hides successful file contents while collapsed", () => {
		const { pi, getTool } = makeFakePiRegistry();
		registerReadTool(pi);
		const readTool = getTool("read");

		const collapsed = readTool.renderResult(
			{ content: [{ type: "text", text: "alpha\nbeta\ngamma" }], details: {} },
			{ expanded: false, isPartial: false },
			theme,
			{ lastComponent: undefined, isError: false },
		);

		expect(collapsed.render(80).join("\n")).toBe("");
	});

	it("shows only the compact preview when expanded", () => {
		const { pi, getTool } = makeFakePiRegistry();
		registerReadTool(pi);
		const readTool = getTool("read");
		const content = Array.from({ length: 12 }, (_, index) => `line ${index + 1}`).join("\n");

		const expanded = readTool.renderResult(
			{ content: [{ type: "text", text: content }], details: {} },
			{ expanded: true, isPartial: false },
			theme,
			{ args: { path: "example.txt" }, lastComponent: undefined, isError: false },
		);
		const rendered = expanded.render(120).join("\n");

		expect(rendered).toContain("line 1");
		expect(rendered).toContain("line 10");
		expect(rendered).not.toContain("line 11");
		expect(rendered).toContain("... (2 more lines, expand keeps preview compact)");
		expect(rendered).toContain("example.txt:1-12");
	});

	it("keeps read errors visible", () => {
		const { pi, getTool } = makeFakePiRegistry();
		registerReadTool(pi);
		const readTool = getTool("read");

		const error = readTool.renderResult(
			{ content: [{ type: "text", text: "File not found." }], details: {} },
			{ expanded: false, isPartial: false },
			theme,
			{ lastComponent: undefined, isError: true },
		);

		expect(error.render(80).join("\n")).toContain("File not found.");
	});

	it("delegates execution to the built-in read behavior", async () => {
		await withTempFile("sample.txt", "alpha\nbeta\ngamma\n", async ({ cwd }) => {
			const { pi, getTool } = makeFakePiRegistry();
			registerReadTool(pi);
			const readTool = getTool("read");

			const result = await readTool.execute("r1", { path: "sample.txt" }, undefined, undefined, { cwd });
			expect(result.content[0]?.type).toBe("text");
			expect(result.content[0]?.text).toContain("alpha");
			expect(result.content[0]?.text).toContain("gamma");
		});
	});

	it("shows partial status while the read is running", () => {
		const { pi, getTool } = makeFakePiRegistry();
		registerReadTool(pi);
		const readTool = getTool("read");

		const partial = readTool.renderResult(
			{ content: [{ type: "text", text: "ignored" }], details: {} },
			{ expanded: true, isPartial: true },
			theme,
			{},
		);

		expect(partial.render(80).join("\n")).toContain("Reading...");
	});
});
