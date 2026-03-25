import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { StringEnum } from "@mariozechner/pi-ai";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import { AVAILABLE_MODULES, getGuidelines } from "./guidelines.js";
import { SVG_STYLES } from "./svg-styles.js";

// Shell HTML with a root container — used for streaming.
// Content is injected via win.send() JS eval, not setHTML(), to avoid full-page flashes.
function shellHTML(): string {
	return `<!DOCTYPE html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1.0">
<style>
*{box-sizing:border-box}
body{margin:0;padding:1rem;font-family:system-ui,-apple-system,sans-serif;background:#1a1a1a;color:#e0e0e0;}
@keyframes _fadeIn{from{opacity:0;transform:translateY(4px);}to{opacity:1;transform:none;}}
${SVG_STYLES}
</style>
</head><body><div id="root"></div>
<script>
  window._morphReady = false;
  window._pending = null;
  window._setContent = function(html) {
    if (!window._morphReady) { window._pending = html; return; }
    var root = document.getElementById('root');
    var target = document.createElement('div');
    target.id = 'root';
    target.innerHTML = html;
    morphdom(root, target, {
      onBeforeElUpdated: function(from, to) {
        if (from.isEqualNode(to)) return false;
        return true;
      },
      onNodeAdded: function(node) {
        if (node.nodeType === 1 && node.tagName !== 'STYLE' && node.tagName !== 'SCRIPT') {
          node.style.animation = '_fadeIn 0.3s ease both';
        }
        return node;
      }
    });
  };
  window._runScripts = function() {
    document.querySelectorAll('#root script').forEach(function(old) {
      var s = document.createElement('script');
      if (old.src) { s.src = old.src; } else { s.textContent = old.textContent; }
      old.parentNode.replaceChild(s, old);
    });
  };
</script>
<script src="https://cdn.jsdelivr.net/npm/morphdom@2.7.4/dist/morphdom-umd.min.js"
  onload="window._morphReady=true;if(window._pending){window._setContent(window._pending);window._pending=null;}"></script>
</body></html>`;
}

