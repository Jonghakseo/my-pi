import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { wrapHTML } from "./generative-ui/html-utils.js";

const ARCHIVE_DIR = path.join(os.homedir(), "Documents", "agent-history", "분류 전");
const FONT_SIGNATURE = "Noto+Serif+KR";

export default function (pi: ExtensionAPI) {
	pi.on("tool_result", async (event, ctx) => {
		if (event.isError) return;

		// ── to-html skill: write tool → /tmp/*.html with font signature ──
		if (event.toolName === "write") {
			archiveToHtmlSkill(event, ctx);
			return;
		}

		// ── generative-ui: show_widget → wrap & save widget HTML ──
		if (event.toolName === "show_widget") {
			archiveWidget(event, ctx);
			return;
		}
	});
}

function archiveToHtmlSkill(event: any, ctx: any) {
	const filePath = typeof event.input?.path === "string" ? event.input.path : undefined;
	if (!filePath) return;

	const isTmp = filePath.startsWith("/tmp/") || filePath.startsWith("/private/tmp/");
	if (!isTmp || !filePath.endsWith(".html")) return;

	try {
		const resolved = fs.realpathSync(filePath);
		const content = fs.readFileSync(resolved, "utf-8");
		if (!content.includes(FONT_SIGNATURE)) return;

		fs.mkdirSync(ARCHIVE_DIR, { recursive: true });
		const dest = path.join(ARCHIVE_DIR, path.basename(filePath));
		fs.copyFileSync(resolved, dest);

		if (ctx.hasUI) {
			ctx.ui.notify(`📚 아카이브 복사됨 → 분류 전/${path.basename(filePath)}`, "info");
		}
	} catch {
		// file read/copy failed — silently skip
	}
}

function archiveWidget(event: any, ctx: any) {
	const code = event.input?.widget_code;
	const title = event.input?.title;
	if (typeof code !== "string" || !code) return;

	try {
		const isSVG = code.trimStart().startsWith("<svg");
		const html = wrapHTML(code, isSVG);

		const safeName = (typeof title === "string" ? title : "widget").replace(/[^a-zA-Z0-9_-]/g, "_");
		const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
		const filename = `${ts}_${safeName}.html`;

		fs.mkdirSync(ARCHIVE_DIR, { recursive: true });
		fs.writeFileSync(path.join(ARCHIVE_DIR, filename), html, "utf-8");

		if (ctx.hasUI) {
			ctx.ui.notify(`📚 위젯 아카이브 → 분류 전/${filename}`, "info");
		}
	} catch {
		// wrap/write failed — silently skip
	}
}
