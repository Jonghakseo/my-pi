import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext, ToolResultEvent } from "@mariozechner/pi-coding-agent";

const ARCHIVE_DIR = path.join(os.homedir(), "Documents", "agent-history", "분류 전");
const FONT_SIGNATURE = "Noto+Serif+KR";

const SVG_STYLES = `
:root {
  --p: #e0e0e0;
  --s: #a0a0a0;
  --t: #707070;
  --bg2: #2a2a2a;
  --b: #404040;
  --color-text-primary: #e0e0e0;
  --color-text-secondary: #a0a0a0;
  --color-text-tertiary: #707070;
  --color-text-info: #85B7EB;
  --color-text-danger: #F09595;
  --color-text-success: #97C459;
  --color-text-warning: #EF9F27;
  --color-background-primary: #1a1a1a;
  --color-background-secondary: #2a2a2a;
  --color-background-tertiary: #111111;
  --color-background-info: #0C447C;
  --color-background-danger: #791F1F;
  --color-background-success: #27500A;
  --color-background-warning: #633806;
  --color-border-primary: rgba(255,255,255,0.4);
  --color-border-secondary: rgba(255,255,255,0.3);
  --color-border-tertiary: rgba(255,255,255,0.15);
  --color-border-info: #85B7EB;
  --color-border-danger: #F09595;
  --color-border-success: #97C459;
  --color-border-warning: #EF9F27;
  --font-sans: system-ui, -apple-system, sans-serif;
  --font-serif: Georgia, serif;
  --font-mono: ui-monospace, monospace;
  --border-radius-md: 8px;
  --border-radius-lg: 12px;
  --border-radius-xl: 16px;
}
svg .t  { font-family: var(--font-sans); font-size: 14px; fill: var(--p); }
svg .ts { font-family: var(--font-sans); font-size: 12px; fill: var(--s); }
svg .th { font-family: var(--font-sans); font-size: 14px; font-weight: 500; fill: var(--p); }
svg .box { fill: var(--bg2); stroke: var(--b); }
svg .node { cursor: pointer; }
svg .node:hover { opacity: 0.8; }
svg .arr { stroke: var(--t); stroke-width: 1.5; fill: none; }
svg .leader { stroke: var(--t); stroke-width: 0.5; stroke-dasharray: 4 3; fill: none; }
svg .c-purple > rect, svg .c-purple > circle, svg .c-purple > ellipse { fill: #3C3489; stroke: #AFA9EC; }
svg .c-purple > .th, svg .c-purple > .t { fill: #CECBF6; }
svg .c-purple > .ts { fill: #AFA9EC; }
svg rect.c-purple, svg circle.c-purple, svg ellipse.c-purple { fill: #3C3489; stroke: #AFA9EC; }
svg .c-teal > rect, svg .c-teal > circle, svg .c-teal > ellipse { fill: #085041; stroke: #5DCAA5; }
svg .c-teal > .th, svg .c-teal > .t { fill: #9FE1CB; }
svg .c-teal > .ts { fill: #5DCAA5; }
svg rect.c-teal, svg circle.c-teal, svg ellipse.c-teal { fill: #085041; stroke: #5DCAA5; }
svg .c-coral > rect, svg .c-coral > circle, svg .c-coral > ellipse { fill: #712B13; stroke: #F0997B; }
svg .c-coral > .th, svg .c-coral > .t { fill: #F5C4B3; }
svg .c-coral > .ts { fill: #F0997B; }
svg rect.c-coral, svg circle.c-coral, svg ellipse.c-coral { fill: #712B13; stroke: #F0997B; }
svg .c-pink > rect, svg .c-pink > circle, svg .c-pink > ellipse { fill: #72243E; stroke: #ED93B1; }
svg .c-pink > .th, svg .c-pink > .t { fill: #F4C0D1; }
svg .c-pink > .ts { fill: #ED93B1; }
svg rect.c-pink, svg circle.c-pink, svg ellipse.c-pink { fill: #72243E; stroke: #ED93B1; }
svg .c-gray > rect, svg .c-gray > circle, svg .c-gray > ellipse { fill: #444441; stroke: #B4B2A9; }
svg .c-gray > .th, svg .c-gray > .t { fill: #D3D1C7; }
svg .c-gray > .ts { fill: #B4B2A9; }
svg rect.c-gray, svg circle.c-gray, svg ellipse.c-gray { fill: #444441; stroke: #B4B2A9; }
svg .c-blue > rect, svg .c-blue > circle, svg .c-blue > ellipse { fill: #0C447C; stroke: #85B7EB; }
svg .c-blue > .th, svg .c-blue > .t { fill: #B5D4F4; }
svg .c-blue > .ts { fill: #85B7EB; }
svg rect.c-blue, svg circle.c-blue, svg ellipse.c-blue { fill: #0C447C; stroke: #85B7EB; }
svg .c-green > rect, svg .c-green > circle, svg .c-green > ellipse { fill: #27500A; stroke: #97C459; }
svg .c-green > .th, svg .c-green > .t { fill: #C0DD97; }
svg .c-green > .ts { fill: #97C459; }
svg rect.c-green, svg circle.c-green, svg ellipse.c-green { fill: #27500A; stroke: #97C459; }
svg .c-amber > rect, svg .c-amber > circle, svg .c-amber > ellipse { fill: #633806; stroke: #EF9F27; }
svg .c-amber > .th, svg .c-amber > .t { fill: #FAC775; }
svg .c-amber > .ts { fill: #EF9F27; }
svg rect.c-amber, svg circle.c-amber, svg ellipse.c-amber { fill: #633806; stroke: #EF9F27; }
svg .c-red > rect, svg .c-red > circle, svg .c-red > ellipse { fill: #791F1F; stroke: #F09595; }
svg .c-red > .th, svg .c-red > .t { fill: #F7C1C1; }
svg .c-red > .ts { fill: #F09595; }
svg rect.c-red, svg circle.c-red, svg ellipse.c-red { fill: #791F1F; stroke: #F09595; }
button {
  background: transparent;
  border: 0.5px solid var(--color-border-secondary);
  border-radius: var(--border-radius-md);
  color: var(--color-text-primary);
  padding: 6px 14px;
  font-size: 14px;
  cursor: pointer;
  font-family: var(--font-sans);
}
button:hover { background: var(--color-background-secondary); }
button:active { transform: scale(0.98); }
input[type="range"] {
  -webkit-appearance: none;
  height: 4px;
  background: var(--color-border-secondary);
  border-radius: 2px;
  outline: none;
}
input[type="range"]::-webkit-slider-thumb {
  -webkit-appearance: none;
  width: 18px;
  height: 18px;
  border-radius: 50%;
  background: var(--color-text-primary);
  cursor: pointer;
}
input[type="text"], input[type="number"], textarea, select {
  height: 36px;
  background: var(--color-background-primary);
  border: 0.5px solid var(--color-border-tertiary);
  border-radius: var(--border-radius-md);
  color: var(--color-text-primary);
  padding: 0 10px;
  font-size: 14px;
  font-family: var(--font-sans);
  outline: none;
}
input[type="text"]:hover, input[type="number"]:hover, textarea:hover, select:hover {
  border-color: var(--color-border-secondary);
}
input[type="text"]:focus, input[type="number"]:focus, textarea:focus, select:focus {
  border-color: var(--color-border-primary);
  box-shadow: 0 0 0 2px rgba(255,255,255,0.1);
}
`;

