import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const configDir = dirname(fileURLToPath(import.meta.url));
const extensionsRoot = resolve(configDir, "..");

const coverageCanaryInclude = [
	// Utility modules with stable deterministic tests.
	"utils/agent-utils.ts",
	"utils/diff-overlay-utils.ts",
	"utils/format-utils.ts",
	"utils/git-utils.ts",
	"utils/path-utils.ts",
	"utils/string-utils.ts",
	"utils/subagent-format-bridge.ts",
	"utils/subagent-invocation-queue.ts",
	"utils/time-utils.ts",
	"utils/usage-analytics.ts",
];

export default defineConfig({
	test: {
		include: ["**/*.test.ts"],
		root: extensionsRoot,
		coverage: {
			provider: "v8",
			reporter: ["text", "html", "json-summary"],
			include: coverageCanaryInclude,
			exclude: ["**/*.test.ts", "**/*.d.ts"],
			thresholds: {
				lines: 80,
				functions: 85,
				branches: 70,
				statements: 80,
			},
		},
	},
});
