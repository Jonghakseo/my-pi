import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import editToolOverride from "../edit-tool-override.ts";
import { registerEditTool } from "./edit-tool-ui.ts";

async function withTempFile(
	name: string,
	content: string,
	run: (args: { cwd: string; path: string }) => Promise<void>,
) {
	await mkdir(join(process.cwd(), ".tmp"), { recursive: true });
	const cwd = await mkdtemp(join(process.cwd(), ".tmp/edit-ui-test-"));
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
	bg: (_token: string, text: string) => text,
	bold: (text: string) => text,
};

afterEach(() => {
	vi.restoreAllMocks();
});

describe("edit tool UI override", () => {
	it("registers the built-in edit tool with custom UI rendering", () => {
		const { pi, getTool } = makeFakePiRegistry();
		editToolOverride(pi);

		const tool = getTool("edit");
		expect(tool.description).toContain("exact text replacement");
		expect(tool.promptSnippet).toContain("exact text replacement");
		expect(tool.renderShell).toBe("self");
	});

	it("renders side-by-side previews before execution and collapses them once execution starts", async () => {
		await withTempFile("sample.txt", "alpha\nbeta\ngamma\n", async ({ cwd }) => {
			const { pi, getTool } = makeFakePiRegistry();
			registerEditTool(pi);
			const editTool = getTool("edit");
			const invalidate = vi.fn();
			const args = {
				path: "sample.txt",
				edits: [{ oldText: "beta", newText: "BETA" }],
			};
			const context = {
				argsComplete: true,
				state: {},
				cwd,
				expanded: true,
				executionStarted: false,
				invalidate,
			};

			editTool.renderCall(args, theme, context);
			await vi.waitFor(() => expect(invalidate).toHaveBeenCalled());

			const previewRendered = editTool.renderCall(args, theme, context).render(120).join("\n");
			expect(previewRendered).toContain("+1 / -1 (preview)");
			expect(previewRendered).toContain("beta");
			expect(previewRendered).toContain("BETA");
			expect(previewRendered).toContain("│");

			context.executionStarted = true;
			const settledRendered = editTool.renderCall(args, theme, context).render(120).join("\n");
			expect(settledRendered).toContain("edit sample.txt");
			expect(settledRendered).not.toContain("beta");
			expect(settledRendered).not.toContain("BETA");
		});
	});

	it("hides preview errors once execution has started", async () => {
		await withTempFile("sample.txt", "alpha\nbeta\n", async ({ cwd }) => {
			const { pi, getTool } = makeFakePiRegistry();
			registerEditTool(pi);
			const editTool = getTool("edit");
			const invalidate = vi.fn();
			const args = {
				path: "sample.txt",
				edits: [{ oldText: "missing", newText: "BETA" }],
			};
			const context = {
				argsComplete: true,
				state: {},
				cwd,
				expanded: true,
				executionStarted: false,
				invalidate,
			};

			editTool.renderCall(args, theme, context);
			await vi.waitFor(() => expect(invalidate).toHaveBeenCalled());

			const previewRendered = editTool.renderCall(args, theme, context).render(120).join("\n");
			expect(previewRendered).toContain("Could not find the exact text");

			context.executionStarted = true;
			const settledRendered = editTool.renderCall(args, theme, context).render(120).join("\n");
			expect(settledRendered).toContain("edit sample.txt");
			expect(settledRendered).not.toContain("Could not find the exact text");
		});
	});

	it("delegates execution to the built-in edit behavior", async () => {
		await withTempFile("sample.txt", "alpha\nbeta\ngamma\n", async ({ cwd, path }) => {
			const { pi, getTool } = makeFakePiRegistry();
			registerEditTool(pi);
			const editTool = getTool("edit");

			const result = await editTool.execute(
				"e1",
				{
					path: "sample.txt",
					edits: [{ oldText: "beta", newText: "BETA" }],
				},
				undefined,
				undefined,
				{ cwd },
			);

			expect(await readFile(path, "utf8")).toBe("alpha\nBETA\ngamma\n");
			expect(result.content[0]?.text).toBe("Successfully replaced 1 block(s) in sample.txt.");
			expect(result.details?.diff).toContain("-2 beta");
			expect(result.details?.diff).toContain("+2 BETA");
		});
	});

	it("supports legacy top-level oldText/newText input through the built-in prepareArguments path", async () => {
		await withTempFile("sample.txt", "hello world\n", async ({ cwd, path }) => {
			const { pi, getTool } = makeFakePiRegistry();
			registerEditTool(pi);
			const editTool = getTool("edit");

			await editTool.execute("e1", { path: "sample.txt", oldText: "hello", newText: "bye" }, undefined, undefined, {
				cwd,
			});

			expect(await readFile(path, "utf8")).toBe("bye world\n");
		});
	});

	it("renders partial, success, and error results with the custom UI", async () => {
		const { pi, getTool } = makeFakePiRegistry();
		registerEditTool(pi);
		const editTool = getTool("edit");

		const partial = editTool.renderResult(
			{ content: [{ type: "text", text: "ignored" }], details: { diff: "" } },
			{ expanded: true, isPartial: true },
			theme,
			{},
		);
		expect(partial.render(80).join("\n")).toContain("Editing...");

		const success = editTool.renderResult(
			{
				content: [{ type: "text", text: "Successfully replaced 1 block(s) in sample.txt." }],
				details: { diff: " 1 alpha\n-2 beta\n+2 BETA\n 3 gamma", firstChangedLine: 2 },
			},
			{ expanded: true, isPartial: false },
			theme,
			{ lastComponent: undefined, isError: false },
		);
		const renderedSuccess = success.render(120).join("\n");
		expect(renderedSuccess).toContain("+1 / -1");
		expect(renderedSuccess).toContain("beta");
		expect(renderedSuccess).toContain("BETA");
		expect(renderedSuccess).not.toContain("Successfully replaced");

		const error = editTool.renderResult(
			{ content: [{ type: "text", text: "Edit failed." }], details: {} },
			{ expanded: true, isPartial: false },
			theme,
			{ lastComponent: undefined, isError: true },
		);
		expect(error.render(80).join("\n")).toContain("Edit failed.");
	});
});
