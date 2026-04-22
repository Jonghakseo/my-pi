import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRepoStatusTracker } from "./repo-status.js";

describe("createRepoStatusTracker", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("preserves dirty state for detached HEAD checkouts while suppressing PR lookup", async () => {
		const exec = vi.fn().mockResolvedValue({
			code: 0,
			stdout: [
				"# branch.oid 89abcdef01234567",
				"# branch.head (detached)",
				"1 .M N... 100644 100644 100644 1234567 1234567 footer.ts",
			].join("\n"),
		});
		const pi = { exec } as unknown as ExtensionAPI;
		const tracker = createRepoStatusTracker(pi, "/tmp/repo");

		await Promise.resolve();
		await Promise.resolve();

		expect(tracker.getSnapshot()).toEqual({
			branch: null,
			isDirty: true,
			ahead: 0,
			behind: 0,
			prNumber: null,
			prTitle: null,
			prUrl: null,
			review: null,
			checks: null,
			unresolvedInlineComments: null,
		});
		expect(exec).toHaveBeenCalledTimes(1);
		expect(exec).toHaveBeenCalledWith("git", ["status", "--porcelain=v2", "--branch", "--untracked-files=normal"], {
			cwd: "/tmp/repo",
		});

		tracker.dispose();
	});
});
