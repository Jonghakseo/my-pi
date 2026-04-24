import { describe, expect, it } from "vitest";
import { shouldInterceptSlashCommand } from "../command-typo-assist/index.ts";

describe("shouldInterceptSlashCommand", () => {
	it("intercepts actual slash commands", () => {
		expect(shouldInterceptSlashCommand("/reload")).toBe(true);
		expect(shouldInterceptSlashCommand("/subagent run planner -- test")).toBe(true);
	});

	it("ignores nested absolute filesystem paths", () => {
		expect(shouldInterceptSlashCommand("/var/folders/rz/qnhm16hj2kgcdrw5msbnqbx00000gn/")).toBe(false);
		expect(shouldInterceptSlashCommand("/tmp/example.txt")).toBe(false);
	});

	it("ignores existing single-segment absolute paths", () => {
		expect(shouldInterceptSlashCommand("/tmp")).toBe(false);
	});
});
