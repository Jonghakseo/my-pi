import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { fetchCurrentPullRequestInfo, type PullRequestInfo } from "../utils/github-pr-review-comments.ts";
import { fetchPullRequestMergeStatus, mergePullRequest } from "../utils/github-pr-merge.ts";

function notify(ctx: ExtensionContext, message: string, level: "info" | "warning" | "error"): void {
	if (!ctx.hasUI) return;
	ctx.ui.notify(message, level);
}

async function resolveCurrentPullRequest(pi: ExtensionAPI, ctx: ExtensionContext): Promise<PullRequestInfo | null> {
	const currentPrResult = await fetchCurrentPullRequestInfo(pi, ctx.cwd);
	if (currentPrResult.ok) return currentPrResult.pullRequest;
	if (currentPrResult.reason === "not-found") {
		notify(ctx, "현재 브랜치에 연결된 PR이 없습니다.", "warning");
		return null;
	}
	if (currentPrResult.reason === "gh-error") {
		notify(ctx, currentPrResult.detail ? `PR 조회 실패: ${currentPrResult.detail}` : "PR 조회 실패", "error");
		return null;
	}
	notify(ctx, "PR 정보를 해석하지 못했습니다.", "error");
	return null;
}

async function confirmMerge(ctx: ExtensionContext, pullRequest: PullRequestInfo): Promise<boolean> {
	if (!ctx.hasUI) return true;
	const title = pullRequest.title ? `#${pullRequest.number} ${pullRequest.title}` : `#${pullRequest.number}`;
	return ctx.ui.confirm("PR 머지", `${title} 를 merge 할까요?`);
}

export default function githubPrMerge(pi: ExtensionAPI) {
	pi.registerCommand("github:pr-merge", {
		description: "현재 브랜치의 PR을 gh CLI로 merge",
		handler: async (_args, ctx) => {
			const pullRequest = await resolveCurrentPullRequest(pi, ctx);
			if (!pullRequest) return;

			const confirmed = await confirmMerge(ctx, pullRequest);
			if (!confirmed) return;

			const status = await fetchPullRequestMergeStatus(pi, ctx.cwd, pullRequest);
			if (!status) {
				notify(ctx, "PR 머지 상태 조회 실패", "error");
				return;
			}
			if (status.isDraft) {
				notify(ctx, "Draft PR은 머지할 수 없습니다.", "warning");
				return;
			}

			const result = await mergePullRequest(pi, ctx.cwd, pullRequest, status);
			if (result.code !== 0) {
				const detail = (result.stderr ?? result.stdout ?? "").trim();
				notify(ctx, detail ? `PR 머지 실패: ${detail}` : "PR 머지 실패", "error");
				return;
			}

			notify(ctx, `PR #${pullRequest.number} 머지 완료`, "info");
		},
	});
}
