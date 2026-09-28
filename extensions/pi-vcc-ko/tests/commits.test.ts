import { describe, expect, it } from "vitest";
import { wrapLongLines } from "../src/core/format.ts";
import { extractCommits, mergeCommits, parseCommitSection } from "../src/extract/commits.ts";
import type { NormalizedBlock } from "../src/types.ts";

const commitCall = (id: string, message: string): NormalizedBlock => ({
	kind: "tool_call",
	name: "bash",
	id,
	args: { command: `git add -A && git commit -m "${message}"` },
});
const result = (toolCallId: string, text: string): NormalizedBlock => ({
	kind: "tool_result",
	name: "bash",
	toolCallId,
	text,
});

describe("commit extraction", () => {
	it("reads each hash from the commit's own result when parallel calls interleave", () => {
		const blocks: NormalizedBlock[] = [
			commitCall("a", "fix: first change"),
			{ kind: "tool_call", name: "bash", id: "log", args: { command: "git log --oneline -3" } },
			commitCall("b", "fix: second change"),
			result("log", "3e8996c older commit\n1111111 even older"),
			result("a", "[main 8811e24] fix: first change\n 1 file changed"),
			result("b", "[main dd20a7b80] fix: second change\n 2 files changed"),
		];
		expect(extractCommits(blocks)).toEqual([
			{ hash: "8811e24", message: "fix: first change" },
			{ hash: "dd20a7b80", message: "fix: second change" },
		]);
	});

	it("does not take an unrelated hex string as the commit hash", () => {
		const blocks: NormalizedBlock[] = [
			commitCall("a", "feat: quiet commit"),
			result("a", "blob 3e8996c0 stored\nrange abc1234..def5678"),
		];
		expect(extractCommits(blocks)).toEqual([{ message: "feat: quiet commit" }]);
	});

	it("accepts git's root-commit and detached HEAD confirmation lines", () => {
		const blocks: NormalizedBlock[] = [
			commitCall("a", "init"),
			result("a", "[main (root-commit) 1a2b3c4] init"),
			commitCall("b", "wip"),
			result("b", "[detached HEAD 5d6e7f8] wip"),
		];
		expect(extractCommits(blocks).map((c) => c.hash)).toEqual(["1a2b3c4", "5d6e7f8"]);
	});

	it("skips a commit whose output shows it failed", () => {
		const blocks: NormalizedBlock[] = [
			commitCall("a", "fix: blocked by hook"),
			result("a", "husky - pre-commit hook failed (add --no-verify to bypass)\nerror: lint failed"),
		];
		expect(extractCommits(blocks)).toEqual([]);
	});

	it("folds a commit seen without its hash into the hashed record", () => {
		const merged = mergeCommits(
			[{ message: "feat: activate providers" }, { hash: "2cdd3e892", message: "feat: settle work" }],
			[{ hash: "ae02e93b5", message: "feat: activate providers" }],
		);
		expect(merged).toEqual([
			{ hash: "ae02e93b5", message: "feat: activate providers" },
			{ hash: "2cdd3e892", message: "feat: settle work" },
		]);
	});

	it("keeps two commits that share a message but have different hashes", () => {
		const merged = mergeCommits(
			[{ hash: "1111111", message: "fix: typo" }],
			[{ hash: "2222222", message: "fix: typo" }],
		);
		expect(merged).toHaveLength(2);
	});

	it("parses wrapped commit lines from a legacy summary section", () => {
		const long = `c0ad5272c: fix: ${"match approved dock visuals and enable minimized dragging ".repeat(3).trim()}`;
		const section = wrapLongLines(`[Commits]\n- ${long}\n- feat: no hash here`);
		expect(section.split("\n").length).toBeGreaterThan(3);
		expect(parseCommitSection(section)).toEqual([
			{ hash: "c0ad5272c", message: long.slice("c0ad5272c: ".length) },
			{ message: "feat: no hash here" },
		]);
	});
});
