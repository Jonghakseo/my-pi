import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

const ARCHIVE_DIR = "/Users/creatrip/Documents/agent-history/분류 전";
const FONT_SIGNATURE = "Noto+Serif+KR";

export default function (pi: ExtensionAPI) {
	pi.on("tool_result", async (event, ctx) => {
		if (event.toolName !== "write" || event.isError) return;

		const filePath: string | undefined = (event as any).input?.path;
		if (!filePath) return;

		// /tmp or /private/tmp (macOS symlink)
		const isTmp = filePath.startsWith("/tmp/") || filePath.startsWith("/private/tmp/");
		if (!isTmp || !filePath.endsWith(".html")) return;

		// Check for to-html skill font signature
		try {
			const resolved = fs.realpathSync(filePath);
			const content = fs.readFileSync(resolved, "utf-8");
			if (!content.includes(FONT_SIGNATURE)) return;

			fs.mkdirSync(ARCHIVE_DIR, { recursive: true });
			const dest = path.join(ARCHIVE_DIR, path.basename(filePath));
			fs.copyFileSync(resolved, dest);

			ctx.ui.notify(`📚 아카이브 복사됨 → 분류 전/${path.basename(filePath)}`, "info");
		} catch {
			// file read/copy failed — silently skip
		}
	});
}
