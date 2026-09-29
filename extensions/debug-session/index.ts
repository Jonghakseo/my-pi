import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
	pi.registerCommand("debug-session", {
		description: "현재 세션을 임시 파일로 내보내고 엽니다. 사용: /debug-session [html|json] (기본: html)",
		getArgumentCompletions: (prefix) => {
			const matches = ["html", "json"].filter((value) => value.startsWith(prefix.trim()));
			return matches.length ? matches.map((value) => ({ value, label: value })) : null;
		},
		handler: async (args, ctx) => {
			const format = args.trim() || "html";
			if (format !== "html" && format !== "json") {
				ctx.ui.notify("사용: /debug-session [html|json] (기본: html)", "warning");
				return;
			}
			const label = format.toUpperCase();
			try {
				await ctx.waitForIdle();
				const sessionFile = ctx.sessionManager.getSessionFile();
				if (!sessionFile) {
					ctx.ui.notify(`저장된 세션이 없어 ${label}으로 내보낼 수 없습니다.`, "warning");
					return;
				}

				const directory = await mkdtemp(join(tmpdir(), "pi-debug-session-"));
				const outputPath = join(directory, `session.${format}`);
				if (format === "json") {
					const data = {
						header: ctx.sessionManager.getHeader(),
						entries: ctx.sessionManager.getEntries(),
						leafId: ctx.sessionManager.getLeafId(),
					};
					await writeFile(outputPath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
				} else {
					const exported = await pi.exec("pi", ["--export", sessionFile, outputPath], {
						cwd: ctx.cwd,
						timeout: 30_000,
					});
					if (exported.code !== 0) {
						throw new Error(exported.stderr.trim() || exported.stdout.trim() || `export exit=${exported.code}`);
					}
				}

				const opened = await pi.exec("open", [outputPath], { timeout: 10_000 });
				if (opened.code !== 0) {
					ctx.ui.notify(`${label}은 저장했지만 열지 못했습니다: ${outputPath}\n${opened.stderr.trim()}`, "error");
					return;
				}
				ctx.ui.notify(`세션 ${label}을 열었습니다: ${outputPath}`, "info");
			} catch (error) {
				ctx.ui.notify(
					`세션 ${label} 내보내기 실패: ${error instanceof Error ? error.message : String(error)}`,
					"error",
				);
			}
		},
	});
}
