import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const configDir = dirname(fileURLToPath(import.meta.url));
const extensionsRoot = resolve(configDir, "..");

const coverageCanaries = [
	// Utility modules with stable deterministic tests.
	"utils/agent-utils.ts",
	"diff-overlay/diff-overlay-utils.ts",
	"utils/format-utils.ts",
	"utils/git-utils.ts",
	"utils/path-utils.ts",
	"utils/string-utils.ts",
	"utils/time-utils.ts",
	// Additional pure logic modules already meeting the default thresholds.
	"cron/schedule.ts",
	"cron/store.ts",
	"interactive-shell/render-utils.ts",
	"interactive-shell/session-query.ts",
	"subagent/claude-args.ts",
];

const defaultCoverageThresholds = {
	lines: 80,
	functions: 85,
	branches: 70,
	statements: 80,
};

const adjustedCoverageThresholds = {
	// Current: lines 38.88%, functions 70%, branches 27.5%, statements 39.6%.
	"subagent/format.ts": { lines: 33, functions: 65, branches: 22, statements: 34 },
	// Current: lines 77.77%, functions 75%, branches 100%, statements 81.81%.
	"subagent/invocation-queue.ts": { lines: 72, functions: 70, branches: 95, statements: 76 },
	// Current: lines 42.85%, functions 53.52%, branches 39.41%, statements 39.63%.
	"usage-analytics/index.ts": { lines: 37, functions: 48, branches: 34, statements: 34 },
};

export default defineConfig({
	test: {
		include: ["**/*.test.ts"],
		root: extensionsRoot,
		testTimeout: 15_000,
		coverage: {
			provider: "v8",
			reporter: ["text", "html", "json-summary"],
			include: ["**/*.ts"],
			exclude: ["**/*.test.ts", "**/*.d.ts", "tooling/**"],
			thresholds: {
				...Object.fromEntries(coverageCanaries.map((file) => [file, defaultCoverageThresholds])),
				...adjustedCoverageThresholds,
			},
		},
	},
});
