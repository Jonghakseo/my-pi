import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import {
	fetchPullRequestMergeStatus,
	GITHUB_PR_MERGE_INTERNALS,
	mergePullRequest,
	parsePullRequestMergeStatus,
} from "./github-pr-merge.js";

describe("github-pr-merge", () => {
	it("parses merge status from gh pr view output", () => {
		const status = parsePullRequestMergeStatus(
			JSON.stringify({
				headRefOid: "abc123",
				isDraft: false,
				mergeStateStatus: "CLEAN",
				reviewDecision: "APPROVED",
			}),
		);

		expect(status).toEqual({
			headRefOid: "abc123",
			isDraft: false,
			mergeStateStatus: "CLEAN",
			reviewDecision: "APPROVED",
		});
	});

	it("fetches merge status and merges with head sha guard", async () => {
		const exec = vi
			.fn()
			.mockResolvedValueOnce({
				code: 0,
				stdout: JSON.stringify({
					headRefOid: "abc123",
					isDraft: false,
					mergeStateStatus: "CLEAN",
					reviewDecision: "APPROVED",
				}),
			})
			.mockResolvedValueOnce({ code: 0, stdout: "merged" });
		const pi = { exec } as unknown as ExtensionAPI;
		const pullRequest = {
			number: 123,
			title: "Add /github:pr-merge",
			url: "https://github.com/acme/pi/pull/123",
			owner: "acme",
			repo: "pi",
		};

		const status = await fetchPullRequestMergeStatus(pi, "/tmp/repo", pullRequest);
		expect(status).toEqual({
			headRefOid: "abc123",
			isDraft: false,
			mergeStateStatus: "CLEAN",
			reviewDecision: "APPROVED",
		});
		expect(status).not.toBeNull();
		if (!status) throw new Error("expected status to be present");

		const result = await mergePullRequest(pi, "/tmp/repo", pullRequest, status);
		expect(result.code).toBe(0);
		expect(exec).toHaveBeenNthCalledWith(
			1,
			"gh",
			["pr", "view", "123", "--json", GITHUB_PR_MERGE_INTERNALS.PR_MERGE_VIEW_JSON_FIELDS],
			{ cwd: "/tmp/repo" },
		);
		expect(exec).toHaveBeenNthCalledWith(2, "gh", ["pr", "merge", "123", "--merge", "--match-head-commit", "abc123"], {
			cwd: "/tmp/repo",
		});
	});
});