function wrapArchivedWidgetHTML(code: string, isSVG = false): string {
	if (isSVG) {
		return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>*{-webkit-user-select:text;user-select:text}body{cursor:text}${SVG_STYLES}</style></head><body style="margin:0;display:flex;align-items:center;justify-content:center;min-height:100vh;background:#1a1a1a;color:#e0e0e0;">${code}</body></html>`;
	}

	return `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"><style>*{box-sizing:border-box;-webkit-user-select:text;user-select:text}body{margin:0;padding:1rem;font-family:system-ui,-apple-system,sans-serif;background:#1a1a1a;color:#e0e0e0;cursor:text}${SVG_STYLES}</style></head><body>${code}</body></html>`;
}

export default function (pi: ExtensionAPI) {
	pi.on("tool_result", async (event, ctx) => {
		if (event.isError) return;

		// ── to-html skill: write tool → /tmp/*.html with font signature ──
		if (event.toolName === "write") {
			archiveToHtmlSkill(event, ctx);
			return;
		}

		// ── generative-ui package: show_widget → wrap & save widget HTML ──
		if (event.toolName === "show_widget") {
			archiveWidget(event, ctx);
			return;
		}
	});
}

function archiveToHtmlSkill(event: ToolResultEvent, ctx: ExtensionContext) {
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

function archiveWidget(event: ToolResultEvent, ctx: ExtensionContext) {
	const code = event.input?.widget_code;
	const title = event.input?.title;
	if (typeof code !== "string" || !code) return;

	try {
		const isSVG = code.trimStart().startsWith("<svg");
		const html = wrapArchivedWidgetHTML(code, isSVG);

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
