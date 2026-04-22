import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import {
	fetchPullRequestReviewReRequestPlan,
	GITHUB_PR_REVIEW_RE_REQUEST_INTERNALS,
	parsePullRequestReviewReRequestPlan,
	requestPullRequestReviewReRequest,
} from "./github-pr-review-re-request.js";

describe("github-pr-review-re-request", () => {
	it("builds a re-request plan from requested reviewers and latest reviews", () => {
		const plan = parsePullRequestReviewReRequestPlan(
			JSON.stringify({
				reviewRequests: [
					{ requestedReviewer: { login: "bob" } },
					{ requestedReviewer: { slug: "frontend", organization: { login: "acme" } } },
				],
				latestReviews: [
					{ author: { login: "alice" }, state: "APPROVED" },
					{ author: { login: "carol" }, state: "CHANGES_REQUESTED" },
					{ author: { login: "dave" }, state: "COMMENTED" },
				],
			}),
		);

		expect(plan).toEqual({
			totalReviewerCount: 5,
			approvedReviewerCount: 1,
			targetUsers: ["bob", "carol", "dave"],
			targetTeams: ["frontend"],
			targetLabels: ["@acme/frontend", "@bob", "@carol", "@dave"],
			approvedLabels: ["@alice"],
		});
	});

	it("returns no re-request targets when every user reviewer approved", () => {
		const plan = parsePullRequestReviewReRequestPlan(
			JSON.stringify({
				reviewRequests: [{ requestedReviewer: { login: "alice" } }],
				latestReviews: [{ author: { login: "alice" }, state: "APPROVED" }],
			}),
		);

		expect(plan).toEqual({
			totalReviewerCount: 1,
			approvedReviewerCount: 1,
			targetUsers: [],
			targetTeams: [],
			targetLabels: [],
			approvedLabels: ["@alice"],
		});
	});

	it("fetches reviewer state and sends gh api re-request", async () => {
		const exec = vi
			.fn()
			.mockResolvedValueOnce({
				code: 0,
				stdout: JSON.stringify({
					reviewRequests: [{ requestedReviewer: { login: "bob" } }],
					latestReviews: [{ author: { login: "alice" }, state: "APPROVED" }],
				}),
			})
			.mockResolvedValueOnce({ code: 0, stdout: "{}" });
		const pi = { exec } as unknown as ExtensionAPI;
		const pullRequest = {
			number: 123,
			title: "Add /pr-review-re-request",
			url: "https://github.com/acme/pi/pull/123",
			owner: "acme",
			repo: "pi",
		};

		const plan = await fetchPullRequestReviewReRequestPlan(pi, "/tmp/repo", pullRequest);
		expect(plan).toEqual({
			totalReviewerCount: 2,
			approvedReviewerCount: 1,
			targetUsers: ["bob"],
			targetTeams: [],
			targetLabels: ["@bob"],
			approvedLabels: ["@alice"],
		});

		expect(plan).not.toBeNull();
		if (!plan) throw new Error("expected plan to be present");

		const result = await requestPullRequestReviewReRequest(pi, "/tmp/repo", pullRequest, plan);
		expect(result.code).toBe(0);
		expect(exec).toHaveBeenNthCalledWith(
			1,
			"gh",
			["pr", "view", "123", "--json", GITHUB_PR_REVIEW_RE_REQUEST_INTERNALS.PR_REVIEWERS_VIEW_JSON_FIELDS],
			{ cwd: "/tmp/repo" },
		);
		expect(exec).toHaveBeenNthCalledWith(
			2,
			"gh",
			[
				"api",
				"--method",
				"POST",
				"-H",
				"Accept: application/vnd.github+json",
				"-H",
				"X-GitHub-Api-Version: 2022-11-28",
				"repos/acme/pi/pulls/123/requested_reviewers",
				"-f",
				"reviewers[]=bob",
			],
			{ cwd: "/tmp/repo" },
		);
	});
});
