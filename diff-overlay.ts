/**
 * /diff — Git diff overlay
 *
 * Shows changed files in the current branch with a split-pane view:
 * - Left: file list with +/-/~ status indicators
 * - Right: unified diff for the selected file
 *
 * Navigation: ↑/↓ j/k to select files, q/Esc to close, s to stage, S to stage all
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import { DynamicBorder } from "@mariozechner/pi-coding-agent";
import { Key, matchesKey, truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";

// ─── Types ─────────────────────────────────────────────────────────────────

interface DiffFile {
	path: string;
	status: "added" | "deleted" | "modified" | "renamed" | "copied" | "untracked";
	/** Raw git status code (e.g. "M", "A", "D", "??") */
	rawStatus: string;
	staged: boolean;
}

interface DiffState {
	files: DiffFile[];
	selectedIndex: number;
	diffCache: Map<string, string>;
	diffScrollOffset: number;
	branch: string;
	baseBranch: string;
	error: string | null;
}

interface OverlayTheme {
	fg: (color: string, text: string) => string;
	bold: (text: string) => string;
}

interface OverlayTui {
	requestRender: () => void;
	height?: number;
}

// ─── Git helpers ───────────────────────────────────────────────────────────

async function getGitRoot(pi: ExtensionAPI, cwd: string): Promise<string | null> {
	const result = await pi.exec("git", ["rev-parse", "--show-toplevel"], { cwd });
	return result.code === 0 ? (result.stdout ?? "").trim() || null : null;
}

async function getCurrentBranch(pi: ExtensionAPI, cwd: string): Promise<string> {
	const result = await pi.exec("git", ["branch", "--show-current"], { cwd });
	return result.code === 0 ? (result.stdout ?? "").trim() || "HEAD" : "HEAD";
}

async function getBaseBranch(pi: ExtensionAPI, cwd: string): Promise<string> {
	// Try to find the merge-base with common default branches
	for (const candidate of ["main", "master", "develop"]) {
		const result = await pi.exec("git", ["rev-parse", "--verify", candidate], { cwd });
		if (result.code === 0) return candidate;
	}
	return "HEAD~1";
}

function parseStatus(code: string): DiffFile["status"] {
	const first = code.charAt(0);
	const second = code.charAt(1);
	// Prefer working tree status over staged status
	const effective = second !== " " && second !== "?" ? second : first;
	if (code === "??") return "untracked";
	if (effective === "A") return "added";
	if (effective === "D") return "deleted";
	if (effective === "R") return "renamed";
	if (effective === "C") return "copied";
	return "modified";
}

function isStaged(code: string): boolean {
	const index = code.charAt(0);
	return index !== " " && index !== "?" && index !== "!";
}

async function getChangedFiles(pi: ExtensionAPI, cwd: string): Promise<DiffFile[]> {
	const result = await pi.exec("git", ["status", "--porcelain=1", "-z"], { cwd });
	if (result.code !== 0 || !result.stdout) return [];

	const entries = result.stdout.split("\0").filter(Boolean);
	const files: DiffFile[] = [];
	const seen = new Set<string>();

	for (let i = 0; i < entries.length; i++) {
		const entry = entries[i];
		if (!entry || entry.length < 4) continue;

		const rawStatus = entry.slice(0, 2);
		let filePath = entry.slice(3);

		// Renames/copies have an extra field
		if ((rawStatus.startsWith("R") || rawStatus.startsWith("C")) && entries[i + 1]) {
			filePath = entries[i + 1];
			i += 1;
		}

		if (!filePath || seen.has(filePath)) continue;
		seen.add(filePath);

		files.push({
			path: filePath,
			status: parseStatus(rawStatus),
			rawStatus: rawStatus.trim() || rawStatus,
			staged: isStaged(rawStatus),
		});
	}

	// Sort: modified/added first, then alphabetical
	files.sort((a, b) => {
		const order: Record<string, number> = { modified: 0, added: 1, untracked: 2, renamed: 3, deleted: 4, copied: 5 };
		const diff = (order[a.status] ?? 9) - (order[b.status] ?? 9);
		if (diff !== 0) return diff;
		return a.path.localeCompare(b.path);
	});

	return files;
}

