import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

const PROTECTED = ["main", "master", "develop", "dev", "staging", "production"];

export default function branchRename(pi: ExtensionAPI) {
	pi.registerCommand("auto-branch", {
		description: "Analyze context and rename current branch with a proper name (runs in background)",
		handler: async (args, ctx) => {
			const [branchResult, listResult, logResult, diffResult] = await Promise.all([
				pi.exec("git", ["branch", "--show-current"]),
				pi.exec("git", ["branch", "--format=%(refname:short)"]),
				pi.exec("git", ["log", "--oneline", "-10"]),
				pi.exec("git", ["diff", "--stat", "HEAD~1"], { timeout: 5000 }).catch(() => null),
			]);

			if (branchResult.code !== 0) {
				ctx.ui.notify("Git 저장소가 아닙니다.", "error");
				return;
			}

			const currentBranch = branchResult.stdout.trim();
			if (PROTECTED.includes(currentBranch)) {
				ctx.ui.notify(`${currentBranch}은 기본 브랜치라 변경하지 않습니다.`, "warning");
				return;
			}

			ctx.ui.setStatus("auto-branch", "🔍 브랜치 이름 변경 중...");

			const prompt = `You are a branch naming assistant. Analyze the context and output ONLY the ideal branch name. No explanation, no markdown, just the branch name on a single line.

Current branch: ${currentBranch}
${args ? `User hint: ${args}` : ""}

Local branches (follow this naming pattern):
${listResult.stdout.trim()}

Recent commits:
${logResult.stdout.trim()}

Changed files:
${diffResult?.stdout?.trim() || "(no diff)"}

Rules:
- Match the naming convention of existing local branches exactly.
- Infer branch purpose from commits and changed files.
- Output only the new branch name. Nothing else.`;

			const result = await pi.exec("pi", ["-p", prompt], { timeout: 30000 });
			ctx.ui.setStatus("auto-branch", "");

			if (result.code !== 0) {
				ctx.ui.notify("분석 실패", "error");
				return;
			}

			const suggested = result.stdout.trim().split("\n").pop()?.trim();
			if (!suggested || suggested === currentBranch) {
				ctx.ui.notify("현재 이름이 이미 적절합니다.", "info");
				return;
			}

			const renameResult = await pi.exec("git", ["branch", "-m", suggested]);
			if (renameResult.code !== 0) {
				ctx.ui.notify(`실패: ${renameResult.stderr.trim()}`, "error");
				return;
			}

			ctx.ui.notify(`✓ ${currentBranch} → ${suggested}`, "info");
		},
	});
}
