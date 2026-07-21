import { homedir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
	extractPathsFromInput,
	formatDisplayPath,
	getFolderName,
	isCommentLikeReference,
	sanitizeReference,
	shortenPath,
	stripLineSuffix,
	toAbsolute,
} from "./path-utils.js";

// ─── sanitizeReference ───────────────────────────────────────────────────────

describe("sanitizeReference", () => {
	it("strips leading quotes and brackets", () => {
		expect(sanitizeReference('"foo.ts"')).toBe("foo.ts");
		expect(sanitizeReference("'foo.ts'")).toBe("foo.ts");
		expect(sanitizeReference("`foo.ts`")).toBe("foo.ts");
		expect(sanitizeReference("(foo.ts)")).toBe("foo.ts");
		expect(sanitizeReference("[foo.ts]")).toBe("foo.ts");
		expect(sanitizeReference("<foo.ts>")).toBe("foo.ts");
	});

	it("strips trailing punctuation", () => {
		expect(sanitizeReference("foo.ts,")).toBe("foo.ts");
		expect(sanitizeReference("foo.ts;")).toBe("foo.ts");
		expect(sanitizeReference("foo.ts.")).toBe("foo.ts");
	});

	it("trims whitespace", () => {
		expect(sanitizeReference("  foo.ts  ")).toBe("foo.ts");
	});

	it("handles nested quotes", () => {
		expect(sanitizeReference("'\"foo.ts\"'")).toBe("foo.ts");
	});

	it("handles empty string", () => {
		expect(sanitizeReference("")).toBe("");
	});
});

// ─── isCommentLikeReference ──────────────────────────────────────────────────

describe("isCommentLikeReference", () => {
	it("returns true for // prefixed strings", () => {
		expect(isCommentLikeReference("// comment")).toBe(true);
		expect(isCommentLikeReference("//TODO")).toBe(true);
	});

	it("returns false for non-comment strings", () => {
		expect(isCommentLikeReference("/path/to/file")).toBe(false);
		expect(isCommentLikeReference("file.ts")).toBe(false);
	});
});

// ─── stripLineSuffix ─────────────────────────────────────────────────────────

describe("stripLineSuffix", () => {
	it("strips #L suffix", () => {
		expect(stripLineSuffix("file.ts#L42")).toBe("file.ts");
		expect(stripLineSuffix("file.ts#L42C10")).toBe("file.ts");
	});

	it("strips trailing :line number", () => {
		expect(stripLineSuffix("file.ts:42")).toBe("file.ts");
		expect(stripLineSuffix("file.ts:42:10")).toBe("file.ts");
	});

	it("preserves path with port-like patterns", () => {
		// Windows-like drive letter should be preserved
		expect(stripLineSuffix("/path/to/file.ts")).toBe("/path/to/file.ts");
	});

	it("handles no suffix", () => {
		expect(stripLineSuffix("file.ts")).toBe("file.ts");
	});

	it("handles paths with colons in directory names", () => {
		// The colon in the last segment is checked for digit suffix
		expect(stripLineSuffix("/a/b/file.ts:99")).toBe("/a/b/file.ts");
	});
});

// ─── formatDisplayPath ───────────────────────────────────────────────────────

describe("formatDisplayPath", () => {
	it("returns relative path for descendants", () => {
		expect(formatDisplayPath("/home/user/project/src/file.ts", "/home/user/project")).toBe("src/file.ts");
	});

	it("returns absolute path for non-descendants", () => {
		expect(formatDisplayPath("/other/file.ts", "/home/user/project")).toBe("/other/file.ts");
	});

	it("returns absolute path when path is the cwd itself", () => {
		// path.resolve(cwd) + path.sep won't match the path itself
		const cwd = "/home/user/project";
		expect(formatDisplayPath(cwd, cwd)).toBe(cwd);
	});
});

// ─── shortenPath ─────────────────────────────────────────────────────────────

