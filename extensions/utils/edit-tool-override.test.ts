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
		expect(tool.description).toContain("append`/`prepend");
		expect(tool.promptSnippet).toContain("Prefer append/prepend for insertion-only changes");
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

		it("accepts preferred range + content edits and rejects mixed structured/legacy payloads", () => {
			expect(() =>
				assertEditRequest({
					path: "sample.txt",
					edits: [{ op: "replace", range: { start: "1#MQ" }, content: "beta" }],
				}),
			).not.toThrow();

			expect(() =>
				assertEditRequest({
					path: "sample.txt",
					edits: [{ op: "replace", range: { start: "1#MQ" }, pos: "1#MQ", content: "beta" }],
				}),
			).toThrow('must use either "range" or legacy "pos"/"end", not both');

			expect(() =>
				assertEditRequest({
					path: "sample.txt",
					edits: [{ op: "append", content: "beta", lines: ["beta"] }],
				}),
			).toThrow('must use either "content" or legacy "lines", not both');
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

	it("applies preferred range + content edits and returns updated anchors", async () => {
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
							range: { start: `2#${computeLineHash(2, "beta")}` },
							content: "BETA",
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

	it("renders compact call previews before execution and collapses them once execution starts", async () => {
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
			const theme = {
				fg: (_token: string, text: string) => text,
				bg: (_token: string, text: string) => text,
				bold: (text: string) => text,
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

			const previewComponent = editTool.renderCall(args, theme, context);
			const previewRendered = previewComponent.render(120).join("\n");
			expect(previewRendered).toContain("+1 / -1 (preview)");
			expect(previewRendered).toContain("beta");
			expect(previewRendered).toContain("BETA");
			expect(previewRendered).not.toContain("2#");

			context.executionStarted = true;
			const settledComponent = editTool.renderCall(args, theme, context);
			const settledRendered = settledComponent.render(120).join("\n");
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
				edits: [{ op: "replace", pos: `2#${computeLineHash(2, "BETA")}`, lines: ["BETA"] }],
			};
			const theme = {
				fg: (_token: string, text: string) => text,
				bg: (_token: string, text: string) => text,
				bold: (text: string) => text,
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
			expect(previewRendered).toContain("stale anchor");

			context.executionStarted = true;
			const settledRendered = editTool.renderCall(args, theme, context).render(120).join("\n");
			expect(settledRendered).toContain("edit sample.txt");
			expect(settledRendered).not.toContain("stale anchor");
		});
	});

	it("surfaces delimiter-only boundary duplication warnings in call previews", async () => {
		await withTempFile("sample.txt", "function demo() {\n  run();\n}\n", async ({ cwd }) => {
			const { pi, getTool } = makeFakePiRegistry();
			registerEditTool(pi);
			const editTool = getTool("edit");
			const invalidate = vi.fn();
			const args = {
				path: "sample.txt",
				edits: [
					{
						op: "replace",
						range: { start: `2#${computeLineHash(2, "  run();")}` },
						content: "  run();\n}",
					},
				],
			};
			const theme = {
				fg: (_token: string, text: string) => text,
				bg: (_token: string, text: string) => text,
				bold: (text: string) => text,
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
			expect(previewRendered).toContain("Warnings:");
			expect(previewRendered).toContain("Potential boundary duplication");
			expect(previewRendered).toContain("Prefer append/prepend");

			context.executionStarted = true;
			const settledRendered = editTool.renderCall(args, theme, context).render(120).join("\n");
			expect(settledRendered).toContain("Warnings:");
			expect(settledRendered).toContain("Potential boundary duplication");
			expect(settledRendered).toContain("Prefer append/prepend");
		});
	});

	it("surfaces leading boundary duplication warnings in call previews", async () => {
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
						range: { start: `2#${computeLineHash(2, "beta")}` },
						content: "alpha\nbeta",
					},
				],
			};
			const theme = {
				fg: (_token: string, text: string) => text,
				bg: (_token: string, text: string) => text,
				bold: (text: string) => text,
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
			expect(previewRendered).toContain("Warnings:");
			expect(previewRendered).toContain("replacement starts with a line");

			context.executionStarted = true;
			const settledRendered = editTool.renderCall(args, theme, context).render(120).join("\n");
			expect(settledRendered).toContain("Warnings:");
			expect(settledRendered).toContain("replacement starts with a line");
		});
	});

	it("does not warn for nested block rewrites when delimiter indentation differs", async () => {
		await withTempFile(
			"sample.txt",
			"function outer() {\n  if (ready) {\n    work();\n  }\n}\n",
			async ({ cwd, path }) => {
				const { pi, getTool } = makeFakePiRegistry();
				registerEditTool(pi);
				const editTool = getTool("edit");
				const invalidate = vi.fn();
				const args = {
					path: "sample.txt",
					edits: [
						{
							op: "replace",
							range: {
								start: `2#${computeLineHash(2, "  if (ready) {")}`,
								end: `4#${computeLineHash(4, "  }")}`,
							},
							content: "  if (ready) {\n    doWork();\n  }",
						},
					],
				};
				const theme = {
					fg: (_token: string, text: string) => text,
					bg: (_token: string, text: string) => text,
					bold: (text: string) => text,
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
				expect(previewRendered).not.toContain("Warnings:");

				const result = await editTool.execute("e1", args, undefined, undefined, {
					cwd,
					hasUI: true,
					ui: { notify() {} },
				});
				expect(await readFile(path, "utf8")).toBe("function outer() {\n  if (ready) {\n    doWork();\n  }\n}\n");
				expect(result.content[0]?.text ?? "").not.toContain("Warnings:");
			},
		);
	});

	it("recomputes previews when cwd changes for identical relative edit args", async () => {
		await mkdir(join(process.cwd(), ".tmp"), { recursive: true });
		const cwdA = await mkdtemp(join(process.cwd(), ".tmp/hashline-preview-a-"));
		const cwdB = await mkdtemp(join(process.cwd(), ".tmp/hashline-preview-b-"));
		try {
			await writeFile(join(cwdA, "sample.txt"), "alpha\nbeta\ngamma\n", "utf8");
			await writeFile(join(cwdB, "sample.txt"), "zero\nbeta\ndelta\n", "utf8");

			const { pi, getTool } = makeFakePiRegistry();
			registerEditTool(pi);
			const editTool = getTool("edit");
			const invalidate = vi.fn();
			const args = {
				path: "sample.txt",
				edits: [{ op: "replace", pos: `2#${computeLineHash(2, "beta")}`, lines: ["BETA"] }],
			};
			const theme = {
				fg: (_token: string, text: string) => text,
				bg: (_token: string, text: string) => text,
				bold: (text: string) => text,
			};
			const context = {
				argsComplete: true,
				state: {},
				cwd: cwdA,
				expanded: true,
				executionStarted: false,
				invalidate,
			};

			editTool.renderCall(args, theme, context);
			await vi.waitFor(() => expect(invalidate).toHaveBeenCalledTimes(1));
			const previewA = editTool.renderCall(args, theme, context).render(120).join("\n");
			expect(previewA).toContain("alpha");
			expect(previewA).toContain("gamma");
			expect(previewA).not.toContain("zero");

			invalidate.mockClear();
			context.cwd = cwdB;
			editTool.renderCall(args, theme, context);
			await vi.waitFor(() => expect(invalidate).toHaveBeenCalledTimes(1));
			const previewB = editTool.renderCall(args, theme, context).render(120).join("\n");
			expect(previewB).toContain("zero");
			expect(previewB).toContain("delta");
			expect(previewB).not.toContain("alpha");
		} finally {
			await rm(cwdA, { recursive: true, force: true });
			await rm(cwdB, { recursive: true, force: true });
		}
	});

	it("shows ellipsis between distant preview hunks when expanded", async () => {
		await withTempFile(
			"sample.txt",
			`${Array.from({ length: 60 }, (_, index) => `line${index + 1}`).join("\n")}\n`,
			async ({ cwd }) => {
				const { pi, getTool } = makeFakePiRegistry();
				registerEditTool(pi);
				const editTool = getTool("edit");
				const invalidate = vi.fn();
				const args = {
					path: "sample.txt",
					edits: [
						{ op: "replace", pos: `2#${computeLineHash(2, "line2")}`, lines: ["LINE2"] },
						{ op: "replace", pos: `58#${computeLineHash(58, "line58")}`, lines: ["LINE58"] },
					],
				};
				const theme = {
					fg: (_token: string, text: string) => text,
					bg: (_token: string, text: string) => text,
					bold: (text: string) => text,
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

				const component = editTool.renderCall(args, theme, context);
				const rendered = component.render(120).join("\n");
				expect(rendered).toContain("...");
				expect(rendered).toContain("LINE2");
				expect(rendered).toContain("LINE58");
				expect(rendered).not.toContain("58#");
			},
		);
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

	it("rejects edit content that starts with a hashline prefix", async () => {
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
								range: { start: `1#${computeLineHash(1, "alpha")}` },
								content: "7#XH:alpha",
							},
						],
					},
					undefined,
					undefined,
					{ cwd, hasUI: true, ui: { notify() {} } },
				),
			).rejects.toThrow(
				'Edit 0 field "content" must contain literal file content. Remove any leading LINE#HASH prefix or diff marker',
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
					{ op: "prepend", content: "start" },
					{ op: "append", content: "end" },
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
				edits: [{ op: "replace", range: { start: `2#${computeLineHash(2, "beta")}` }, content: "gamma" }],
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

it("warns when replace content duplicates a delimiter-only boundary line", async () => {
	await withTempFile("sample.txt", "function demo() {\n  run();\n}\n", async ({ cwd, path }) => {
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
						range: { start: `2#${computeLineHash(2, "  run();")}` },
						content: "  run();\n}",
					},
				],
			},
			undefined,
			undefined,
			{ cwd, hasUI: true, ui: { notify() {} } },
		);

		expect(await readFile(path, "utf8")).toBe("function demo() {\n  run();\n}\n}\n");
		const text = result.content[0]?.text ?? "";
		expect(text).toContain("Warnings:");
		expect(text).toContain("Potential boundary duplication");
		expect(text).toContain("Prefer append/prepend");
	});
});