// Wrap HTML fragment into a full document for Glimpse (non-streaming fallback)
function wrapHTML(code: string, isSVG = false): string {
	if (isSVG) {
		return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>${SVG_STYLES}</style></head>
<body style="margin:0;display:flex;align-items:center;justify-content:center;min-height:100vh;background:#1a1a1a;color:#e0e0e0;">
${code}</body></html>`;
	}
	return `<!DOCTYPE html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1.0">
<style>*{box-sizing:border-box}body{margin:0;padding:1rem;font-family:system-ui,-apple-system,sans-serif;background:#1a1a1a;color:#e0e0e0}${SVG_STYLES}</style>
</head><body>${code}</body></html>`;
}

// Escape a string for safe injection into a JS string literal
function escapeJS(s: string): string {
	return s
		.replace(/\\/g, "\\\\")
		.replace(/'/g, "\\'")
		.replace(/\n/g, "\\n")
		.replace(/\r/g, "\\r")
		.replace(/<\/script>/gi, "<\\/script>");
}

export default function (pi: ExtensionAPI) {
	let hasSeenReadMe = false;
	let activeWindows: any[] = [];
	let glimpseModule: any = null;
	const require = createRequire(import.meta.url);
	const glimpsePath = pathToFileURL(require.resolve("glimpseui")).href;

	// Lazy-load glimpse module using package resolution
	async function getGlimpse() {
		if (!glimpseModule) {
			glimpseModule = await import(glimpsePath);
		}
		return glimpseModule;
	}

	// ── Streaming state ─────────────────────────────────────────────────────

	// Tracks in-flight show_widget tool calls being streamed
	interface StreamingWidget {
		contentIndex: number;
		window: any | null;
		lastHTML: string;
		updateTimer: any;
		ready: boolean;
		finalHTML: string | null;
		runScriptsOnReady: boolean;
	}

	let streaming: StreamingWidget | null = null;

	// ── message_update: intercept streaming tool calls ────────────────────

	pi.on("message_update", async (event) => {
		const raw: any = event.assistantMessageEvent;
		if (!raw) return;

		// Tool call starts streaming
		if (raw.type === "toolcall_start") {
			const partial: any = raw.partial;
			const block = partial?.content?.[raw.contentIndex];
			if (block?.type === "toolCall" && block?.name === "show_widget") {
				streaming = {
					contentIndex: raw.contentIndex,
					window: null,
					lastHTML: "",
					updateTimer: null,
					ready: false,
					finalHTML: null,
					runScriptsOnReady: false,
				};
			}
			return;
		}

		// Tool call input JSON delta — arguments already parsed by pi-ai
		if (raw.type === "toolcall_delta" && streaming && raw.contentIndex === streaming.contentIndex) {
			const partial: any = raw.partial;
			const block = partial?.content?.[raw.contentIndex];
			const html = block?.arguments?.widget_code;
			if (!html || html.length < 20 || html === streaming.lastHTML) return;

			streaming.lastHTML = html;

			// Debounce updates to ~150ms for smooth rendering
			if (streaming.updateTimer) return;
			const currentStreaming = streaming;
			streaming.updateTimer = setTimeout(async () => {
				currentStreaming.updateTimer = null;

				try {
					if (!currentStreaming.window) {
						// Open window with empty shell — content will be injected via JS eval
						const args = block?.arguments ?? {};
						const title = (args.title ?? "Widget").replace(/_/g, " ");
						const width = args.width ?? 800;
						const height = args.height ?? 600;

						const { open } = await getGlimpse();
						currentStreaming.window = open(shellHTML(), { width, height, title });
						activeWindows.push(currentStreaming.window);

						currentStreaming.window.on("ready", () => {
							currentStreaming.ready = true;
							const html = currentStreaming.finalHTML ?? currentStreaming.lastHTML;
							if (!html) return;

							const escaped = escapeJS(html);
							let command = `window._setContent('${escaped}')`;
							if (currentStreaming.runScriptsOnReady) {
								command += "; window._runScripts();";
								currentStreaming.runScriptsOnReady = false;
							}
							currentStreaming.window?.send(command);
						});
					} else if (currentStreaming.ready) {
						// Update content via JS — no full page replace
						const escaped = escapeJS(currentStreaming.lastHTML);
						currentStreaming.window.send(`window._setContent('${escaped}')`);
					}
				} catch {}
			}, 150);
			return;
		}

		// Tool call complete — final update with complete HTML + execute scripts
		if (raw.type === "toolcall_end" && streaming && raw.contentIndex === streaming.contentIndex) {
			if (streaming.updateTimer) {
				clearTimeout(streaming.updateTimer);
				streaming.updateTimer = null;
			}

			const toolCall = raw.toolCall;
			if (toolCall?.arguments?.widget_code) {
				streaming.finalHTML = toolCall.arguments.widget_code;
				if (streaming.window && streaming.ready) {
					const escaped = escapeJS(toolCall.arguments.widget_code);
					streaming.window.send(`window._setContent('${escaped}'); window._runScripts();`);
				} else {
					streaming.runScriptsOnReady = true;
				}
			}
			// Don't clear streaming — execute() will pick up the window
			return;
		}
	});

	// ── read_me tool ──────────────────────────────────────────────────────────

	pi.registerTool({
		name: "visualize_read_me",
		label: "Read Guidelines",
		description:
			"Returns design guidelines for show_widget (CSS patterns, colors, typography, layout rules, examples). " +
			"Call once before your first show_widget call. Do NOT mention this call to the user — it is an internal setup step.",
		promptSnippet: "Load design guidelines before creating widgets. Call silently before first show_widget use.",
		promptGuidelines: [
			"Call visualize_read_me once before your first show_widget call to load design guidelines.",
			"Do NOT mention the read_me call to the user — call it silently, then proceed directly to building the widget.",
			"Pick the modules that match your use case: interactive, chart, mockup, art, diagram.",
		],
		parameters: Type.Object({
			modules: Type.Array(StringEnum(AVAILABLE_MODULES as readonly string[]), {
				description: "Which module(s) to load. Pick all that fit.",
			}),
		}),

		async execute(_toolCallId, params) {
			hasSeenReadMe = true;
			const content = getGuidelines(params.modules);
			return {
				content: [{ type: "text" as const, text: content }],
				details: { modules: params.modules },
			};
		},

		renderCall(args: any, theme: any) {
			const mods = (args.modules ?? []).join(", ");
			return new Text(theme.fg("toolTitle", theme.bold("read_me ")) + theme.fg("muted", mods), 0, 0);
		},

		renderResult(_result: any, { isPartial }: any, theme: any) {
			if (isPartial) return new Text(theme.fg("warning", "Loading guidelines..."), 0, 0);
			return new Text(theme.fg("dim", "Guidelines loaded"), 0, 0);
		},
	});

	// ── show_widget tool ──────────────────────────────────────────────────────

	pi.registerTool({
		name: "show_widget",
		label: "Show Widget",
		description:
			"Show visual content — SVG graphics, diagrams, charts, or interactive HTML widgets — in a native macOS window. " +
			"Use for flowcharts, dashboards, forms, calculators, data tables, games, illustrations, or any visual content. " +
			"The HTML is rendered in a native WKWebView with full CSS/JS support including Canvas and CDN libraries. " +
			"IMPORTANT: Call visualize_read_me once before your first show_widget call.",
		promptSnippet:
			"Render interactive HTML/SVG widgets in a native macOS window (WKWebView). Supports full CSS, JS, Canvas, Chart.js.",
		promptGuidelines: [
			"Use show_widget when the user asks for visual content: charts, diagrams, interactive explainers, UI mockups, art.",
			"Always call visualize_read_me first to load design guidelines, then set i_have_seen_read_me: true.",
			"The widget opens in a native macOS window — it has full browser capabilities (Canvas, JS, CDN libraries).",
			"Structure HTML as fragments: no DOCTYPE/<html>/<head>/<body>. Style first, then HTML, then scripts.",
			"Keep widgets focused and appropriately sized. Default is 800x600 but adjust to fit content.",
			"For interactive explainers: sliders, live calculations, Chart.js charts.",
			"For SVG: start code with <svg> tag, it will be auto-detected.",
			"Be concise in your responses",
		],
		parameters: Type.Object({
			i_have_seen_read_me: Type.Boolean({
				description: "Confirm you have already called visualize_read_me in this conversation.",
			}),
			title: Type.String({
				description: "Short snake_case identifier for this widget (used as window title).",
			}),
			widget_code: Type.String({
				description:
					"HTML or SVG code to render. For SVG: raw SVG starting with <svg>. " +
					"For HTML: raw content fragment, no DOCTYPE/<html>/<head>/<body>.",
			}),
			width: Type.Optional(Type.Number({ description: "Window width in pixels. Default: 800." })),
			height: Type.Optional(Type.Number({ description: "Window height in pixels. Default: 600." })),
			floating: Type.Optional(Type.Boolean({ description: "Keep window always on top. Default: false." })),
		}),

		async execute(_toolCallId, params, signal) {
			if (!params.i_have_seen_read_me) {
				throw new Error(
					"You must call visualize_read_me before show_widget. Set i_have_seen_read_me: true after doing so.",
				);
			}

			const code = params.widget_code;
			const isSVG = code.trimStart().startsWith("<svg");
			const title = params.title.replace(/_/g, " ");
			const width = params.width ?? 800;
			const height = params.height ?? 600;

			// Check if we already have a streaming window from message_update
			let win: any = null;

			if (streaming?.window) {
				const currentStreaming = streaming;
				win = currentStreaming.window;
				currentStreaming.finalHTML = code;
				// Send final complete HTML + run scripts via JS eval (no full page replace)
				if (currentStreaming.ready) {
					const escaped = escapeJS(code);
					win.send(`window._setContent('${escaped}'); window._runScripts();`);
				} else {
					currentStreaming.runScriptsOnReady = true;
				}
				streaming = null;
			} else {
				// No streaming window — open fresh (fallback for non-streaming providers)
				const { open } = await getGlimpse();
				win = open(wrapHTML(code, isSVG), {
					width,
					height,
					title,
					floating: params.floating ?? false,
				});
				activeWindows.push(win);
			}

			// Clean up activeWindows when the window is closed
			win.on("closed", () => {
				activeWindows = activeWindows.filter((w) => w !== win);
			});

			if (signal) {
				signal.addEventListener(
					"abort",
					() => {
						try {
							win.close();
						} catch {}
					},
					{ once: true },
				);
			}

			return {
				content: [
					{
						type: "text" as const,
						text: `Widget "${title}" rendered and shown to the user (${width}×${height}).`,
					},
				],
				details: {
					title: params.title,
					width,
					height,
					isSVG,
				},
			};
		},

		renderCall(args: any, theme: any) {
			const title = (args.title ?? "widget").replace(/_/g, " ");
			const size = args.width && args.height ? ` ${args.width}×${args.height}` : "";
			let text = theme.fg("toolTitle", theme.bold("show_widget "));
			text += theme.fg("accent", title);
			if (size) text += theme.fg("dim", size);
			return new Text(text, 0, 0);
		},

		renderResult(result: any, { isPartial }: any, theme: any) {
			if (isPartial) {
				return new Text(theme.fg("warning", "⟳ Widget rendering..."), 0, 0);
			}

			const details = result.details ?? {};
			const title = (details.title ?? "widget").replace(/_/g, " ");
			let text = theme.fg("success", "✓ ") + theme.fg("accent", title);
			text += theme.fg("dim", ` ${details.width ?? 800}×${details.height ?? 600}`);
			if (details.isSVG) text += theme.fg("dim", " (SVG)");

			return new Text(text, 0, 0);
		},
	});

	// ── cleanup on shutdown ───────────────────────────────────────────────────

	pi.on("session_shutdown", async () => {
		if (streaming?.updateTimer) clearTimeout(streaming.updateTimer);
		streaming = null;
		for (const win of activeWindows) {
			try {
				win.close();
			} catch {}
		}
		activeWindows = [];
	});
}
