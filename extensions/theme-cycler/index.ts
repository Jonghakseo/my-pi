/**
 * Theme Cycler — Keyboard shortcuts to cycle through available themes
 *
 * Shortcuts:
 *   Ctrl+Shift+X    — Cycle theme forward
 *   Ctrl+Q          — Cycle theme backward
 *
 * Commands:
 *   /theme          — Open select picker to choose a theme
 *   /theme <name>   — Switch directly by name
 *
 * Features:
 *   - Color swatch widget flashes briefly after each switch
 *   - Auto-dismisses swatch after 3 seconds
 *
 * Usage: pi -e extensions/theme-cycler/index.ts
 */

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { truncateToWidth } from "@mariozechner/pi-tui";

export default function (pi: ExtensionAPI) {
	let swatchTimer: ReturnType<typeof setTimeout> | null = null;

	function showSwatch(ctx: ExtensionContext) {
		if (!ctx.hasUI) return;

		if (swatchTimer) {
			clearTimeout(swatchTimer);
			swatchTimer = null;
		}

		ctx.ui.setWidget(
			"theme-swatch",
			(_tui, theme) => ({
				invalidate() {},
				render(width: number): string[] {
					const block = "\u2588\u2588\u2588";
					const swatch =
						theme.fg("success", block) +
						" " +
						theme.fg("accent", block) +
						" " +
						theme.fg("warning", block) +
						" " +
						theme.fg("dim", block) +
						" " +
						theme.fg("muted", block);
					const label = `${theme.fg("accent", " 🎨 ") + theme.fg("muted", ctx.ui.theme.name ?? "")}  ${swatch}`;
					const border = theme.fg("borderMuted", "─".repeat(Math.max(0, width)));
					return [border, truncateToWidth(`  ${label}`, width), border];
				},
			}),
			{ placement: "belowEditor" },
		);

		swatchTimer = setTimeout(() => {
			ctx.ui.setWidget("theme-swatch", undefined);
			swatchTimer = null;
		}, 3000);
	}

	function getThemeList(ctx: ExtensionContext) {
		return ctx.ui.getAllThemes();
	}

	function findCurrentIndex(ctx: ExtensionContext): number {
		const themes = getThemeList(ctx);
		const current = ctx.ui.theme.name;
		return themes.findIndex((t) => t.name === current);
	}

	function cycleTheme(ctx: ExtensionContext, direction: 1 | -1) {
		if (!ctx.hasUI) return;

		const themes = getThemeList(ctx);
		if (themes.length === 0) {
			ctx.ui.notify("No themes available", "warning");
			return;
		}

		let index = findCurrentIndex(ctx);
		if (index === -1) index = 0;

		index = (index + direction + themes.length) % themes.length;
		const theme = themes[index];
		const result = ctx.ui.setTheme(theme.name);

		if (result.success) {
			showSwatch(ctx);
			ctx.ui.notify(`${theme.name} (${index + 1}/${themes.length})`, "info");
		} else {
			ctx.ui.notify(`Failed to set theme: ${result.error}`, "error");
		}
	}

	// --- Shortcuts ---

	pi.registerShortcut("ctrl+shift+x", {
		description: "Cycle theme forward",
		handler: async (ctx) => {
			cycleTheme(ctx, 1);
		},
	});

	pi.registerShortcut("ctrl+q", {
		description: "Cycle theme backward",
		handler: async (ctx) => {
			cycleTheme(ctx, -1);
		},
	});

	// --- Command: /theme ---

	pi.registerCommand("theme", {
		description: "Select a theme: /theme or /theme <name>",
		handler: async (args, ctx) => {
			if (!ctx.hasUI) return;

			const themes = getThemeList(ctx);
			const arg = args.trim();

			if (arg) {
				const result = ctx.ui.setTheme(arg);
				if (result.success) {
					showSwatch(ctx);
					ctx.ui.notify(`Theme: ${arg}`, "info");
				} else {
					ctx.ui.notify(`Theme not found: ${arg}. Use /theme to see available themes.`, "error");
				}
				return;
			}

			const items = themes.map((t) => {
				const desc = t.path ? t.path : "built-in";
				const active = t.name === ctx.ui.theme.name ? " (active)" : "";
				return `${t.name}${active} — ${desc}`;
			});

			const selected = await ctx.ui.select("Select Theme", items);
			if (!selected) return;

			const selectedName = selected.split(/\s/)[0];
			const result = ctx.ui.setTheme(selectedName);
			if (result.success) {
				showSwatch(ctx);
				ctx.ui.notify(`Theme: ${selectedName}`, "info");
			}
		},
	});

	// --- Session init ---

	pi.on("session_start", async (_event, _ctx) => {});

	pi.on("session_shutdown", async () => {
		if (swatchTimer) {
			clearTimeout(swatchTimer);
			swatchTimer = null;
		}
	});
}
