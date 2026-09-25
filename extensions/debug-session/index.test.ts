import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import debugSession from "./index.ts";

const directories = new Set<string>();
const run = promisify(execFile);

afterEach(async () => {
	await Promise.all([...directories].map((directory) => rm(directory, { recursive: true, force: true })));
	directories.clear();
});

function setup(sessionFile?: string, exportFails = false, openFails = false) {
	let handler!: (args: string, ctx: ExtensionCommandContext) => Promise<void>;
	const exec = vi.fn(async (command: string, args: string[]) => {
		if (command === "open") return { code: openFails ? 1 : 0, stdout: "", stderr: "open failed" };
		directories.add(dirname(args[2]));
		if (exportFails) return { code: 1, stdout: "", stderr: "export failed" };
		const result = await run(command, args);
		return { ...result, code: 0 };
	});
	debugSession({
		registerCommand: (name: string, command: { handler: typeof handler }) => {
			expect(name).toBe("debug-session");
			handler = command.handler;
		},
		exec,
	} as unknown as ExtensionAPI);
	const notify = vi.fn();
	const ctx = {
		cwd: process.cwd(),
		waitForIdle: async () => {},
		sessionManager: { getSessionFile: () => sessionFile },
		ui: { notify },
	} as unknown as ExtensionCommandContext;
	return { invoke: () => handler("", ctx), exec, notify };
}

async function fixture() {
	const directory = await mkdtemp(join(tmpdir(), "pi-debug-fixture-"));
	directories.add(directory);
	const path = join(directory, "session with spaces.jsonl");
	await writeFile(
		path,
		`${JSON.stringify({ type: "session", version: 3, id: "debug-test", timestamp: new Date().toISOString(), cwd: process.cwd() })}\n${JSON.stringify({ type: "message", id: "message1", parentId: null, timestamp: new Date().toISOString(), message: { role: "user", content: "debug-session-export-marker", timestamp: Date.now() } })}\n`,
	);
	return path;
}

describe("debug-session", () => {
	it("exports real session content to unique temporary HTML files and opens each file", async () => {
		const { invoke, exec, notify } = setup(await fixture());
		await invoke();
		await invoke();
		const opened = exec.mock.calls.filter(([command]) => command === "open");
		expect(opened).toHaveLength(2);
		expect(opened[0][1][0]).not.toBe(opened[1][1][0]);
		for (const [, [path]] of opened) {
			expect(path.startsWith(tmpdir())).toBe(true);
			const html = await readFile(path, "utf8");
			expect(html.toLowerCase()).toContain("<!doctype html>");
			const encoded = html.match(/<script id="session-data" type="application\/json">([^<]+)<\/script>/);
			if (!encoded) throw new Error("Missing session data in exported HTML");
			expect(Buffer.from(encoded[1], "base64").toString("utf8")).toContain("debug-session-export-marker");
		}
		expect(notify).toHaveBeenLastCalledWith(expect.stringContaining("세션 HTML을 열었습니다"), "info");
	});

	it("warns without spawning commands for an unsaved session", async () => {
		const { invoke, exec, notify } = setup();
		await invoke();
		expect(exec).not.toHaveBeenCalled();
		expect(notify).toHaveBeenCalledWith(expect.any(String), "warning");
	});

	it("does not open a failed export", async () => {
		const { invoke, exec, notify } = setup("missing.jsonl", true);
		await invoke();
		expect(exec.mock.calls.some(([command]) => command === "open")).toBe(false);
		expect(notify).toHaveBeenCalledWith(expect.stringContaining("export failed"), "error");
	});

	it("keeps the exported file and reports its path when opening fails", async () => {
		const { invoke, exec, notify } = setup(await fixture(), false, true);
		await invoke();
		const opened = exec.mock.calls.find(([command]) => command === "open");
		if (!opened) throw new Error("open was not called");
		const path = opened[1][0];
		expect(await readFile(path, "utf8")).toContain("<!DOCTYPE html>");
		expect(notify).toHaveBeenLastCalledWith(expect.stringContaining(path), "error");
	});
});
