/**
 * Status Overlay — /status command to show skills, tools, and extensions
 *
 * Displays a scrollable overlay UI with four sections:
 *   - Skills (from pi.getCommands() with source "skill")
 *   - Tools (from pi.getAllTools())
 *   - Extensions (from pi.getCommands() with source "extension")
 *   - Themes (from ctx.ui.getAllThemes())
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { DynamicBorder } from "@mariozechner/pi-coding-agent";
import { Container, Spacer, Text, matchesKey, Key, truncateToWidth } from "@mariozechner/pi-tui";

interface Section {
	title: string;
	icon: string;
	color: string;
	items: string[];
}

class StatusOverlayUI {
	private scrollOffset = 0;
	private totalLines: string[] = [];

	constructor(
		private sections: Section[],
		private onDone: () => void,
	) {}

	handleInput(data: string, tui: any): void {
		if (matchesKey(data, Key.up)) {
			this.scrollOffset = Math.max(0, this.scrollOffset - 1);
		} else if (matchesKey(data, Key.down)) {
			this.scrollOffset = Math.min(
				Math.max(0, this.totalLines.length - 5),
				this.scrollOffset + 1,
			);
		} else if (data === "k") {
			this.scrollOffset = Math.max(0, this.scrollOffset - 1);
		} else if (data === "j") {
			this.scrollOffset = Math.min(
				Math.max(0, this.totalLines.length - 5),
				this.scrollOffset + 1,
			);
		} else if (matchesKey(data, Key.pageUp)) {
			this.scrollOffset = Math.max(0, this.scrollOffset - 10);
		} else if (matchesKey(data, Key.pageDown)) {
			this.scrollOffset = Math.min(
				Math.max(0, this.totalLines.length - 5),
				this.scrollOffset + 10,
			);
		} else if (matchesKey(data, Key.escape) || data === "q") {
			this.onDone();
			return;
		}
		tui.requestRender();
	}

	render(width: number, height: number, theme: any): string[] {
		// Build all content lines first
		const contentLines: string[] = [];
		const innerWidth = width - 6;

		for (let i = 0; i < this.sections.length; i++) {
			const section = this.sections[i];

			// Section header
			const countBadge = theme.fg("success", `${section.items.length}`);
			const headerLine = `  ${section.icon}  ${theme.fg(section.color, theme.bold(section.title))}  ${countBadge}`;
			contentLines.push(headerLine);
			contentLines.push("");

			// Items
			if (section.items.length === 0) {
				contentLines.push(theme.fg("dim", "      (none)"));
			} else {
				for (const item of section.items) {
					const bullet = theme.fg("dim", "    ·");
					const line = `${bullet} ${theme.fg("muted", item)}`;
					contentLines.push(truncateToWidth(line, innerWidth));
				}
			}

			// Section separator
			if (i < this.sections.length - 1) {
				contentLines.push("");
				contentLines.push("  " + theme.fg("borderMuted", "─".repeat(Math.max(0, width - 6))));
				contentLines.push("");
			}
		}

		this.totalLines = contentLines;

		// Clamp scroll
		const maxScroll = Math.max(0, contentLines.length - (height - 6));
		if (this.scrollOffset > maxScroll) this.scrollOffset = maxScroll;

		// Header
		const header: string[] = [];
		header.push(...new DynamicBorder((s: string) => theme.fg("accent", s)).render(width));
		header.push(
			`${theme.fg("accent", theme.bold("  STATUS"))} ${theme.fg("dim", "|")} ${theme.fg("muted", "session overview")}`,
		);
		header.push("");

		// Scrollbar indicator
		const visibleHeight = height - 6; // header(3) + footer(3)
		const canScroll = contentLines.length > visibleHeight;
		const scrollPct = canScroll && maxScroll > 0
			? Math.round((this.scrollOffset / maxScroll) * 100)
			: 0;

		// Visible content slice
		const visible = contentLines.slice(this.scrollOffset, this.scrollOffset + visibleHeight);

		// Footer
		const footer: string[] = [];
		footer.push("");
		const scrollHint = canScroll
			? theme.fg("success", ` ${scrollPct}%`) + theme.fg("dim", ` (${this.scrollOffset + 1}–${Math.min(this.scrollOffset + visibleHeight, contentLines.length)}/${contentLines.length})`)
			: "";
		footer.push(theme.fg("dim", "  ↑/↓/j/k Scroll  •  PgUp/PgDn  •  Esc Close") + scrollHint);
		footer.push(...new DynamicBorder((s: string) => theme.fg("accent", s)).render(width));

		return [...header, ...visible, ...footer];
	}
}

export default function (pi: ExtensionAPI) {
	pi.registerCommand("status", {
		description: "Show skills, tools, and extensions in an overlay",
		handler: async (_args, ctx) => {
			if (!ctx.hasUI) return;

			// Gather skills
			const commands = pi.getCommands();
			const skillItems = commands
				.filter((c) => c.source === "skill")
				.map((c) => `/skill:${c.name}${c.description ? ` — ${c.description}` : ""}`);

			// Gather tools
			const allTools = pi.getAllTools();
			const activeTools = pi.getActiveTools();
			const activeSet = new Set(activeTools);
			const toolItems = allTools.map((t) => {
				const status = activeSet.has(t.name) ? "●" : "○";
				return `${status} ${t.name}${t.description ? ` — ${t.description}` : ""}`;
			});

			// Gather extensions (commands from extensions)
			const extItems = commands
				.filter((c) => c.source === "extension")
				.map((c) => `/${c.name}${c.description ? ` — ${c.description}` : ""}`);

			// Gather themes
			const themes = ctx.ui.getAllThemes();
			const currentTheme = ctx.ui.theme.name;
			const themeItems = themes.map((t) => {
				const active = t.name === currentTheme ? " ★" : "";
				return `${t.name}${active}`;
			});

			const sections: Section[] = [
				{ title: "Skills", icon: "📚", color: "success", items: skillItems },
				{ title: "Tools", icon: "🛠️", color: "warning", items: toolItems },
				{ title: "Extensions", icon: "🧩", color: "accent", items: extItems },
				{ title: "Themes", icon: "🎨", color: "muted", items: themeItems },
			];

			await ctx.ui.custom(
				(tui, theme, _kb, done) => {
					const component = new StatusOverlayUI(sections, () => done(undefined));
					return {
						render: (w) => component.render(w, tui.height ?? 40, theme),
						handleInput: (data) => component.handleInput(data, tui),
						invalidate: () => {},
					};
				},
				{
					overlay: true,
					overlayOptions: { width: "80%", maxHeight: "80%", anchor: "center" },
				},
			);
		},
	});
}
