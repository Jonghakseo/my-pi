import { defineConfig } from "vitest/config";

const coverageCanaryInclude = [
	// Utility modules with stable deterministic tests.
	"agent-utils.ts",
	"data-utils.ts",
	"format-utils.ts",
	"git-utils.ts",
	"memory-parse-utils.ts",
	"message-utils.ts",
	"parse-utils.ts",
	"path-utils.ts",
	"shell-utils.ts",
	"string-utils.ts",
	"subagent-format-bridge.ts",
	"subagent-invocation-queue.ts",
	"text-utils.ts",
	"time-utils.ts",
	"todo-utils.ts",
	"type-guards.ts",
];

export default defineConfig({
	test: {
		include: ["**/*.test.ts"],
		root: import.meta.dirname,
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
