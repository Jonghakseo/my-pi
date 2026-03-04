import { defineConfig } from "vitest/config";

const coverageCanaryInclude = [
	// Start with pure utility modules that have stable, deterministic tests.
	// Expand this list gradually as other lanes complete refactors.
	"agent-utils.ts",
	"data-utils.ts",
	"format-utils.ts",
	"memory-parse-utils.ts",
	"message-utils.ts",
	"parse-utils.ts",
	"path-utils.ts",
	"string-utils.ts",
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
