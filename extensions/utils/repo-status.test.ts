import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRepoStatusTracker } from "./repo-status.js";

async function flushAsyncWork() {
	for (let i = 0; i < 6; i += 1) {
		await Promise.resolve();
	}
}

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

		await flushAsyncWork();

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

	it.each([
		["APPROVED", [], [], "approved"],
		["REVIEW_REQUIRED", [{ author: { login: "alice" }, state: "CHANGES_REQUESTED" }], [], "changes_requested"],
		["REVIEW_REQUIRED", [{ author: { login: "alice" }, state: "COMMENTED" }], [], "commented"],
		["REVIEW_REQUIRED", [{ author: { login: "alice" }, state: "APPROVED" }], [], "review"],
		["REVIEW_REQUIRED", [], [], "review"],
		["CHANGES_REQUESTED", [{ author: { login: "alice" }, state: "CHANGES_REQUESTED" }], [{ login: "bob" }], "review"],
		["APPROVED", [{ author: { login: "alice" }, state: "APPROVED" }], [{ login: "bob" }], "review"],
		["REVIEW_REQUIRED", [{ author: { login: "alice" }, state: "COMMENTED" }], [{ login: "bob" }], "review"],
		["CHANGES_REQUESTED", [{ author: { login: "alice" }, state: "PENDING" }], [], "review"],
	] as const)("maps PR review status to %s / %s / %s", async (reviewDecision, latestReviews, reviewRequests, expectedState) => {
		const exec = vi
			.fn()
			.mockResolvedValueOnce({
				code: 0,
				stdout: ["# branch.oid 89abcdef01234567", "# branch.head feature"].join("\n"),
			})
			.mockResolvedValueOnce({
				code: 0,
				stdout: JSON.stringify({
					number: 42,
					title: "Feature PR",
					state: "OPEN",
					reviewDecision,
					latestReviews,
					reviewRequests,
				}),
			});
		const pi = { exec } as unknown as ExtensionAPI;
		const tracker = createRepoStatusTracker(pi, "/tmp/repo");

		await flushAsyncWork();

		expect(tracker.getSnapshot().review).toEqual({ state: expectedState });

		tracker.dispose();
	});

	it.each(["CLOSED", "MERGED"])("hides PR metadata when gh pr view reports %s", async (state) => {
		const exec = vi
			.fn()
			.mockResolvedValueOnce({
				code: 0,
				stdout: ["# branch.oid 89abcdef01234567", "# branch.head production"].join("\n"),
			})
			.mockResolvedValueOnce({
				code: 0,
				stdout: JSON.stringify({
					number: 1838,
					title: "Production -> sync/prod-dev",
					url: "https://github.com/Jonghakseo/my-pi/pull/1838",
					state,
				}),
			});
		const pi = { exec } as unknown as ExtensionAPI;
		const tracker = createRepoStatusTracker(pi, "/tmp/repo");

		await flushAsyncWork();

		expect(tracker.getSnapshot()).toEqual({
			branch: "production",
			isDirty: false,
			ahead: 0,
			behind: 0,
			prNumber: null,
			prTitle: null,
			prUrl: null,
			review: null,
			checks: null,
			unresolvedInlineComments: null,
		});
		expect(exec).toHaveBeenCalledTimes(2);
		expect(exec).toHaveBeenNthCalledWith(
			2,
			"gh",
			["pr", "view", "--json", "number,title,url,state,reviewDecision,latestReviews,reviewRequests,statusCheckRollup"],
			{ cwd: "/tmp/repo" },
		);

		tracker.dispose();
	});
});
