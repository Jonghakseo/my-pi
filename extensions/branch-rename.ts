import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";

const PROTECTED = ["main", "master", "develop", "dev", "staging", "production"];
const MAX_CONVERSATION_CHARS = 3000;

function extractText(content: unknown): string {
	if (!Array.isArray(content)) return "";
	return content
		.filter((b: Record<string, unknown>) => b.type === "text" && typeof b.text === "string")
		.map((b: Record<string, unknown>) => b.text as string)
		.join("")
		.trim();
}

function extractConversation(ctx: ExtensionContext): string {
	const lines: string[] = [];
	for (const entry of ctx.sessionManager.getEntries()) {
		if (!entry || entry.type !== "message") continue;
		const msg = entry.message as { role: string; content: unknown };
		if (msg.role !== "user" && msg.role !== "assistant") continue;
		const text = extractText(msg.content);
		if (text) lines.push(`${msg.role}: ${text}`);
	}
	const joined = lines.join("\n");
	if (joined.length <= MAX_CONVERSATION_CHARS) return joined;
	return joined.slice(joined.length - MAX_CONVERSATION_CHARS);
}

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

			const conversation = extractConversation(ctx);

			const prompt = `You are a branch naming assistant. Analyze the context and decide the ideal branch name.

Current branch: ${currentBranch}
${args ? `User hint: ${args}` : ""}

Local branches (follow this naming pattern):
${listResult.stdout.trim()}

Recent commits:
${logResult.stdout.trim()}

Changed files:
${diffResult?.stdout?.trim() || "(no diff)"}

Conversation history (what the developer has been working on):
${conversation || "(no conversation)"}

Rules:
- Match the naming convention of existing local branches exactly.
- Infer branch purpose from commits, changed files, and conversation history.
- Your final output MUST contain exactly this line: BRANCH_NAME=<name>
- Example: BRANCH_NAME=feature/COM-1234/add-login`;

			const result = await pi.exec("pi", ["-p", prompt], { timeout: 30000 });
			ctx.ui.setStatus("auto-branch", "");

			if (result.code !== 0) {
				ctx.ui.notify("분석 실패", "error");
				return;
			}

			const match = result.stdout.match(/BRANCH_NAME=(.+)/);
			const suggested = match?.[1]?.trim();
			if (!suggested || suggested === currentBranch) {
				ctx.ui.notify("브랜치 이름을 결정하지 못했습니다.", "warning");
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
