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
	it("returns hashline read output with snapshotId", async () => {
		await withTempFile("sample.txt", "alpha\nbeta\n", async ({ cwd }) => {
			const { pi, getTool } = makeFakePiRegistry();
			registerReadTool(pi);
			const readTool = getTool("read");

			const result = await readTool.execute("r1", { path: "sample.txt" }, undefined, undefined, { cwd });

			const text = result.content[0]?.text ?? "";
			expect(text).toContain(`1#${computeLineHash(1, "alpha")}:alpha`);
			expect(text).toContain(`2#${computeLineHash(2, "beta")}:beta`);
			expect(text).toContain("[snapshotId:");
			expect(result.details?.snapshotId).toEqual(expect.any(String));
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
			expect(result.details?.snapshotId).toEqual(expect.any(String));
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
});