it("warns when replace content duplicates a leading boundary line", async () => {
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
						range: { start: `2#${computeLineHash(2, "beta")}` },
						content: "alpha\nbeta",
					},
				],
			},
			undefined,
			undefined,
			{ cwd, hasUI: true, ui: { notify() {} } },
		);

		expect(await readFile(path, "utf8")).toBe("alpha\nalpha\nbeta\ngamma\n");
		const text = result.content[0]?.text ?? "";
		expect(text).toContain("Warnings:");
		expect(text).toContain("matches the previous surviving line");
		expect(text).toContain("Prefer append/prepend");
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
				edits: [{ op: "replace", range: { start: `1#${computeLineHash(1, "alpha")}` }, content: "alpha" }],
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

it("renders partial, markdown, error, and warning-bearing diff edit results", async () => {
	const { pi, getTool } = makeFakePiRegistry();
	registerEditTool(pi);
	const editTool = getTool("edit");
	const theme = {
		fg: (_token: string, text: string) => text,
		bg: (_token: string, text: string) => text,
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

	await withTempFile("sample.txt", "function demo() {\n  run();\n}\n", async ({ cwd }) => {
		const result = await editTool.execute(
			"e1",
			{
				path: "sample.txt",
				edits: [
					{
						op: "replace",
						range: { start: `2#${computeLineHash(2, "  run();")}` },
						content: "  run();\n}",
					},
				],
			},
			undefined,
			undefined,
			{ cwd, hasUI: true, ui: { notify() {} } },
		);

		const renderedSuccess = editTool
			.renderResult(result, { expanded: true, isPartial: false }, theme, {
				lastComponent: undefined,
				isError: false,
			})
			.render(120)
			.join("\n");
		expect(renderedSuccess).toContain("Warnings:");
		expect(renderedSuccess).toContain("Potential boundary duplication");
		expect(renderedSuccess).toContain("Updated anchors");
		expect(renderedSuccess).not.toContain("Updated sample.txt");
		expect(renderedSuccess).not.toContain("Changes: +");
	});
});