async function getFileDiff(pi: ExtensionAPI, cwd: string, file: DiffFile): Promise<string> {
	if (file.status === "untracked") {
		// Show file contents for untracked files
		const result = await pi.exec("cat", [file.path], { cwd });
		if (result.code !== 0) return "(cannot read file)";
		const content = result.stdout ?? "";
		return content
			.split("\n")
			.map((line) => `+ ${line}`)
			.join("\n");
	}

	// Try working tree diff first
	const result = await pi.exec("git", ["diff", "--no-color", "--", file.path], { cwd });
	if (result.code === 0 && (result.stdout ?? "").trim()) {
		return (result.stdout ?? "").trim();
	}

	// Fallback to staged diff
	const stagedResult = await pi.exec("git", ["diff", "--cached", "--no-color", "--", file.path], { cwd });
	if (stagedResult.code === 0 && (stagedResult.stdout ?? "").trim()) {
		return (stagedResult.stdout ?? "").trim();
	}

	// For newly added files
	if (file.status === "added") {
		const catResult = await pi.exec("cat", [file.path], { cwd });
		if (catResult.code === 0) {
			return (catResult.stdout ?? "")
				.split("\n")
				.map((line) => `+ ${line}`)
				.join("\n");
		}
	}

	return "(no diff available)";
}

// ─── Rendering ─────────────────────────────────────────────────────────────

function statusIcon(status: DiffFile["status"]): string {
	switch (status) {
		case "added":
		case "untracked":
			return "+";
		case "deleted":
			return "-";
		case "renamed":
			return "→";
		case "copied":
			return "©";
		default:
			return "~";
	}
}

function statusColor(status: DiffFile["status"]): string {
	switch (status) {
		case "added":
		case "untracked":
			return "success";
		case "deleted":
			return "error";
		default:
			return "warning";
	}
}

function renderFileList(
	theme: OverlayTheme,
	state: DiffState,
	width: number,
	height: number,
): string[] {
	const lines: string[] = [];

	if (state.files.length === 0) {
		lines.push(theme.fg("muted", " (no changes)"));
		return lines;
	}

	// Calculate visible window for scrolling file list
	const maxVisible = Math.max(1, height);
	let startIdx = 0;
	if (state.selectedIndex >= startIdx + maxVisible) {
		startIdx = state.selectedIndex - maxVisible + 1;
	}
	if (state.selectedIndex < startIdx) {
		startIdx = state.selectedIndex;
	}

	const endIdx = Math.min(state.files.length, startIdx + maxVisible);

	for (let i = startIdx; i < endIdx; i++) {
		const file = state.files[i];
		const selected = i === state.selectedIndex;
		const icon = statusIcon(file.status);
		const color = statusColor(file.status);
		const cursor = selected ? theme.fg("accent", "▶") : " ";
		const stagedMark = file.staged ? theme.fg("success", "●") : theme.fg("dim", "○");
		const fileName = file.path.includes("/")
			? file.path.slice(file.path.lastIndexOf("/") + 1)
			: file.path;
		const dirPart = file.path.includes("/")
			? file.path.slice(0, file.path.lastIndexOf("/") + 1)
			: "";

		const prefix = `${cursor} ${stagedMark} ${theme.fg(color, icon)} `;
		const prefixWidth = 7; // cursor(1) + space(1) + staged(1) + space(1) + icon(1) + space(1) + extra
		const nameWidth = Math.max(4, width - prefixWidth);

		let label: string;
		if (selected) {
			label = theme.fg("accent", truncateToWidth(file.path, nameWidth));
		} else {
			const dirStr = dirPart ? theme.fg("dim", truncateToWidth(dirPart, Math.floor(nameWidth * 0.6))) : "";
			const remainingWidth = Math.max(4, nameWidth - visibleWidth(dirPart));
			label = `${dirStr}${theme.fg("text", truncateToWidth(fileName, remainingWidth))}`;
		}

		lines.push(truncateToWidth(`${prefix}${label}`, width));
	}

	// Scroll indicator
	if (state.files.length > maxVisible) {
		const scrollInfo = theme.fg("dim", ` ${startIdx + 1}-${endIdx}/${state.files.length}`);
		if (lines.length > 0) {
			lines.push(scrollInfo);
		}
	}

	return lines;
}

function colorizeDiffLine(theme: OverlayTheme, line: string): string {
	if (line.startsWith("+++") || line.startsWith("---")) {
		return theme.fg("muted", line);
	}
	if (line.startsWith("+")) {
		return theme.fg("success", line);
	}
	if (line.startsWith("-")) {
		return theme.fg("error", line);
	}
	if (line.startsWith("@@")) {
		return theme.fg("accent", line);
	}
	if (line.startsWith("diff ") || line.startsWith("index ")) {
		return theme.fg("dim", line);
	}
	return line;
}

