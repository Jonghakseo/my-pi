import { describe, expect, it, vi } from "vitest";
import {
	type DiagnosticsMap,
	type LspDiagnostic,
	type PendingMap,
	formatDiagnostics,
	langId,
	parseJsonRpcMessages,
	routeMessage,
} from "./ts-check-utils.js";

// ── langId ──────────────────────────────────────────────────────────

describe("langId", () => {
	it("returns typescriptreact for .tsx", () => {
		expect(langId("src/App.tsx")).toBe("typescriptreact");
	});

	it("returns javascriptreact for .jsx", () => {
		expect(langId("Component.jsx")).toBe("javascriptreact");
	});

	it.each([
		["index.js", "javascript"],
		["config.mjs", "javascript"],
		["setup.cjs", "javascript"],
	])("returns javascript for %s", (file, expected) => {
		expect(langId(file)).toBe(expected);
	});

	it("returns typescript as default", () => {
		expect(langId("main.ts")).toBe("typescript");
		expect(langId("types.d.ts")).toBe("typescript");
	});
});

// ── formatDiagnostics ───────────────────────────────────────────────

function makeDiagMap(entries: [string, LspDiagnostic[]][]): DiagnosticsMap {
	return { diagnostics: new Map(entries) };
}

describe("formatDiagnostics", () => {
	it("returns empty result when no diagnostics", () => {
		const server = makeDiagMap([]);
		const result = formatDiagnostics(server, "/project");
		expect(result.text).toBe("");
		expect(result.totalErrors).toBe(0);
		expect(result.totalWarnings).toBe(0);
	});

	it("skips URIs with empty diagnostic arrays", () => {
		const server = makeDiagMap([["file:///project/src/a.ts", []]]);
		const result = formatDiagnostics(server, "/project");
		expect(result.text).toBe("");
	});

	it("formats errors with file:line:col pattern", () => {
		const server = makeDiagMap([
			[
				"file:///project/src/index.ts",
				[{ severity: 1, range: { start: { line: 9, character: 4 } }, code: 2339, message: "Property 'x' does not exist" }],
			],
		]);
		const result = formatDiagnostics(server, "/project");
		expect(result.totalErrors).toBe(1);
		expect(result.totalWarnings).toBe(0);
		expect(result.text).toContain("src/index.ts:10:5 error TS2339: Property 'x' does not exist");
	});

	it("formats warnings correctly", () => {
		const server = makeDiagMap([
			[
				"file:///project/src/util.ts",
				[{ severity: 2, range: { start: { line: 0, character: 0 } }, code: 6133, message: "declared but never used" }],
			],
		]);
		const result = formatDiagnostics(server, "/project");
		expect(result.totalErrors).toBe(0);
		expect(result.totalWarnings).toBe(1);
		expect(result.text).toContain("warning TS6133");
	});

	it("formats info (severity 3+) as info", () => {
		const server = makeDiagMap([
			[
				"file:///project/src/a.ts",
				[{ severity: 3, message: "hint message" }],
			],
		]);
		const result = formatDiagnostics(server, "/project");
		expect(result.text).toContain("info: hint message");
	});

	it("defaults to line 1, col 1 when range is missing", () => {
		const server = makeDiagMap([
			["file:///project/src/a.ts", [{ severity: 1, message: "no range" }]],
		]);
		const result = formatDiagnostics(server, "/project");
		expect(result.text).toContain("src/a.ts:1:1 error: no range");
	});

	it("omits TS code prefix when code is absent", () => {
		const server = makeDiagMap([
			["file:///project/src/a.ts", [{ severity: 1, message: "generic" }]],
		]);
		const result = formatDiagnostics(server, "/project");
		expect(result.text).toContain("error: generic");
		expect(result.text).not.toContain("TS");
	});

	it("counts mixed errors and warnings across files", () => {
		const server = makeDiagMap([
			[
				"file:///project/src/a.ts",
				[
					{ severity: 1, message: "err1" },
					{ severity: 2, message: "warn1" },
				],
			],
			["file:///project/src/b.ts", [{ severity: 1, message: "err2" }]],
		]);
		const result = formatDiagnostics(server, "/project");
		expect(result.totalErrors).toBe(2);
		expect(result.totalWarnings).toBe(1);
		expect(result.text).toMatch(/^2 error\(s\), 1 warning\(s\):/);
	});

	it("truncates to 20 lines and shows overflow count", () => {
		const diags: LspDiagnostic[] = Array.from({ length: 25 }, (_, i) => ({
			severity: 1,
			message: `error ${i}`,
		}));
		const server = makeDiagMap([["file:///project/src/big.ts", diags]]);
		const result = formatDiagnostics(server, "/project");
		const lines = result.text.split("\n");
		// 1 header + 20 diag lines + 1 overflow = 22
		expect(lines).toHaveLength(22);
		expect(lines[21]).toBe("... and 5 more");
	});
});