describe("shortenPath", () => {
	it("returns . for same directory", () => {
		expect(shortenPath("/home/user/project", "/home/user/project")).toBe(".");
	});

	it("returns ./relative for descendants", () => {
		expect(shortenPath("/home/user/project/src/file.ts", "/home/user/project")).toBe("./src/file.ts");
	});

	it("returns absolute path for non-descendants", () => {
		const result = shortenPath("/other/dir", "/home/user/project");
		expect(result).toBe(path.resolve("/other/dir"));
	});

	it("handles trailing slashes", () => {
		// path.resolve normalizes these
		expect(shortenPath("/home/user/project/", "/home/user/project")).toBe(".");
	});
});

// ─── getFolderName ───────────────────────────────────────────────────────────

describe("getFolderName", () => {
	it("extracts last folder from Unix path", () => {
		expect(getFolderName("/home/user/project")).toBe("project");
	});

	it("extracts last folder from Windows-like path", () => {
		expect(getFolderName("C:\\Users\\me\\project")).toBe("project");
	});

	it("handles root", () => {
		// "/" splits to empty parts, falls back to cwd itself
		expect(getFolderName("/")).toBe("/");
	});

	it("handles empty string", () => {
		expect(getFolderName("")).toBe("unknown");
	});

	it("handles single folder", () => {
		expect(getFolderName("mydir")).toBe("mydir");
	});
});

// ─── toAbsolute ──────────────────────────────────────────────────────────────

describe("toAbsolute", () => {
	it("resolves absolute path as-is", () => {
		expect(toAbsolute("/usr/local/bin", "/cwd")).toBe(path.resolve("/usr/local/bin"));
	});

	it("resolves ~ to homedir", () => {
		expect(toAbsolute("~", "/cwd")).toBe(homedir());
	});

	it("resolves ~/ paths", () => {
		expect(toAbsolute("~/docs/file.txt", "/cwd")).toBe(path.resolve(path.join(homedir(), "docs/file.txt")));
	});

	it("resolves relative paths against cwd", () => {
		expect(toAbsolute("src/file.ts", "/home/user/project")).toBe(path.resolve("/home/user/project", "src/file.ts"));
	});

	it("resolves . against cwd", () => {
		expect(toAbsolute(".", "/home/user/project")).toBe(path.resolve("/home/user/project"));
	});
});

// ─── extractPathsFromInput ────────────────────────────────────────────────────

describe("extractPathsFromInput", () => {
	it("returns single-element array for a non-empty string", () => {
		expect(extractPathsFromInput("src/file.ts")).toEqual(["src/file.ts"]);
	});

	it("returns empty array for an empty string", () => {
		expect(extractPathsFromInput("")).toEqual([]);
	});

	it("returns empty array for undefined/null", () => {
		expect(extractPathsFromInput(undefined)).toEqual([]);
		expect(extractPathsFromInput(null)).toEqual([]);
	});

	it("returns empty array for non-string/non-array values", () => {
		expect(extractPathsFromInput(42)).toEqual([]);
		expect(extractPathsFromInput(true)).toEqual([]);
		expect(extractPathsFromInput({})).toEqual([]);
	});

	it("handles array of strings (parallel read)", () => {
		expect(extractPathsFromInput(["backend/AGENTS.md", "backend/apps/trip/AGENTS.md"])).toEqual([
			"backend/AGENTS.md",
			"backend/apps/trip/AGENTS.md",
		]);
	});

	it("filters out non-string elements from array", () => {
		expect(extractPathsFromInput(["a.ts", 42, null, "b.ts", undefined, true])).toEqual(["a.ts", "b.ts"]);
	});

	it("filters out empty strings from array", () => {
		expect(extractPathsFromInput(["a.ts", "", "b.ts", ""])).toEqual(["a.ts", "b.ts"]);
	});

	it("returns empty array for empty array", () => {
		expect(extractPathsFromInput([])).toEqual([]);
	});

	it("handles single-element array", () => {
		expect(extractPathsFromInput(["only.ts"])).toEqual(["only.ts"]);
	});
});