function renderDiffPanel(
	theme: OverlayTheme,
	state: DiffState,
	width: number,
	height: number,
): string[] {
	if (state.files.length === 0) {
		return [theme.fg("muted", " Working tree clean")];
	}

	const file = state.files[state.selectedIndex];
	if (!file) return [];

	const diffContent = state.diffCache.get(file.path);
	if (diffContent === undefined) {
		return [theme.fg("muted", " Loading diff...")];
	}

	const allLines = diffContent.split("\n");
	if (allLines.length === 0) {
		return [theme.fg("muted", " (empty diff)")];
	}

	const maxVisible = Math.max(1, height);
	const startLine = Math.min(state.diffScrollOffset, Math.max(0, allLines.length - maxVisible));
	const endLine = Math.min(allLines.length, startLine + maxVisible);

	const lines: string[] = [];
	for (let i = startLine; i < endLine; i++) {
		const raw = allLines[i];
		const colored = colorizeDiffLine(theme, raw);
		lines.push(truncateToWidth(` ${colored}`, width));
	}

	// Pad remaining height
	while (lines.length < maxVisible) {
		lines.push("");
	}

	return lines;
}

// ─── Overlay UI class ──────────────────────────────────────────────────────

class DiffOverlayUI {
	private state: DiffState;
	private pi: ExtensionAPI;
	private cwd: string;
	private onDone: () => void;
	private loadingDiff = false;

	constructor(
		pi: ExtensionAPI,
		cwd: string,
		state: DiffState,
		onDone: () => void,
	) {
		this.pi = pi;
		this.cwd = cwd;
		this.state = state;
		this.onDone = onDone;
	}

	async loadSelectedDiff(tui: OverlayTui): Promise<void> {
		const file = this.state.files[this.state.selectedIndex];
		if (!file || this.state.diffCache.has(file.path)) return;
		if (this.loadingDiff) return;

		this.loadingDiff = true;
		try {
			const diff = await getFileDiff(this.pi, this.cwd, file);
			this.state.diffCache.set(file.path, diff);
		} finally {
			this.loadingDiff = false;
		}
		tui.requestRender();
	}

	handleInput(data: string, tui: OverlayTui): void {
		const fileCount = this.state.files.length;
		const file = this.state.files[this.state.selectedIndex];
		const diffLines = file ? (this.state.diffCache.get(file.path) ?? "").split("\n").length : 0;

		if (matchesKey(data, Key.escape) || data === "q") {
			this.onDone();
			return;
		}

		if (matchesKey(data, Key.up) || data === "k") {
			if (this.state.selectedIndex > 0) {
				this.state.selectedIndex -= 1;
				this.state.diffScrollOffset = 0;
				void this.loadSelectedDiff(tui);
			}
		} else if (matchesKey(data, Key.down) || data === "j") {
			if (this.state.selectedIndex < fileCount - 1) {
				this.state.selectedIndex += 1;
				this.state.diffScrollOffset = 0;
				void this.loadSelectedDiff(tui);
			}
		} else if (data === "J" || matchesKey(data, Key.ctrl("d"))) {
			// Scroll diff down
			this.state.diffScrollOffset = Math.min(
				this.state.diffScrollOffset + 5,
				Math.max(0, diffLines - 5),
			);
		} else if (data === "K" || matchesKey(data, Key.ctrl("u"))) {
			// Scroll diff up
			this.state.diffScrollOffset = Math.max(0, this.state.diffScrollOffset - 5);
		} else if (matchesKey(data, Key.pageDown)) {
			this.state.diffScrollOffset = Math.min(
				this.state.diffScrollOffset + 20,
				Math.max(0, diffLines - 5),
			);
		} else if (matchesKey(data, Key.pageUp)) {
			this.state.diffScrollOffset = Math.max(0, this.state.diffScrollOffset - 20);
		} else if (data === "g") {
			this.state.selectedIndex = 0;
			this.state.diffScrollOffset = 0;
			void this.loadSelectedDiff(tui);
		} else if (data === "G") {
			this.state.selectedIndex = Math.max(0, fileCount - 1);
			this.state.diffScrollOffset = 0;
			void this.loadSelectedDiff(tui);
		} else if (data === "s") {
			// Stage/unstage file
			if (file) {
				const args = file.staged
					? ["reset", "HEAD", "--", file.path]
					: ["add", "--", file.path];
				void this.pi.exec("git", args, { cwd: this.cwd }).then(async () => {
					// Refresh file list
					const files = await getChangedFiles(this.pi, this.cwd);
					this.state.files = files;
					if (this.state.selectedIndex >= files.length) {
						this.state.selectedIndex = Math.max(0, files.length - 1);
					}
					// Invalidate diff cache for the file
					this.state.diffCache.delete(file.path);
					void this.loadSelectedDiff(tui);
					tui.requestRender();
				});
			}
		} else if (data === "S") {
			// Stage all
			void this.pi.exec("git", ["add", "-A"], { cwd: this.cwd }).then(async () => {
				const files = await getChangedFiles(this.pi, this.cwd);
				this.state.files = files;
				this.state.diffCache.clear();
				if (this.state.selectedIndex >= files.length) {
					this.state.selectedIndex = Math.max(0, files.length - 1);
				}
				void this.loadSelectedDiff(tui);
				tui.requestRender();
			});
		}

		tui.requestRender();
	}