// ── parseJsonRpcMessages ────────────────────────────────────────────

function makeRpcPayload(obj: object): string {
	const body = JSON.stringify(obj);
	return `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`;
}

describe("parseJsonRpcMessages", () => {
	it("parses a single complete message", () => {
		const state = { buffer: "" };
		const msgs = parseJsonRpcMessages(state, makeRpcPayload({ jsonrpc: "2.0", id: 1, result: "ok" }));
		expect(msgs).toHaveLength(1);
		expect(msgs[0]).toEqual({ jsonrpc: "2.0", id: 1, result: "ok" });
		expect(state.buffer).toBe("");
	});

	it("parses multiple messages in one chunk", () => {
		const state = { buffer: "" };
		const chunk = makeRpcPayload({ id: 1 }) + makeRpcPayload({ id: 2 });
		const msgs = parseJsonRpcMessages(state, chunk);
		expect(msgs).toHaveLength(2);
		expect(msgs[0].id).toBe(1);
		expect(msgs[1].id).toBe(2);
	});

	it("buffers incomplete messages across chunks", () => {
		const state = { buffer: "" };
		const full = makeRpcPayload({ id: 1, result: "split" });
		const half = Math.floor(full.length / 2);

		const msgs1 = parseJsonRpcMessages(state, full.slice(0, half));
		expect(msgs1).toHaveLength(0);
		expect(state.buffer.length).toBeGreaterThan(0);

		const msgs2 = parseJsonRpcMessages(state, full.slice(half));
		expect(msgs2).toHaveLength(1);
		expect(msgs2[0].result).toBe("split");
		expect(state.buffer).toBe("");
	});

	it("skips headers without Content-Length", () => {
		const state = { buffer: "" };
		const badHeader = "X-Custom: true\r\n\r\n";
		const good = makeRpcPayload({ id: 1 });
		const msgs = parseJsonRpcMessages(state, badHeader + good);
		expect(msgs).toHaveLength(1);
		expect(msgs[0].id).toBe(1);
	});

	it("skips invalid JSON bodies gracefully", () => {
		const state = { buffer: "" };
		const bad = "Content-Length: 5\r\n\r\n{bad}";
		const good = makeRpcPayload({ id: 2 });
		const msgs = parseJsonRpcMessages(state, bad + good);
		expect(msgs).toHaveLength(1);
		expect(msgs[0].id).toBe(2);
	});

	it("returns empty array on empty chunk", () => {
		const state = { buffer: "" };
		expect(parseJsonRpcMessages(state, "")).toEqual([]);
	});
});

// ── routeMessage ────────────────────────────────────────────────────

function makePendingMap(): PendingMap {
	return { pending: new Map(), diagnostics: new Map(), buffer: "" };
}

describe("routeMessage", () => {
	it("resolves pending request on result", () => {
		const server = makePendingMap();
		const resolve = vi.fn();
		const reject = vi.fn();
		server.pending.set(1, { resolve, reject });

		routeMessage(server, { id: 1, result: { hover: "info" } });
		expect(resolve).toHaveBeenCalledWith({ hover: "info" });
		expect(reject).not.toHaveBeenCalled();
		expect(server.pending.has(1)).toBe(false);
	});

	it("rejects pending request on error", () => {
		const server = makePendingMap();
		const resolve = vi.fn();
		const reject = vi.fn();
		server.pending.set(2, { resolve, reject });

		routeMessage(server, { id: 2, error: { code: -32600, message: "Invalid" } });
		expect(reject).toHaveBeenCalledWith({ code: -32600, message: "Invalid" });
		expect(resolve).not.toHaveBeenCalled();
	});

	it("ignores messages with unknown ids", () => {
		const server = makePendingMap();
		// Should not throw
		routeMessage(server, { id: 999, result: "orphan" });
		expect(server.pending.size).toBe(0);
	});

	it("captures publishDiagnostics notifications", () => {
		const server = makePendingMap();
		routeMessage(server, {
			method: "textDocument/publishDiagnostics",
			params: {
				uri: "file:///project/src/a.ts",
				diagnostics: [{ severity: 1, message: "err" }],
			},
		});
		expect(server.diagnostics.get("file:///project/src/a.ts")).toEqual([{ severity: 1, message: "err" }]);
	});

	it("defaults to empty array when diagnostics field is missing", () => {
		const server = makePendingMap();
		routeMessage(server, {
			method: "textDocument/publishDiagnostics",
			params: { uri: "file:///project/src/b.ts" },
		});
		expect(server.diagnostics.get("file:///project/src/b.ts")).toEqual([]);
	});

	it("ignores non-diagnostic notifications", () => {
		const server = makePendingMap();
		routeMessage(server, { method: "window/logMessage", params: { message: "log" } });
		expect(server.diagnostics.size).toBe(0);
	});
});
