import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type { AutocompleteItem } from "@mariozechner/pi-tui";
import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";

export default function (pi: ExtensionAPI) {
	pi.registerCommand("fork-panel", {
		description: "Fork current session and open in a new Ghostty split panel (args: right|left|down|up)",
		getArgumentCompletions: (prefix: string): AutocompleteItem[] | null => {
			const dirs = ["right", "left", "down", "up"];
			const filtered = dirs.filter((d) => d.startsWith(prefix)).map((d) => ({ value: d, label: d }));
			return filtered.length > 0 ? filtered : null;
		},
		handler: async (args, ctx) => {
			const sessionFile = ctx.sessionManager.getSessionFile();
			if (!sessionFile) {
				ctx.ui.notify("포크할 세션 파일이 없습니다 (ephemeral session)", "error");
				return;
			}

			const dir = path.dirname(sessionFile);
			const timestamp = Date.now();
			const uuid = randomUUID().slice(0, 8);
			const forkedFile = path.join(dir, `${timestamp}_${uuid}.jsonl`);
			fs.copyFileSync(sessionFile, forkedFile);

			const validDirs = ["right", "left", "down", "up"] as const;
			const arg = args?.trim().toLowerCase() ?? "";
			const direction = validDirs.includes(arg as (typeof validDirs)[number]) ? arg : "right";

			const cwd = ctx.cwd;
			const esc = (s: string) => s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');

			const script = `tell application "Ghostty"
  set currentTerm to focused terminal of selected tab of front window
  set newTerm to split currentTerm direction ${direction}
  input text "cd \\"${esc(cwd)}\\" && pi --session \\"${esc(forkedFile)}\\"" to newTerm
  send key "enter" to newTerm
end tell`;

			const result = await pi.exec("osascript", ["-e", script]);

			if (result.code !== 0) {
				ctx.ui.notify(`스플릿 패널 생성 실패: ${result.stderr}`, "error");
				try {
					fs.unlinkSync(forkedFile);
				} catch {}
				return;
			}

			ctx.ui.notify(`세션 포크 → ${direction} 패널`, "info");
		},
	});
}
