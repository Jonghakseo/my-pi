import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { executeStructuredEdit } from "../override-builtin-tools.js";

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "pi-edit-tool-"));
	tempDirs.push(dir);
	return dir;
}

const HASH_ALPHABET = "ZPMQVRWSNKTXJBYH";
const RE_SIGNIFICANT = /[\p{L}\p{N}]/u;

function fnv1a32(text: string, seed = 0): number {
	let hash = (0x811c9dc5 ^ seed) >>> 0;
	for (let i = 0; i < text.length; i++) {
		hash ^= text.charCodeAt(i);
		hash = Math.imul(hash, 0x01000193) >>> 0;
	}
	return hash >>> 0;
}

function lineTag(lineNumber: number, line: string): string {
	const normalized = line.endsWith("\r") ? line.slice(0, -1) : line;
	const compact = normalized.replace(/\s+/g, "");
	const seed = RE_SIGNIFICANT.test(compact) ? 0 : lineNumber;
	const value = fnv1a32(compact, seed) & 0xff;
	const high = HASH_ALPHABET[(value >>> 4) & 0x0f] ?? "Z";
	const low = HASH_ALPHABET[value & 0x0f] ?? "Z";
	return `${lineNumber}#${high}${low}`;
}

afterEach(async () => {
	for (const dir of tempDirs.splice(0, tempDirs.length)) {
		await rm(dir, { recursive: true, force: true });
	}
});

