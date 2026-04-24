import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import {
	countUnresolvedReviewComments,
	fetchCurrentPullRequestInfo,
	fetchUnresolvedPullRequestReviewComments,
	formatUnresolvedReviewCommentsForEditor,
	parseCurrentPullRequest,
} from "./github-pr-review-comments.js";

describe("github-pr-review-comments", () => {
	it("parses the current pull request from gh pr view output", () => {
		const pullRequest = parseCurrentPullRequest(
			JSON.stringify({
				number: 123,
				title: "Add /pr-comments",
				url: "https://github.com/acme/pi/pull/123",
			}),
		);

		expect(pullRequest).toEqual({
			number: 123,
			title: "Add /pr-comments",
			url: "https://github.com/acme/pi/pull/123",
			owner: "acme",
			repo: "pi",
		});
	});

	it("fetches unresolved review threads across thread/comment pagination, including outdated threads", async () => {
		const exec = vi
			.fn()
			.mockResolvedValueOnce({
				code: 0,
				stdout: JSON.stringify({
					data: {
						repository: {
							pullRequest: {
								reviewThreads: {
									pageInfo: { hasNextPage: true, endCursor: "thread-page-2" },
									nodes: [
										{
											id: "thread-1",
											isResolved: false,
											isOutdated: false,
											path: "src/pr-comments.ts",
											line: 42,
											originalLine: 42,
											startLine: null,
											originalStartLine: null,
											comments: {
												totalCount: 2,
												pageInfo: { hasNextPage: true, endCursor: "comment-page-2" },
												nodes: [
													{
														author: { login: "alice" },
														body: "Please rename this helper.",
														url: "https://github.com/acme/pi/pull/123#discussion_r1",
														createdAt: "2026-04-22T00:00:00Z",
													},
												],
											},
										},
										{
											id: "thread-resolved",
											isResolved: true,
											isOutdated: false,
											path: "src/ignored.ts",
											line: 10,
											originalLine: 10,
											startLine: null,
											originalStartLine: null,
											comments: {
												totalCount: 1,
												pageInfo: { hasNextPage: false, endCursor: null },
												nodes: [],
											},
										},
									],
								},
							},
						},
					},
				}),
			})
			.mockResolvedValueOnce({
				code: 0,
				stdout: JSON.stringify({
					data: {
						node: {
							comments: {
								totalCount: 2,
								pageInfo: { hasNextPage: false, endCursor: null },
								nodes: [
									{
										author: { login: "bob" },
										body: "Please add a test too.",
										url: "https://github.com/acme/pi/pull/123#discussion_r2",
										createdAt: "2026-04-22T01:00:00Z",
									},
								],
							},
						},
					},
				}),
			})
			.mockResolvedValueOnce({
				code: 0,
				stdout: JSON.stringify({
					data: {
						repository: {
							pullRequest: {
								reviewThreads: {
									pageInfo: { hasNextPage: false, endCursor: null },
									nodes: [
										{
											id: "thread-2",
											isResolved: false,
											isOutdated: false,
											path: "src/other.ts",
											line: 12,
											originalLine: 12,
											startLine: 10,
											originalStartLine: 10,
											comments: {
												totalCount: 1,
												pageInfo: { hasNextPage: false, endCursor: null },
												nodes: [
													{
														author: { login: "carol" },
														body: "Range comment",
														url: null,
														createdAt: "2026-04-22T02:00:00Z",
													},
												],
											},
										},
										{
											id: "thread-outdated",
											isResolved: false,
											isOutdated: true,
											path: "src/outdated.ts",
											line: 1,
											originalLine: 1,
											startLine: null,
											originalStartLine: null,
											comments: {
												totalCount: 1,
												pageInfo: { hasNextPage: false, endCursor: null },
												nodes: [
													{
														author: { login: "dave" },
														body: "Still needs a reply even though the diff moved.",
														url: "https://github.com/acme/pi/pull/123#discussion_r3",
														createdAt: "2026-04-22T03:00:00Z",
													},
												],
											},
										},
									],
								},
							},
						},
					},
				}),
			});
		const pi = { exec } as unknown as ExtensionAPI;

		const summary = await fetchUnresolvedPullRequestReviewComments(pi, "/tmp/repo", {
			number: 123,
			title: "Add /pr-comments",
			url: "https://github.com/acme/pi/pull/123",
			owner: "acme",
			repo: "pi",
		});

		expect(summary).not.toBeNull();
		expect(summary?.threads).toEqual([
			{
				id: "thread-1",
				path: "src/pr-comments.ts",
				line: 42,
				originalLine: 42,
				startLine: null,
				originalStartLine: null,
				comments: [
					{
						author: "alice",
						body: "Please rename this helper.",
						url: "https://github.com/acme/pi/pull/123#discussion_r1",
						createdAt: "2026-04-22T00:00:00Z",
					},
					{
						author: "bob",
						body: "Please add a test too.",
						url: "https://github.com/acme/pi/pull/123#discussion_r2",
						createdAt: "2026-04-22T01:00:00Z",
					},
				],
			},
			{
				id: "thread-2",
				path: "src/other.ts",
				line: 12,
				originalLine: 12,
				startLine: 10,
				originalStartLine: 10,
				comments: [
					{
						author: "carol",
						body: "Range comment",
						url: null,
						createdAt: "2026-04-22T02:00:00Z",
					},
				],
			},
			{
				id: "thread-outdated",
				path: "src/outdated.ts",
				line: 1,
				originalLine: 1,
				startLine: null,
				originalStartLine: null,
				comments: [
					{
						author: "dave",
						body: "Still needs a reply even though the diff moved.",
						url: "https://github.com/acme/pi/pull/123#discussion_r3",
						createdAt: "2026-04-22T03:00:00Z",
					},
				],
			},
		]);
		expect(countUnresolvedReviewComments(summary?.threads ?? [])).toBe(4);
		expect(exec).toHaveBeenCalledTimes(3);
		expect(exec.mock.calls[2]?.[1]).toContain("after=thread-page-2");
	});

	it("formats editor text and detects missing current pull requests", async () => {
		const exec = vi.fn().mockResolvedValue({
			code: 1,
			stderr: 'no pull requests found for branch "feature/test"',
		});
		const pi = { exec } as unknown as ExtensionAPI;

		const currentPrResult = await fetchCurrentPullRequestInfo(pi, "/tmp/repo");
		expect(currentPrResult).toEqual({
			ok: false,
			reason: "not-found",
			detail: 'no pull requests found for branch "feature/test"',
		});

		const text = formatUnresolvedReviewCommentsForEditor({
			pullRequest: {
				number: 123,
				title: "Add /pr-comments",
				url: "https://github.com/acme/pi/pull/123",
				owner: "acme",
				repo: "pi",
			},
			threads: [
				{
					id: "thread-1",
					path: "src/pr-comments.ts",
					line: 42,
					originalLine: 42,
					startLine: null,
					originalStartLine: null,
					comments: [
						{
							author: "alice",
							body: "First line\nSecond line",
							url: "https://github.com/acme/pi/pull/123#discussion_r1",
							createdAt: "2026-04-22T00:00:00Z",
						},
					],
				},
			],
		});

		expect(text).toContain("## Unresolved PR review comments — PR #123");
		expect(text).toContain("### 1. src/pr-comments.ts:42");
		expect(text).toContain("- alice — https://github.com/acme/pi/pull/123#discussion_r1");
		expect(text).toContain("  First line\n  Second line");
	});
});
