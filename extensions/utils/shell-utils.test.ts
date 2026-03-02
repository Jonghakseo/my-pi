import { describe, expect, it } from "vitest";
import { buildRecorderArgs, hasRmRf } from "./shell-utils.js";

// ─── hasRmRf ────────────────────────────────────────────────────────────

describe("hasRmRf", () => {
	it("detects rm -rf", () => {
		expect(hasRmRf("rm -rf /")).toBe(true);
	});

	it("detects rm -rf with directory", () => {
		expect(hasRmRf("rm -rf /tmp/dir")).toBe(true);
	});

	it("detects rm -r -f", () => {
		expect(hasRmRf("rm -r -f /tmp/dir")).toBe(true);
	});

	it("detects rm -f -r (reversed)", () => {
		expect(hasRmRf("rm -f -r /tmp/dir")).toBe(true);
	});

	it("detects rm --recursive --force", () => {
		expect(hasRmRf("rm --recursive --force /tmp/dir")).toBe(true);
	});

	it("detects rm -Rf (capital R)", () => {
		expect(hasRmRf("rm -Rf /tmp/dir")).toBe(true);
	});

	it("detects rm -fR (reversed)", () => {
		expect(hasRmRf("rm -fR /tmp/dir")).toBe(true);
	});

	it("rejects rm without -rf", () => {
		expect(hasRmRf("rm file.txt")).toBe(false);
	});

	it("rejects rm -r without -f", () => {
		expect(hasRmRf("rm -r /tmp/dir")).toBe(false);
	});

	it("rejects rm -f without -r", () => {
		expect(hasRmRf("rm -f file.txt")).toBe(false);
	});

	it("handles pipe commands (only checks rm segment)", () => {
		expect(hasRmRf("echo hello | rm file.txt")).toBe(false);
	});

	it("detects rm -rf in piped command", () => {
		expect(hasRmRf("ls | xargs rm -rf")).toBe(true);
	});

	it("detects rm -rf after semicolon", () => {
		expect(hasRmRf("echo hi; rm -rf /tmp")).toBe(true);
	});

	it("handles no rm at all", () => {
		expect(hasRmRf("echo hello world")).toBe(false);
	});

	it("handles empty command", () => {
		expect(hasRmRf("")).toBe(false);
	});

	it("detects combined flags -rfv", () => {
		expect(hasRmRf("rm -rfv /tmp/dir")).toBe(true);
	});

	it("detects --recursive with short -f", () => {
		expect(hasRmRf("rm --recursive -f /tmp")).toBe(true);
	});

	it("detects -r with --force", () => {
		expect(hasRmRf("rm -r --force /tmp")).toBe(true);
	});
});

// ─── buildRecorderArgs ──────────────────────────────────────────────────

describe("buildRecorderArgs", () => {
	it("builds args for rec binary", () => {
		const args = buildRecorderArgs("rec", "/tmp/voice.wav");
		expect(args[0]).toBe("-q");
		expect(args).toContain("/tmp/voice.wav");
		expect(args).toContain("-r");
		expect(args).toContain("16000");
		expect(args).not.toContain("-d");
	});

	it("builds args for sox binary (includes -d)", () => {
		const args = buildRecorderArgs("sox", "/tmp/voice.wav");
		expect(args).toContain("-d");
		expect(args).toContain("/tmp/voice.wav");
	});

	it("uses rec-style for /usr/bin/rec", () => {
		const args = buildRecorderArgs("/usr/bin/rec", "/tmp/test.wav");
		expect(args).not.toContain("-d");
	});

	it("uses sox-style for /usr/bin/sox", () => {
		const args = buildRecorderArgs("/usr/bin/sox", "/tmp/test.wav");
		expect(args).toContain("-d");
	});

	it("includes correct sample rate and channels", () => {
		const args = buildRecorderArgs("rec", "/out.wav");
		expect(args).toContain("-r");
		expect(args).toContain("16000");
		expect(args).toContain("-c");
		expect(args).toContain("1");
		expect(args).toContain("-b");
		expect(args).toContain("16");
	});
});
