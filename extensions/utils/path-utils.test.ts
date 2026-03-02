import { homedir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
	ALLOWED_EXTENSIONS,
	formatDisplayPath,
	getFolderName,
	inferExtension,
	isCommentLikeReference,
	MIME_TO_EXT,
	sanitizeFilename,
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

// ─── sanitizeFilename ────────────────────────────────────────────────────────

describe("sanitizeFilename", () => {
	it("replaces path separators", () => {
		expect(sanitizeFilename("path/to/file")).toBe("path_to_file");
		expect(sanitizeFilename("path\\to\\file")).toBe("path_to_file");
	});

	it("replaces shell-unsafe characters", () => {
		expect(sanitizeFilename('file"name')).toBe("file_name");
		expect(sanitizeFilename("file`name")).toBe("file_name");
		expect(sanitizeFilename("file$name")).toBe("file_name");
		expect(sanitizeFilename("file!name")).toBe("file_name");
	});

	it("replaces consecutive dots", () => {
		expect(sanitizeFilename("file..name")).toBe("file_name");
		expect(sanitizeFilename("file...name")).toBe("file_name");
	});

	it("replaces spaces", () => {
		expect(sanitizeFilename("my file")).toBe("my_file");
	});

	it("handles empty string", () => {
		expect(sanitizeFilename("")).toBe("");
	});

	it("handles Korean characters (no change)", () => {
		expect(sanitizeFilename("이미지")).toBe("이미지");
	});
});

// ─── inferExtension ──────────────────────────────────────────────────────────

describe("inferExtension", () => {
	it("infers from URL pathname", () => {
		expect(inferExtension("https://example.com/image.jpg")).toBe(".jpg");
		expect(inferExtension("https://example.com/photo.png")).toBe(".png");
		expect(inferExtension("https://example.com/icon.svg")).toBe(".svg");
	});

	it("falls back to content-type", () => {
		expect(inferExtension("https://example.com/unknown", "image/gif")).toBe(".gif");
		expect(inferExtension("https://example.com/unknown", "image/webp")).toBe(".webp");
	});

	it("defaults to .png", () => {
		expect(inferExtension("https://example.com/noext")).toBe(".png");
		expect(inferExtension("https://example.com/noext", "text/html")).toBe(".png");
	});

	it("handles query parameters in URL", () => {
		// The URL has .jpg but with query params
		expect(inferExtension("https://example.com/image.jpg?w=200")).toBe(".jpg");
	});

	it("handles invalid URLs gracefully", () => {
		expect(inferExtension("not-a-url")).toBe(".png");
	});

	it("handles URL with no extension and image/jpeg content-type", () => {
		expect(inferExtension("https://cdn.example.com/abc123", "image/jpeg")).toBe(".jpg");
	});
});

// ─── ALLOWED_EXTENSIONS constant ─────────────────────────────────────────────

describe("ALLOWED_EXTENSIONS", () => {
	it("contains common image extensions", () => {
		expect(ALLOWED_EXTENSIONS.has(".png")).toBe(true);
		expect(ALLOWED_EXTENSIONS.has(".jpg")).toBe(true);
		expect(ALLOWED_EXTENSIONS.has(".gif")).toBe(true);
		expect(ALLOWED_EXTENSIONS.has(".webp")).toBe(true);
		expect(ALLOWED_EXTENSIONS.has(".svg")).toBe(true);
	});

	it("does not contain non-image extensions", () => {
		expect(ALLOWED_EXTENSIONS.has(".txt")).toBe(false);
		expect(ALLOWED_EXTENSIONS.has(".pdf")).toBe(false);
	});
});

// ─── MIME_TO_EXT constant ────────────────────────────────────────────────────

describe("MIME_TO_EXT", () => {
	it("maps common MIME types", () => {
		expect(MIME_TO_EXT["image/png"]).toBe(".png");
		expect(MIME_TO_EXT["image/jpeg"]).toBe(".jpg");
		expect(MIME_TO_EXT["image/svg+xml"]).toBe(".svg");
	});
});