	render(width: number, height: number, theme: OverlayTheme): string[] {
		const state = this.state;

		// ── Header ──
		const header: string[] = [];
		header.push(...new DynamicBorder((s: string) => theme.fg("accent", s)).render(width));

		const branchInfo = state.branch
			? theme.fg("muted", state.branch)
			: theme.fg("dim", "(detached)");
		const fileCount = theme.fg("muted", `${state.files.length} file${state.files.length !== 1 ? "s" : ""}`);
		const stagedCount = state.files.filter((f) => f.staged).length;
		const stagedInfo = stagedCount > 0
			? theme.fg("success", ` · ${stagedCount} staged`)
			: "";

		header.push(
			`  ${theme.fg("accent", theme.bold("DIFF"))} ${theme.fg("dim", "|")} ${branchInfo} ${theme.fg("dim", "·")} ${fileCount}${stagedInfo}`,
		);
		header.push("");

		// ── Footer ──
		const footer: string[] = [];
		footer.push("");
		footer.push(
			theme.fg("dim", "  ↑/↓ j/k Select  ·  J/K Ctrl+D/U Scroll diff  ·  s Stage  ·  S Stage all  ·  q Close"),
		);
		footer.push(...new DynamicBorder((s: string) => theme.fg("accent", s)).render(width));

		// ── Body layout ──
		const bodyHeight = Math.max(3, height - header.length - footer.length);
		const dividerWidth = 1;
		const leftWidth = Math.max(16, Math.min(Math.floor(width * 0.35), 50));
		const rightWidth = Math.max(10, width - leftWidth - dividerWidth - 2);

		// Render panels
		const leftLines = renderFileList(theme, state, leftWidth, bodyHeight);
		const rightLines = renderDiffPanel(theme, state, rightWidth, bodyHeight);

		// Pad to same height
		while (leftLines.length < bodyHeight) leftLines.push("");
		while (rightLines.length < bodyHeight) rightLines.push("");

		// Compose body with divider
		const divider = theme.fg("dim", "│");
		const body: string[] = [];
		for (let i = 0; i < bodyHeight; i++) {
			const left = truncateToWidth(leftLines[i] ?? "", leftWidth);
			const leftPad = Math.max(0, leftWidth - visibleWidth(left));
			const right = truncateToWidth(rightLines[i] ?? "", rightWidth);
			body.push(`${left}${" ".repeat(leftPad)} ${divider} ${right}`);
		}

		return [...header, ...body, ...footer];
	}
}

// ─── Extension registration ────────────────────────────────────────────────

export default function diffOverlay(pi: ExtensionAPI) {
	const handler = async (_args: string, ctx: ExtensionCommandContext) => {
		const gitRoot = await getGitRoot(pi, ctx.cwd);
		if (!gitRoot) {
			if (ctx.hasUI) {
				ctx.ui.notify("Git repository not found", "error");
			} else {
				console.log("Git repository not found");
			}
			return;
		}

		const [branch, files] = await Promise.all([
			getCurrentBranch(pi, gitRoot),
			getChangedFiles(pi, gitRoot),
		]);

		const baseBranch = await getBaseBranch(pi, gitRoot);

		const state: DiffState = {
			files,
			selectedIndex: 0,
			diffCache: new Map(),
			diffScrollOffset: 0,
			branch,
			baseBranch,
			error: null,
		};

		if (!ctx.hasUI) {
			// Plain text fallback
			if (files.length === 0) {
				console.log("Working tree clean — no changes.");
				return;
			}
			for (const file of files) {
				const icon = statusIcon(file.status);
				console.log(`${icon} ${file.path}`);
			}
			return;
		}

		// Pre-load first file's diff
		if (files.length > 0) {
			const diff = await getFileDiff(pi, gitRoot, files[0]);
			state.diffCache.set(files[0].path, diff);
		}

		await ctx.ui.custom<void>(
			(tui, theme, _kb, done) => {
				const overlayTui = tui as unknown as OverlayTui;
				const overlayTheme = theme as unknown as OverlayTheme;
				const component = new DiffOverlayUI(pi, gitRoot, state, () => done(undefined));

				return {
					render: (w) => component.render(w, overlayTui.height ?? 40, overlayTheme),
					handleInput: (data) => component.handleInput(data, overlayTui),
					invalidate: () => {},
				};
			},
			{
				overlay: true,
				overlayOptions: { width: "95%", maxHeight: "90%", anchor: "center" },
			},
		);
	};

	pi.registerCommand("diff", {
		description: "Git diff viewer — browse changed files with inline diff",
		handler,
	});
}
