import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import {
	fetchCurrentPullRequestInfo,
	fetchUnresolvedPullRequestReviewComments,
	formatUnresolvedReviewCommentsForEditor,
} from "./utils/github-pr-review-comments.ts";

function buildAppendedEditorText(current: string, addition: string): string {
	if (!current.trim()) return addition;
	if (current.endsWith("\n\n")) return `${current}---\n\n${addition}`;
	if (current.endsWith("\n")) return `${current}\n---\n\n${addition}`;
	return `${current}\n\n---\n\n${addition}`;
}

function notify(ctx: ExtensionContext, message: string, level: "info" | "warning" | "error"): void {
	if (!ctx.hasUI) return;
	ctx.ui.notify(message, level);
}

export default function prComments(pi: ExtensionAPI) {
	pi.registerCommand("pr-comments", {
		description: "Append unresolved inline review comments from the current PR to the editor",
		handler: async (_args, ctx) => {
			const currentPrResult = await fetchCurrentPullRequestInfo(pi, ctx.cwd);
			if (!currentPrResult.ok) {
				if (currentPrResult.reason === "not-found") {
					notify(ctx, "현재 브랜치에 연결된 PR이 없습니다.", "warning");
					return;
				}
				if (currentPrResult.reason === "gh-error") {
					notify(ctx, currentPrResult.detail ? `PR 조회 실패: ${currentPrResult.detail}` : "PR 조회 실패", "error");
					return;
				}
				notify(ctx, "PR 정보를 해석하지 못했습니다.", "error");
				return;
			}

			const summary = await fetchUnresolvedPullRequestReviewComments(pi, ctx.cwd, currentPrResult.pullRequest);
			if (!summary) {
				notify(ctx, "PR review comment 조회 실패", "error");
				return;
			}
			if (summary.threads.length === 0) {
				notify(ctx, "미해결 inline review comment가 없습니다.", "info");
				return;
			}

			const editorText = formatUnresolvedReviewCommentsForEditor(summary);
			if (ctx.hasUI) {
				const current = ctx.ui.getEditorText() ?? "";
				ctx.ui.setEditorText(buildAppendedEditorText(current, editorText));
			}
			notify(ctx, `미해결 PR 코멘트 ${summary.threads.length}개 스레드를 에디터에 추가했습니다.`, "info");
		},
	});
}
