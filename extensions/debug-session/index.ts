import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
	pi.registerCommand("debug-session", {
		description: "현재 세션을 임시 HTML로 내보내고 기본 브라우저로 엽니다.",
		handler: async (_args, ctx) => {
			try {
				await ctx.waitForIdle();
				const sessionFile = ctx.sessionManager.getSessionFile();
				if (!sessionFile) {
					ctx.ui.notify("저장된 세션이 없어 HTML로 내보낼 수 없습니다.", "warning");
					return;
				}

				const directory = await mkdtemp(join(tmpdir(), "pi-debug-session-"));
				const outputPath = join(directory, "session.html");
				const exported = await pi.exec("pi", ["--export", sessionFile, outputPath], {
					cwd: ctx.cwd,
					timeout: 30_000,
				});
				if (exported.code !== 0) {
					throw new Error(exported.stderr.trim() || exported.stdout.trim() || `export exit=${exported.code}`);
				}

				const opened = await pi.exec("open", [outputPath], { timeout: 10_000 });
				if (opened.code !== 0) {
					ctx.ui.notify(`HTML은 저장했지만 열지 못했습니다: ${outputPath}\n${opened.stderr.trim()}`, "error");
					return;
				}
				ctx.ui.notify(`세션 HTML을 열었습니다: ${outputPath}`, "info");
			} catch (error) {
				ctx.ui.notify(`세션 HTML 내보내기 실패: ${error instanceof Error ? error.message : String(error)}`, "error");
			}
		},
	});
}