describe("executeStructuredEdit", () => {
	it("applies replace by LINE#ID tag", async () => {
		const cwd = await makeTempDir();
		const path = "sample.txt";
		const abs = join(cwd, path);
		await writeFile(abs, "a\nb\nc\n", "utf8");

		const result = await executeStructuredEdit(cwd, {
			path,
			edits: [{ op: "replace", pos: lineTag(2, "b"), lines: ["B"] }],
		});

		expect(result.isError).toBeFalsy();
		expect(await readFile(abs, "utf8")).toBe("a\nB\nc\n");
	});

	it("applies prepend and append around full file", async () => {
		const cwd = await makeTempDir();
		const path = "sample.txt";
		const abs = join(cwd, path);
		await writeFile(abs, "middle\n", "utf8");

		const result = await executeStructuredEdit(cwd, {
			path,
			edits: [
				{ op: "prepend", lines: ["top"] },
				{ op: "append", lines: ["bottom"] },
			],
		});

		expect(result.isError).toBeFalsy();
		expect(await readFile(abs, "utf8")).toBe("top\nmiddle\nbottom\n");
	});

	it("moves file after applying edits", async () => {
		const cwd = await makeTempDir();
		const src = "a/source.txt";
		const dst = "b/target.txt";
		const srcAbs = join(cwd, src);
		const dstAbs = join(cwd, dst);
		await mkdir(join(cwd, "a"), { recursive: true });
		await writeFile(srcAbs, "one\n", "utf8");

		const result = await executeStructuredEdit(cwd, {
			path: src,
			edits: [{ op: "append", lines: ["two"] }],
			move: dst,
		});

		expect(result.isError).toBeFalsy();
		expect(await readFile(dstAbs, "utf8")).toBe("one\ntwo\n");
	});

	it("deletes file when delete is true", async () => {
		const cwd = await makeTempDir();
		const path = "remove.txt";
		const abs = join(cwd, path);
		await writeFile(abs, "bye\n", "utf8");

		const result = await executeStructuredEdit(cwd, { path, delete: true });

		expect(result.isError).toBeFalsy();
		await expect(readFile(abs, "utf8")).rejects.toThrow();
	});

	it("returns error for invalid replace tag", async () => {
		const cwd = await makeTempDir();
		const path = "sample.txt";
		const abs = join(cwd, path);
		await writeFile(abs, "x\n", "utf8");

		const result = await executeStructuredEdit(cwd, {
			path,
			edits: [{ op: "replace", pos: "bad-tag", lines: ["y"] }],
		});

		expect(result.isError).toBe(true);
		expect(result.content[0]?.type).toBe("text");
		if (result.content[0]?.type === "text") {
			expect(result.content[0].text).toContain("require pos (LINE#ID)");
		}
		expect(await readFile(abs, "utf8")).toBe("x\n");
	});

	it("rejects stale hash even when line number matches", async () => {
		const cwd = await makeTempDir();
		const path = "stale-hash.txt";
		const abs = join(cwd, path);
		await writeFile(abs, "alpha\nbeta\n", "utf8");

		const staleTag = lineTag(2, "different");
		const result = await executeStructuredEdit(cwd, {
			path,
			edits: [{ op: "replace", pos: staleTag, lines: ["BETA"] }],
		});

		expect(result.isError).toBe(true);
		if (result.content[0]?.type === "text") {
			expect(result.content[0].text).toContain("has changed since last read");
		}
		expect(await readFile(abs, "utf8")).toBe("alpha\nbeta\n");
	});

	it("applies range replace with end tag", async () => {
		const cwd = await makeTempDir();
		const path = "range.txt";
		const abs = join(cwd, path);
		await writeFile(abs, "a\nb\nc\nd\n", "utf8");

		const result = await executeStructuredEdit(cwd, {
			path,
			edits: [{ op: "replace", pos: lineTag(2, "b"), end: lineTag(3, "c"), lines: ["B", "C"] }],
		});

		expect(result.isError).toBeFalsy();
		expect(await readFile(abs, "utf8")).toBe("a\nB\nC\nd\n");
	});

	it("inserts relative to anchor tags with prepend and append", async () => {
		const cwd = await makeTempDir();
		const path = "anchor.txt";
		const abs = join(cwd, path);
		await writeFile(abs, "a\nc\n", "utf8");

		const result = await executeStructuredEdit(cwd, {
			path,
			edits: [
				{ op: "append", pos: lineTag(1, "a"), lines: ["b"] },
				{ op: "prepend", pos: lineTag(1, "a"), lines: ["start"] }
			],
		});

		expect(result.isError).toBeFalsy();
		expect(await readFile(abs, "utf8")).toBe("start\na\nb\nc\n");
	});

	it("returns error when replace end is before pos", async () => {
		const cwd = await makeTempDir();
		const path = "invalid-range.txt";
		const abs = join(cwd, path);
		await writeFile(abs, "a\nb\n", "utf8");

		const result = await executeStructuredEdit(cwd, {
			path,
			edits: [{ op: "replace", pos: lineTag(2, "b"), end: lineTag(1, "a"), lines: ["x"] }],
		});

		expect(result.isError).toBe(true);
		if (result.content[0]?.type === "text") {
			expect(result.content[0].text).toContain("end must be >= pos");
		}
		expect(await readFile(abs, "utf8")).toBe("a\nb\n");
	});

	it("returns error when delete is combined with edits", async () => {
		const cwd = await makeTempDir();
		const path = "delete-conflict.txt";
		const abs = join(cwd, path);
		await writeFile(abs, "a\n", "utf8");

		const result = await executeStructuredEdit(cwd, {
			path,
			delete: true,
			edits: [{ op: "replace", pos: lineTag(1, "a"), lines: ["x"] }],
		});

		expect(result.isError).toBe(true);
		if (result.content[0]?.type === "text") {
			expect(result.content[0].text).toContain("delete cannot be combined with edits");
		}
		expect(await readFile(abs, "utf8")).toBe("a\n");
	});

	it("preserves no-trailing-newline files after edit", async () => {
		const cwd = await makeTempDir();
		const path = "no-trailing-newline.txt";
		const abs = join(cwd, path);
		await writeFile(abs, "a\nb", "utf8");

		const result = await executeStructuredEdit(cwd, {
			path,
			edits: [{ op: "replace", pos: lineTag(2, "b"), lines: ["B"] }],
		});

		expect(result.isError).toBeFalsy();
		expect(await readFile(abs, "utf8")).toBe("a\nB");
	});
});
