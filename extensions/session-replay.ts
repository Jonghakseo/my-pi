import { DynamicBorder, type ExtensionAPI, type Theme, type ThemeColor, getMarkdownTheme as getPiMdTheme } from "@mariozechner/pi-coding-agent";
import { Box, Container, Key, Markdown, matchesKey, Spacer, Text } from "@mariozechner/pi-tui";
import { applyExtensionDefaults } from "./themeMap.ts";
import { formatDurationBetween } from "./utils/time-utils.ts";

// Minimal shim for timestamp handling if not directly in Message objects
function formatTime(date: Date): string {
	return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

type ReplayTui = { requestRender: () => void };
type ThemeBg = Parameters<Theme["bg"]>[0];
type ReplayTheme = { fg: (color: ThemeColor, text: string) => string; bg: (color: ThemeBg, text: string) => string; bold: (text: string) => string };

interface HistoryItem {
	type: "user" | "assistant" | "tool";
	title: string;
	content: string;
	timestamp: Date;
	elapsed?: string;
}

class SessionReplayUI {
	private selectedIndex = 0;
	private expandedIndex: number | null = null;
	private scrollOffset = 0;

	constructor(
		private items: HistoryItem[],
		private onDone: () => void,
	) {
		// Start selected at the bottom (most recent)
		this.selectedIndex = Math.max(0, items.length - 1);
		this.ensureVisible(20); // rough height estimate
	}

	handleInput(data: string, tui: ReplayTui): void {
		if (matchesKey(data, Key.up)) {
			this.selectedIndex = Math.max(0, this.selectedIndex - 1);
		} else if (matchesKey(data, Key.down)) {
			this.selectedIndex = Math.min(this.items.length - 1, this.selectedIndex + 1);
		} else if (matchesKey(data, Key.enter)) {
			this.expandedIndex = this.expandedIndex === this.selectedIndex ? null : this.selectedIndex;
		} else if (matchesKey(data, Key.escape)) {
			this.onDone();
			return;
		}
		tui.requestRender();
	}

	private ensureVisible(height: number) {
		// Simple scroll window logic
		const pageSize = Math.floor(height / 3); // Approx items per page
		if (this.selectedIndex < this.scrollOffset) {
			this.scrollOffset = this.selectedIndex;
		} else if (this.selectedIndex >= this.scrollOffset + pageSize) {
			this.scrollOffset = this.selectedIndex - pageSize + 1;
		}
	}

	render(width: number, height: number, theme: ReplayTheme): string[] {
		this.ensureVisible(height);

		const container = new Container();
		const mdTheme = getPiMdTheme();

		// Header
		container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
		container.addChild(
			new Text(
				`${theme.fg("accent", theme.bold(" SESSION REPLAY"))} ${theme.fg("dim", "|")} ${theme.fg("success", this.items.length.toString())} entries`,
				1,
				0,
			),
		);
		container.addChild(new Spacer(1));

		// Calculate visible range
		const visibleItems = this.items.slice(this.scrollOffset);

		visibleItems.forEach((item, idx) => {
			const absoluteIndex = idx + this.scrollOffset;
			const isSelected = absoluteIndex === this.selectedIndex;
			const isExpanded = absoluteIndex === this.expandedIndex;

			const cardBox = new Box(1, 0, (s) => (isSelected ? theme.bg("selectedBg", s) : s));

			// Icon and Title
			let icon = "○";
			let color: ThemeColor = "dim";
			if (item.type === "user") {
				icon = "👤";
				color = "success";
			} else if (item.type === "assistant") {
				icon = "🤖";
				color = "accent";
			} else if (item.type === "tool") {
				icon = "🛠️";
				color = "warning";
			}

			const timeStr = theme.fg("success", `[${formatTime(item.timestamp)}]`);
			const elapsedStr = item.elapsed ? theme.fg("dim", ` (+${item.elapsed})`) : "";

			const titleLine = `${theme.fg(color, icon)} ${theme.bold(item.title)} ${timeStr}${elapsedStr}`;
			cardBox.addChild(new Text(titleLine, 0, 0));

			if (isExpanded) {
				cardBox.addChild(new Spacer(1));
				cardBox.addChild(new Markdown(item.content, 2, 0, mdTheme));
			} else {
				// Truncated preview
				const preview = item.content.replace(/\n/g, " ").substring(0, width - 10);
				cardBox.addChild(new Text(theme.fg("dim", `  ${preview}...`), 0, 0));
			}

			container.addChild(cardBox);
			// Don't add too many spacers if we have many items
			if (visibleItems.length < 15) container.addChild(new Spacer(1));
		});

		// Footer
		container.addChild(new Spacer(1));
		container.addChild(new Text(theme.fg("dim", " ↑/↓ Navigate • Enter Expand • Esc Close"), 1, 0));
		container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));

		return container.render(width);
	}
}

