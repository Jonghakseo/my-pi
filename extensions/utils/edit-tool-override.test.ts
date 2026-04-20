import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import editToolOverride from "../edit-tool-override.ts";
import readToolOverride from "../read-tool-override.ts";
import { computeLineHash } from "./hashline.ts";
import { registerEditTool } from "./hashline-edit.ts";
import { registerReadTool } from "./hashline-read.ts";

async function withTempFile(
	name: string,
	content: string,
	run: (args: { cwd: string; path: string }) => Promise<void>,
) {
	await mkdir(join(process.cwd(), ".tmp"), { recursive: true });
	const cwd = await mkdtemp(join(process.cwd(), ".tmp/hashline-test-"));
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
	const on = vi.fn();
	return {
		pi: {
			registerTool(tool: any) {
				tools.set(tool.name, tool);
			},
			on,
		} as any,
		on,
		getTool(name: string) {
			const tool = tools.get(name);
			if (!tool) throw new Error(`Tool not registered: ${name}`);
			return tool;
		},
	};
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("hashline tool overrides", () => {
	it("registers the edit tool and compatibility lifecycle hooks", () => {
		const { pi, on, getTool } = makeFakePiRegistry();
		editToolOverride(pi);

		const tool = getTool("edit");
		expect(tool.description).toContain("LINE#HASH");
		expect(tool.description).toContain("replace_text");
		expect(on).toHaveBeenCalledWith("turn_start", expect.any(Function));
		expect(on).toHaveBeenCalledWith("tool_result", expect.any(Function));
		expect(on).toHaveBeenCalledWith("turn_end", expect.any(Function));
	});

	it("registers the read tool override", () => {
		const { pi, getTool } = makeFakePiRegistry();
		readToolOverride(pi);

		const tool = getTool("read");
		expect(tool.description).toContain("LINE#HASH");
		expect(tool.promptSnippet).toContain("hash anchors");
	});
});

describe("hashline edit/read behavior", () => {
	it("returns hashline read output without snapshotId", async () => {
		await withTempFile("sample.txt", "alpha\nbeta\n", async ({ cwd }) => {
			const { pi, getTool } = makeFakePiRegistry();
			registerReadTool(pi);
			const readTool = getTool("read");

			const result = await readTool.execute("r1", { path: "sample.txt" }, undefined, undefined, { cwd });

			const text = result.content[0]?.text ?? "";
			expect(text).toContain(`1#${computeLineHash(1, "alpha")}:alpha`);
			expect(text).toContain(`2#${computeLineHash(2, "beta")}:beta`);
			expect(text).not.toContain("[snapshotId:");
			expect(result.details?.snapshotId).toBeUndefined();
		});
	});

	it("hides hash prefixes in read tool UI rendering", async () => {
		await withTempFile("sample.txt", "alpha\nbeta\n", async ({ cwd }) => {
			const { pi, getTool } = makeFakePiRegistry();
			registerReadTool(pi);
			const readTool = getTool("read");

			const result = await readTool.execute("r1", { path: "sample.txt" }, undefined, undefined, { cwd });
			const component = readTool.renderResult(
				result,
				{ expanded: true, isPartial: false },
				{ fg: (_token: string, text: string) => text, bold: (text: string) => text },
				{ args: { path: "sample.txt" }, showImages: false },
			);
			const rendered = component.render(120).join("\n");

			expect(rendered).toContain("1: alpha");
			expect(rendered).toContain("2: beta");
			expect(rendered).not.toContain("1#");
			expect(rendered).not.toContain("2#");
		});
	});

	it("applies anchored edits and returns updated anchors", async () => {
		await withTempFile("sample.txt", "alpha\nbeta\ngamma\n", async ({ cwd, path }) => {
			const { pi, getTool } = makeFakePiRegistry();
			registerEditTool(pi);
			const editTool = getTool("edit");

			const result = await editTool.execute(
				"e1",
				{
					path: "sample.txt",
					edits: [
						{
							op: "replace",
							pos: `2#${computeLineHash(2, "beta")}`,
							lines: ["BETA"],
						},
					],
				},
				undefined,
				undefined,
				{ cwd, hasUI: true, ui: { notify() {} } },
			);

			expect(await readFile(path, "utf8")).toBe("alpha\nBETA\ngamma\n");
			expect(result.content[0]?.text).toContain("Updated sample.txt");
			expect(result.content[0]?.text).toContain("Updated anchors");
			expect(result.details?.snapshotId).toBeUndefined();
		});
	});

	it("keeps edit call previews compact so the diff is not shown twice", async () => {
		await withTempFile("sample.txt", "alpha\nbeta\ngamma\n", async ({ cwd }) => {
			const { pi, getTool } = makeFakePiRegistry();
			registerEditTool(pi);
			const editTool = getTool("edit");
			const invalidate = vi.fn();
			const args = {
				path: "sample.txt",
				edits: [
					{
						op: "replace",
						pos: `2#${computeLineHash(2, "beta")}`,
						lines: ["BETA"],
					},
				],
			};
			const theme = { fg: (_token: string, text: string) => text, bold: (text: string) => text };
			const context = {
				argsComplete: true,
				state: {},
				cwd,
				expanded: true,
				invalidate,
			};

			editTool.renderCall(args, theme, context);
			await vi.waitFor(() => expect(invalidate).toHaveBeenCalled());

			const component = editTool.renderCall(args, theme, context);
			const rendered = component.render(120).join("\n");
			expect(rendered).toContain("Pending changes: +1 / -1 (preview)");
			expect(rendered).not.toContain("beta");
			expect(rendered).not.toContain("BETA");
		});
	});

	it("keeps legacy oldText/newText as compatibility fallback", async () => {
		await withTempFile("sample.txt", "hello world\n", async ({ cwd, path }) => {
			const { pi, getTool } = makeFakePiRegistry();
			registerEditTool(pi);
			const editTool = getTool("edit");

			const result = await editTool.execute(
				"e1",
				{ path: "sample.txt", oldText: "hello", newText: "bye" },
				undefined,
				undefined,
				{ cwd, hasUI: true, ui: { notify() {} } },
			);

			expect(await readFile(path, "utf8")).toBe("bye world\n");
			expect(result.details?.compatibility?.used).toBe(true);
		});
	});

	it("rejects removed returnMode=full requests", async () => {
		await withTempFile("sample.txt", "alpha\n", async ({ cwd }) => {
			const { pi, getTool } = makeFakePiRegistry();
			registerEditTool(pi);
			const editTool = getTool("edit");

			await expect(
				editTool.execute(
					"e1",
					{
						path: "sample.txt",
						returnMode: "full",
						edits: [{ op: "replace", pos: `1#${computeLineHash(1, "alpha")}`, lines: ["ALPHA"] }],
					},
					undefined,
					undefined,
					{ cwd, hasUI: true, ui: { notify() {} } },
				),
			).rejects.toThrow('Edit request field "returnMode" must be "changed" or "ranges" when provided.');
		});
	});

	it("rejects removed snapshotId field on edit requests", async () => {
		await withTempFile("sample.txt", "alpha\n", async ({ cwd }) => {
			const { pi, getTool } = makeFakePiRegistry();
			registerEditTool(pi);
			const editTool = getTool("edit");

			await expect(
				editTool.execute(
					"e1",
					{
						path: "sample.txt",
						snapshotId: "legacy-snapshot",
						edits: [{ op: "replace", pos: `1#${computeLineHash(1, "alpha")}`, lines: ["ALPHA"] }],
					},
					undefined,
					undefined,
					{ cwd, hasUI: true, ui: { notify() {} } },
				),
			).rejects.toThrow("unknown or unsupported fields: snapshotId");
		});
	});
});
