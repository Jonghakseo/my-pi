import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { fetchCurrentPullRequestInfo, type PullRequestInfo } from "./utils/github-pr-review-comments.ts";
import {
	fetchPullRequestReviewReRequestPlan,
	requestPullRequestReviewReRequest,
	type PullRequestReviewReRequestPlan,
} from "./utils/github-pr-review-re-request.ts";

function notify(ctx: ExtensionContext, message: string, level: "info" | "warning" | "error"): void {
	if (!ctx.hasUI) return;
	ctx.ui.notify(message, level);
}

function formatLabels(labels: string[]): string {
	if (labels.length === 0) return "";
	return labels.join(", ");
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

async function resolveReRequestPlan(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	pullRequest: PullRequestInfo,
): Promise<PullRequestReviewReRequestPlan | null> {
	const plan = await fetchPullRequestReviewReRequestPlan(pi, ctx.cwd, pullRequest);
	if (!plan) {
		notify(ctx, "PR 리뷰어 상태 조회 실패", "error");
		return null;
	}
	if (plan.totalReviewerCount === 0) {
		notify(ctx, "현재 PR에 설정된 리뷰어가 없습니다.", "info");
		return null;
	}
	if (plan.targetUsers.length === 0 && plan.targetTeams.length === 0) {
		notify(
			ctx,
			`재요청할 미승인 리뷰어가 없습니다. (${plan.approvedReviewerCount}/${plan.totalReviewerCount} 승인)`,
			"info",
		);
		return null;
	}
	return plan;
}

function notifyRequestResult(ctx: ExtensionContext, plan: PullRequestReviewReRequestPlan): void {
	const targets = formatLabels(plan.targetLabels);
	notify(ctx, `리뷰 재요청 완료: ${plan.targetLabels.length}명/팀${targets ? ` (${targets})` : ""}`, "info");
}

export default function prReviewReRequest(pi: ExtensionAPI) {
	pi.registerCommand("github:pr-review-re-request", {
		description: "현재 PR에서 승인되지 않은 리뷰어들에게 gh CLI로 review re-request 보내기",
		handler: async (_args, ctx) => {
			const pullRequest = await resolveCurrentPullRequest(pi, ctx);
			if (!pullRequest) return;

			const plan = await resolveReRequestPlan(pi, ctx, pullRequest);
			if (!plan) return;

			const result = await requestPullRequestReviewReRequest(pi, ctx.cwd, pullRequest, plan);
			if (result.code !== 0) {
				const detail = (result.stderr ?? result.stdout ?? "").trim();
				notify(ctx, detail ? `리뷰 재요청 실패: ${detail}` : "리뷰 재요청 실패", "error");
				return;
			}

			notifyRequestResult(ctx, plan);
		},
	});
}