type ContentBlock = {
	type: string;
	text?: string;
	name?: string;
	arguments?: unknown;
	[key: string]: unknown;
};

type MessageWithContent = {
	message: {
		content: string | ContentBlock[] | unknown;
		[key: string]: unknown;
	};
	[key: string]: unknown;
};

function isMessageWithContent(entry: unknown): entry is MessageWithContent {
	if (typeof entry !== "object" || entry === null) return false;
	const e = entry as Record<string, unknown>;
	return typeof e.message === "object" && e.message !== null;
}

function extractContent(entry: unknown): string {
	if (!isMessageWithContent(entry)) return "";
	const msg = entry.message;
	if (!msg || typeof msg !== "object") return "";
	const msgObj = msg as Record<string, unknown>;
	const content = msgObj.content;
	if (!content) return "";
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		return content
			.map((c): string => {
				if (typeof c !== "object" || c === null) return "";
				const block = c as Record<string, unknown>;
				if (block.type === "text") {
					const text = block.text;
					return typeof text === "string" ? text : "";
				}
				if (block.type === "toolCall") {
					const name = block.name;
					const args = block.arguments;
					const nameStr = typeof name === "string" ? name : "unknown";
					return `Tool: ${nameStr}(${JSON.stringify(args).slice(0, 200)})`;
				}
				return "";
			})
			.filter(Boolean)
			.join("\n");
	}
	return JSON.stringify(content).slice(0, 500);
}

export default function (pi: ExtensionAPI) {
	pi.registerCommand("replay", {
		description: "Show a scrollable timeline of the current session",
		handler: async (_args, ctx) => {
			const branch = ctx.sessionManager.getBranch();
			const items: HistoryItem[] = [];

			let prevTime: Date | null = null;

			for (const entry of branch) {
				if (entry.type !== "message") continue;
				const msg = entry.message;
				if (!msg) continue;

				const ts = msg.timestamp ? new Date(msg.timestamp) : new Date();
				const elapsed = prevTime ? formatDurationBetween(prevTime, ts) : undefined;
				prevTime = ts;

				const role = msg.role;
				const text = extractContent(entry);
				if (!text) continue;

				if (role === "user") {
					items.push({
						type: "user",
						title: "User Prompt",
						content: text,
						timestamp: ts,
						elapsed,
					});
				} else if (role === "assistant") {
					items.push({
						type: "assistant",
						title: "Assistant",
						content: text,
						timestamp: ts,
						elapsed,
					});
				} else if (role === "toolResult") {
					const toolName = typeof msg.toolName === "string" ? msg.toolName : "tool";
					items.push({
						type: "tool",
						title: `Tool: ${toolName}`,
						content: text,
						timestamp: ts,
						elapsed,
					});
				}
			}

			if (items.length === 0) {
				ctx.ui.notify("No session history found.", "warning");
				return;
			}

			await ctx.ui.custom(
				(tui, theme, _kb, done) => {
					const component = new SessionReplayUI(items, () => done(undefined));
					return {
						render: (w) => component.render(w, 30, theme),
						handleInput: (data) => component.handleInput(data, tui),
						invalidate: () => {},
					};
				},
				{
					overlay: true,
					overlayOptions: { width: "80%", anchor: "center" },
				},
			);
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		applyExtensionDefaults(import.meta.url, ctx);
	});
}
