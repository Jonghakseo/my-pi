import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { findNearestProjectSubagentConfig, loadSubagentConfig } from "../subagent/config.ts";

const tempDirs: string[] = [];

function createTempDir(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "subagent-config-test-"));
	tempDirs.push(dir);
	return dir;
}

function writeJson(filePath: string, value: unknown): void {
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf-8");
}

afterEach(() => {
	while (tempDirs.length > 0) {
		const dir = tempDirs.pop();
		if (dir) fs.rmSync(dir, { recursive: true, force: true });
	}
});

describe("subagent config", () => {
	it("defaults claudeRuntime to sdk when config is missing", () => {
		const tmpDir = createTempDir();

		expect(loadSubagentConfig(tmpDir, { globalPath: null, projectPath: null })).toEqual({ claudeRuntime: "sdk" });
	});

	it("finds the nearest project .pi/subagent.json", () => {
		const tmpDir = createTempDir();
		const configPath = path.join(tmpDir, ".pi", "subagent.json");
		const nestedDir = path.join(tmpDir, "apps", "web", "src");
		fs.mkdirSync(nestedDir, { recursive: true });
		writeJson(configPath, { claudeRuntime: "cli" });

		expect(findNearestProjectSubagentConfig(nestedDir)).toBe(configPath);
		expect(loadSubagentConfig(nestedDir, { globalPath: null })).toEqual({ claudeRuntime: "cli" });
	});

	it("reads claudeRuntime from settings.json and lets project config override it", () => {
		const tmpDir = createTempDir();
		const globalPath = path.join(tmpDir, "settings.json");
		const projectPath = path.join(tmpDir, ".pi", "subagent.json");
		writeJson(globalPath, { subagent: { claudeRuntime: "cli" } });
		writeJson(projectPath, { claudeRuntime: "sdk" });

		expect(loadSubagentConfig(tmpDir, { globalPath })).toEqual({ claudeRuntime: "sdk" });
	});

	it("ignores invalid config values and falls back to sdk", () => {
		const tmpDir = createTempDir();
		const projectPath = path.join(tmpDir, ".pi", "subagent.json");
		writeJson(projectPath, { claudeRuntime: "weird" });

		expect(loadSubagentConfig(tmpDir, { globalPath: null })).toEqual({ claudeRuntime: "sdk" });
	});
});
