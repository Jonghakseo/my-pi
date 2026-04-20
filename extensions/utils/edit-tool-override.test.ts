import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import editToolOverride from "../edit-tool-override.ts";
import readToolOverride from "../read-tool-override.ts";
import { registerCompatibilityNotifications } from "./hashline-compatibility-notify.ts";
import { assertEditRequest, prepareEditArguments, registerEditTool } from "./hashline-edit.ts";
import { computeLineHash } from "./hashline.ts";
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

	describe("hashline edit compatibility helpers", () => {
		it("stores legacy top-level replace fields as hidden prepared arguments", () => {
			const prepared = prepareEditArguments({
				path: "sample.txt",
				oldText: "alpha",
				newText: "beta",
			}) as Record<string, unknown>;

			expect(Object.keys(prepared)).toEqual(["path"]);
			expect(prepared.oldText).toBe("alpha");
			expect(prepared.newText).toBe("beta");
			expect(() => assertEditRequest(prepared)).not.toThrow();
		});

		it("rejects mixed legacy key styles and stray returnRanges", () => {
			expect(() =>
				assertEditRequest({
					path: "sample.txt",
					oldText: "alpha",
					new_text: "beta",
				}),
			).toThrow("cannot mix legacy camelCase and snake_case fields");

			expect(() =>
				assertEditRequest({
					path: "sample.txt",
					returnRanges: [{ start: 1, end: 1 }],
					edits: [],
				}),
			).toThrow('Edit request field "returnRanges" is only supported when returnMode is "ranges".');
		});

		it("aggregates compatibility notifications once per turn", async () => {
			const { pi, on } = makeFakePiRegistry();
			registerCompatibilityNotifications(pi);

			const handlers = Object.fromEntries(on.mock.calls.map(([eventName, handler]) => [eventName, handler])) as Record<
				string,
				(event: unknown, ctx: any) => Promise<void>
			>;
			const notify = vi.fn();
			const ctx = {
				hasUI: true,
				ui: { notify },
				sessionManager: { getSessionFile: () => "/tmp/hashline-test-session.json" },
			} as any;

			await handlers.turn_start({}, ctx);
			await handlers.tool_result({ toolName: "edit", isError: false, details: { compatibility: { used: true } } }, ctx);
			await handlers.tool_result({ toolName: "edit", isError: false, details: { compatibility: { used: true } } }, ctx);
			await handlers.turn_end({}, ctx);

			expect(notify).toHaveBeenCalledWith("Edit compatibility mode used for 2 edit(s)", "warning");
		});
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

	it("returns separate updated anchor blocks for distant edits", async () => {
		await withTempFile(
			"sample.txt",
			`${[
				"line1",
				"line2",
				"line3",
				"line4",
				"line5",
				"line6",
				"line7",
				"line8",
				"line9",
				"line10",
				"line11",
				"line12",
			].join("\n")}\n`,
			async ({ cwd }) => {
				const { pi, getTool } = makeFakePiRegistry();
				registerEditTool(pi);
				const editTool = getTool("edit");

				const result = await editTool.execute(
					"e1",
					{
						path: "sample.txt",
						edits: [
							{ op: "replace", pos: `2#${computeLineHash(2, "line2")}`, lines: ["LINE2"] },
							{ op: "replace", pos: `11#${computeLineHash(11, "line11")}`, lines: ["LINE11"] },
						],
					},
					undefined,
					undefined,
					{ cwd, hasUI: true, ui: { notify() {} } },
				);

				const text = result.content[0]?.text ?? "";
				expect((text.match(/--- Updated anchors/g) ?? []).length).toBe(2);
				expect(text).toContain("region 1/2, lines 1-4");
				expect(text).toContain("region 2/2, lines 9-12");
				expect(text).not.toContain("lines 1-12");
			},
		);
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

	it("rejects edit lines that start with a hashline prefix", async () => {
		await withTempFile("sample.txt", "alpha\nbeta\n", async ({ cwd }) => {
			const { pi, getTool } = makeFakePiRegistry();
			registerEditTool(pi);
			const editTool = getTool("edit");

			await expect(
				editTool.execute(
					"e1",
					{
						path: "sample.txt",
						edits: [
							{
								op: "replace",
								pos: `1#${computeLineHash(1, "alpha")}`,
								lines: ["7#XH:alpha"],
							},
						],
					},
					undefined,
					undefined,
					{ cwd, hasUI: true, ui: { notify() {} } },
				),
			).rejects.toThrow(
				'Edit 0 field "lines" must contain literal file content. Remove any leading LINE#HASH prefix or diff marker',
			);
		});
	});
});

it("supports append and prepend edits without anchors", async () => {
	await withTempFile("sample.txt", "middle\n", async ({ cwd, path }) => {
		const { pi, getTool } = makeFakePiRegistry();
		registerEditTool(pi);
		const editTool = getTool("edit");

		await editTool.execute(
			"e1",
			{
				path: "sample.txt",
				edits: [
					{ op: "prepend", lines: ["start"] },
					{ op: "append", lines: ["end"] },
				],
			},
			undefined,
			undefined,
			{ cwd, hasUI: true, ui: { notify() {} } },
		);

		expect(await readFile(path, "utf8")).toBe("start\nmiddle\nend\n");
	});
});

it("applies replace_text edits through the override", async () => {
	await withTempFile("sample.txt", "one fish\ntwo fish\n", async ({ cwd, path }) => {
		const { pi, getTool } = makeFakePiRegistry();
		registerEditTool(pi);
		const editTool = getTool("edit");

		const result = await editTool.execute(
			"e1",
			{
				path: "sample.txt",
				edits: [{ op: "replace_text", oldText: "two fish", newText: "TWO FISH" }],
			},
			undefined,
			undefined,
			{ cwd, hasUI: true, ui: { notify() {} } },
		);

		expect(await readFile(path, "utf8")).toBe("one fish\nTWO FISH\n");
		expect(result.details?.diff).toContain("+2#");
	});
});

it("returns range payloads, structure outlines, and warnings in ranges mode", async () => {
	await withTempFile("sample.txt", "alpha\nbeta\ngamma\n", async ({ cwd }) => {
		const { pi, getTool } = makeFakePiRegistry();
		registerEditTool(pi);
		const editTool = getTool("edit");

		const result = await editTool.execute(
			"e1",
			{
				path: "sample.txt",
				returnMode: "ranges",
				returnRanges: [
					{ start: 1, end: 3 },
					{ start: 10, end: 11 },
				],
				edits: [{ op: "replace", pos: `2#${computeLineHash(2, "beta")}`, lines: ["gamma"] }],
			},
			undefined,
			undefined,
			{ cwd, hasUI: true, ui: { notify() {} } },
		);

		const text = result.content[0]?.text ?? "";
		expect(text).toContain("Updated sample.txt");
		expect(text).toContain("Warnings:");
		expect(text).toContain("Structure outline:");
		expect(result.details?.returnedRanges).toHaveLength(2);
		expect(result.details?.returnedRanges?.[0]?.text).toContain(`2#${computeLineHash(2, "gamma")}:gamma`);
		expect(result.details?.returnedRanges?.[1]).toMatchObject({ start: 10, end: 11, empty: true });
		expect(result.details?.structureOutline).toContain(
			"Range 2 (lines 10-11): No structural markers found in returned content.",
		);
	});
});

it("returns noop range payload metadata when ranged edits make no changes", async () => {
	await withTempFile("sample.txt", "alpha\n", async ({ cwd }) => {
		const { pi, getTool } = makeFakePiRegistry();
		registerEditTool(pi);
		const editTool = getTool("edit");

		const result = await editTool.execute(
			"e1",
			{
				path: "sample.txt",
				returnMode: "ranges",
				returnRanges: [{ start: 1, end: 1 }],
				edits: [{ op: "replace", pos: `1#${computeLineHash(1, "alpha")}`, lines: ["alpha"] }],
			},
			undefined,
			undefined,
			{ cwd, hasUI: true, ui: { notify() {} } },
		);

		expect(result.content[0]?.text).toContain("Classification: noop");
		expect(result.details?.classification).toBe("noop");
		expect(result.details?.returnedRanges?.[0]?.text).toContain(`1#${computeLineHash(1, "alpha")}:alpha`);
		expect(result.details?.structureOutline?.[0]).toContain("Range 1 (lines 1-1): 1: alpha");
	});
});

it("renders partial, markdown, and error edit results", () => {
	const { pi, getTool } = makeFakePiRegistry();
	registerEditTool(pi);
	const editTool = getTool("edit");
	const theme = {
		fg: (_token: string, text: string) => text,
		bold: (text: string) => text,
		italic: (text: string) => text,
		underline: (text: string) => text,
		strikethrough: (text: string) => text,
	};

	const partial = editTool.renderResult(
		{ content: [{ type: "text", text: "ignored" }], details: { diff: "" } },
		{ expanded: true, isPartial: true },
		theme,
		{},
	);
	expect(partial.render(80).join("\n")).toContain("Editing...");

	const markdown = editTool.renderResult(
		{
			content: [{ type: "text", text: "No changes made to sample.txt\nClassification: noop" }],
			details: { diff: "", classification: "noop" },
		},
		{ expanded: true, isPartial: false },
		theme,
		{ lastComponent: undefined, isError: false },
	);
	expect(markdown.render(80).join("\n")).toContain("Classification: noop");

	const error = editTool.renderResult(
		{ content: [{ type: "text", text: `1#${computeLineHash(1, "alpha")}:alpha` }], details: { diff: "" } },
		{ expanded: true, isPartial: false },
		theme,
		{ lastComponent: undefined, isError: true },
	);
	const renderedError = error.render(80).join("\n");
	expect(renderedError).toContain("1: alpha");
	expect(renderedError).not.toContain("1#");
});
