/**
 * /diff — Git diff overlay
 *
 * Split-pane view: file list (left) + diff viewer (right).
 * Two focus modes — arrow keys work naturally in whichever panel is active.
 *
 *   FILE LIST mode  │  ↑/↓ select file · Enter → open diff · s stage · q close
 *   DIFF VIEW mode  │  ↑/↓ scroll diff · PgUp/PgDn fast scroll · Esc → back to files
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import { DynamicBorder } from "@mariozechner/pi-coding-agent";
import { Key, matchesKey, truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";

// ─── Types ─────────────────────────────────────────────────────────────────

interface DiffFile {
	path: string;
	status: "added" | "deleted" | "modified" | "renamed" | "copied" | "untracked";
	rawStatus: string;
	staged: boolean;
}

type FocusPane = "files" | "diff";

interface DiffState {
	files: DiffFile[];
	selectedIndex: number;
	fileScrollOffset: number;
	diffCache: Map<string, string>;
	diffScrollOffset: number;
	branch: string;
	focus: FocusPane;
	error: string | null;
}

interface Theme {
	fg: (color: string, text: string) => string;
	bold: (text: string) => string;
}

interface Tui {
	requestRender: () => void;
	height?: number;
}

// ─── Git helpers ───────────────────────────────────────────────────────────

async function gitRoot(pi: ExtensionAPI, cwd: string): Promise<string | null> {
	const r = await pi.exec("git", ["rev-parse", "--show-toplevel"], { cwd });
	return r.code === 0 ? (r.stdout ?? "").trim() || null : null;
}

async function currentBranch(pi: ExtensionAPI, cwd: string): Promise<string> {
	const r = await pi.exec("git", ["branch", "--show-current"], { cwd });
	return r.code === 0 ? (r.stdout ?? "").trim() || "HEAD" : "HEAD";
}

function parseStatus(code: string): DiffFile["status"] {
	const second = code.charAt(1);
	const effective = second !== " " && second !== "?" ? second : code.charAt(0);
	if (code === "??") return "untracked";
	if (effective === "A") return "added";
	if (effective === "D") return "deleted";
	if (effective === "R") return "renamed";
	if (effective === "C") return "copied";
	return "modified";
}

function isStaged(code: string): boolean {
	const c = code.charAt(0);
	return c !== " " && c !== "?" && c !== "!";
}

async function changedFiles(pi: ExtensionAPI, cwd: string): Promise<DiffFile[]> {
	const r = await pi.exec("git", ["status", "--porcelain=1", "-z"], { cwd });
	if (r.code !== 0 || !r.stdout) return [];

	const parts = r.stdout.split("\0").filter(Boolean);
	const files: DiffFile[] = [];
	const seen = new Set<string>();

	for (let i = 0; i < parts.length; i++) {
		const entry = parts[i];
		if (!entry || entry.length < 4) continue;
		const raw = entry.slice(0, 2);
		let fp = entry.slice(3);
		if ((raw.startsWith("R") || raw.startsWith("C")) && parts[i + 1]) {
			fp = parts[i + 1];
			i += 1;
		}
		if (!fp || seen.has(fp)) continue;
		seen.add(fp);
		files.push({ path: fp, status: parseStatus(raw), rawStatus: raw.trim() || raw, staged: isStaged(raw) });
	}

	const order: Record<string, number> = { modified: 0, added: 1, untracked: 2, renamed: 3, deleted: 4, copied: 5 };
	files.sort((a, b) => (order[a.status] ?? 9) - (order[b.status] ?? 9) || a.path.localeCompare(b.path));
	return files;
}

async function fileDiff(pi: ExtensionAPI, cwd: string, file: DiffFile): Promise<string> {
	if (file.status === "untracked") {
		const r = await pi.exec("cat", [file.path], { cwd });
		if (r.code !== 0) return "(cannot read file)";
		return (r.stdout ?? "").split("\n").map((l) => `+ ${l}`).join("\n");
	}

	const working = await pi.exec("git", ["diff", "--no-color", "--", file.path], { cwd });
	if (working.code === 0 && (working.stdout ?? "").trim()) return (working.stdout ?? "").trim();

	const staged = await pi.exec("git", ["diff", "--cached", "--no-color", "--", file.path], { cwd });
	if (staged.code === 0 && (staged.stdout ?? "").trim()) return (staged.stdout ?? "").trim();

	if (file.status === "added") {
		const cat = await pi.exec("cat", [file.path], { cwd });
		if (cat.code === 0) return (cat.stdout ?? "").split("\n").map((l) => `+ ${l}`).join("\n");
	}

	return "(no diff available)";
}

// ─── Rendering helpers ─────────────────────────────────────────────────────

function icon(s: DiffFile["status"]): string {
	if (s === "added" || s === "untracked") return "+";
	if (s === "deleted") return "-";
	if (s === "renamed") return "→";
	if (s === "copied") return "©";
	return "~";
}

function statusColor(s: DiffFile["status"]): string {
	if (s === "added" || s === "untracked") return "success";
	if (s === "deleted") return "error";
	return "warning";
}

function colorDiffLine(t: Theme, line: string): string {
	if (line.startsWith("+++") || line.startsWith("---")) return t.fg("muted", line);
	if (line.startsWith("+")) return t.fg("success", line);
	if (line.startsWith("-")) return t.fg("error", line);
	if (line.startsWith("@@")) return t.fg("accent", line);
	if (line.startsWith("diff ") || line.startsWith("index ")) return t.fg("dim", line);
	return line;
}

// ─── Panel renderers ──────────────────────────────────────────────────────

function renderFiles(t: Theme, st: DiffState, w: number, h: number): string[] {
	if (st.files.length === 0) return [t.fg("muted", " (no changes)")];

	const active = st.focus === "files";
	const max = Math.max(1, h);

	// keep selected row visible
	if (st.selectedIndex < st.fileScrollOffset) st.fileScrollOffset = st.selectedIndex;
	if (st.selectedIndex >= st.fileScrollOffset + max) st.fileScrollOffset = st.selectedIndex - max + 1;

	const start = st.fileScrollOffset;
	const end = Math.min(st.files.length, start + max);
	const lines: string[] = [];

	for (let i = start; i < end; i++) {
		const f = st.files[i];
		const sel = i === st.selectedIndex;
		const cursor = sel ? (active ? t.fg("accent", "▶") : t.fg("muted", "▸")) : " ";
		const dot = f.staged ? t.fg("success", "●") : t.fg("dim", "○");
		const ic = t.fg(statusColor(f.status), icon(f.status));

		const prefixCols = 7;
		const nameW = Math.max(4, w - prefixCols);

		let label: string;
		if (sel && active) {
			label = t.fg("accent", truncateToWidth(f.path, nameW));
		} else if (sel) {
			label = t.fg("muted", truncateToWidth(f.path, nameW));
		} else {
			const slash = f.path.lastIndexOf("/");
			if (slash >= 0) {
				const dir = f.path.slice(0, slash + 1);
				const name = f.path.slice(slash + 1);
				const dirW = Math.min(visibleWidth(dir), Math.floor(nameW * 0.55));
				label = `${t.fg("dim", truncateToWidth(dir, dirW))}${t.fg("text", truncateToWidth(name, Math.max(4, nameW - dirW)))}`;
			} else {
				label = t.fg("text", truncateToWidth(f.path, nameW));
			}
		}

		lines.push(truncateToWidth(`${cursor} ${dot} ${ic} ${label}`, w));
	}

	if (st.files.length > max) {
		const info = t.fg("dim", ` ${start + 1}–${end}/${st.files.length}`);
		while (lines.length < max) lines.push("");
		lines[max - 1] = info;
	}

	while (lines.length < max) lines.push("");
	return lines;
}

function renderDiff(t: Theme, st: DiffState, w: number, h: number): string[] {
	if (st.files.length === 0) return [t.fg("muted", "  Working tree clean")];

	const f = st.files[st.selectedIndex];
	if (!f) return [];

	const raw = st.diffCache.get(f.path);
	if (raw === undefined) return [t.fg("muted", "  Loading…")];

	const all = raw.split("\n");
	if (all.length === 0) return [t.fg("muted", "  (empty diff)")];

	const max = Math.max(1, h);
	// clamp scroll
	const maxOffset = Math.max(0, all.length - max);
	if (st.diffScrollOffset > maxOffset) st.diffScrollOffset = maxOffset;

	const start = st.diffScrollOffset;
	const end = Math.min(all.length, start + max);

	const lines: string[] = [];
	for (let i = start; i < end; i++) {
		lines.push(truncateToWidth(` ${colorDiffLine(t, all[i])}`, w));
	}

	while (lines.length < max) lines.push("");

	// scroll percentage in bottom-right corner
	if (all.length > max) {
		const pct = maxOffset > 0 ? Math.round((st.diffScrollOffset / maxOffset) * 100) : 0;
		const indicator = t.fg("dim", `${pct}% (${start + 1}–${end}/${all.length})`);
		lines[max - 1] = truncateToWidth(` ${indicator}`, w);
	}

	return lines;
}

// ─── Overlay controller ────────────────────────────────────────────────────

class DiffOverlay {
	private st: DiffState;
	private pi: ExtensionAPI;
	private cwd: string;
	private done: () => void;
	private loading = false;

	constructor(pi: ExtensionAPI, cwd: string, st: DiffState, done: () => void) {
		this.pi = pi;
		this.cwd = cwd;
		this.st = st;
		this.done = done;
	}

	private async ensureDiff(tui: Tui): Promise<void> {
		const f = this.st.files[this.st.selectedIndex];
		if (!f || this.st.diffCache.has(f.path) || this.loading) return;
		this.loading = true;
		try {
			this.st.diffCache.set(f.path, await fileDiff(this.pi, this.cwd, f));
		} finally {
			this.loading = false;
		}
		tui.requestRender();
	}

	private async refreshFiles(tui: Tui): Promise<void> {
		const files = await changedFiles(this.pi, this.cwd);
		this.st.files = files;
		if (this.st.selectedIndex >= files.length) this.st.selectedIndex = Math.max(0, files.length - 1);
	}

	handleInput(data: string, tui: Tui): void {
		const st = this.st;
		const n = st.files.length;
		const f = st.files[st.selectedIndex];
		const diffLen = f ? (st.diffCache.get(f.path) ?? "").split("\n").length : 0;

		// ── Global keys ──
		if (data === "q") {
			this.done();
			return;
		}

		// ── FILE LIST focus ──
		if (st.focus === "files") {
			if (matchesKey(data, Key.escape)) {
				this.done();
				return;
			}
			if (matchesKey(data, Key.up) || data === "k") {
				if (st.selectedIndex > 0) {
					st.selectedIndex -= 1;
					st.diffScrollOffset = 0;
					void this.ensureDiff(tui);
				}
			} else if (matchesKey(data, Key.down) || data === "j") {
				if (st.selectedIndex < n - 1) {
					st.selectedIndex += 1;
					st.diffScrollOffset = 0;
					void this.ensureDiff(tui);
				}
			} else if (data === "g") {
				st.selectedIndex = 0;
				st.diffScrollOffset = 0;
				void this.ensureDiff(tui);
			} else if (data === "G") {
				st.selectedIndex = Math.max(0, n - 1);
				st.diffScrollOffset = 0;
				void this.ensureDiff(tui);
			} else if (matchesKey(data, Key.enter)) {
				if (n > 0) {
					st.focus = "diff";
					st.diffScrollOffset = 0;
					void this.ensureDiff(tui);
				}
			} else if (data === "s" && f) {
				const args = f.staged ? ["reset", "HEAD", "--", f.path] : ["add", "--", f.path];
				void this.pi.exec("git", args, { cwd: this.cwd }).then(async () => {
					await this.refreshFiles(tui);
					st.diffCache.delete(f.path);
					void this.ensureDiff(tui);
					tui.requestRender();
				});
			} else if (data === "S") {
				void this.pi.exec("git", ["add", "-A"], { cwd: this.cwd }).then(async () => {
					await this.refreshFiles(tui);
					st.diffCache.clear();
					void this.ensureDiff(tui);
					tui.requestRender();
				});
			}

			tui.requestRender();
			return;
		}

		// ── DIFF VIEW focus ──
		if (matchesKey(data, Key.escape)) {
			st.focus = "files";
			tui.requestRender();
			return;
		}

		if (matchesKey(data, Key.up) || data === "k") {
			st.diffScrollOffset = Math.max(0, st.diffScrollOffset - 1);
		} else if (matchesKey(data, Key.down) || data === "j") {
			st.diffScrollOffset = Math.min(st.diffScrollOffset + 1, Math.max(0, diffLen - 3));
		} else if (matchesKey(data, Key.pageUp) || matchesKey(data, Key.ctrl("u"))) {
			st.diffScrollOffset = Math.max(0, st.diffScrollOffset - 20);
		} else if (matchesKey(data, Key.pageDown) || matchesKey(data, Key.ctrl("d"))) {
			st.diffScrollOffset = Math.min(st.diffScrollOffset + 20, Math.max(0, diffLen - 3));
		} else if (data === "g") {
			st.diffScrollOffset = 0;
		} else if (data === "G") {
			st.diffScrollOffset = Math.max(0, diffLen - 3);
		} else if (matchesKey(data, Key.left)) {
			// quick back to file list
			st.focus = "files";
		} else if (data === "s" && f) {
			const args = f.staged ? ["reset", "HEAD", "--", f.path] : ["add", "--", f.path];
			void this.pi.exec("git", args, { cwd: this.cwd }).then(async () => {
				await this.refreshFiles(tui);
				st.diffCache.delete(f.path);
				void this.ensureDiff(tui);
				tui.requestRender();
			});
		}

		tui.requestRender();
	}

	render(w: number, h: number, t: Theme): string[] {
		const st = this.st;

		// ── Header (3 lines) ──
		const header: string[] = [];
		header.push(...new DynamicBorder((s: string) => t.fg("accent", s)).render(w));

		const branch = st.branch ? t.fg("muted", st.branch) : t.fg("dim", "(detached)");
		const cnt = t.fg("muted", `${st.files.length} file${st.files.length !== 1 ? "s" : ""}`);
		const staged = st.files.filter((f) => f.staged).length;
		const stInfo = staged > 0 ? t.fg("success", ` · ${staged} staged`) : "";
		header.push(`  ${t.fg("accent", t.bold("DIFF"))} ${t.fg("dim", "|")} ${branch} ${t.fg("dim", "·")} ${cnt}${stInfo}`);
		header.push("");

		// ── Footer (3 lines) ──
		const footer: string[] = [];
		footer.push("");
		const hint =
			st.focus === "files"
				? "  ↑/↓ Select  ·  Enter → Diff  ·  s Stage  ·  S All  ·  q/Esc Close"
				: "  ↑/↓ Scroll  ·  PgUp/PgDn Fast  ·  ←/Esc → Files  ·  s Stage  ·  q Close";
		footer.push(t.fg("dim", hint));
		footer.push(...new DynamicBorder((s: string) => t.fg("accent", s)).render(w));

		// ── Body split ──
		const bodyH = Math.max(3, h - header.length - footer.length);
		const leftW = Math.max(14, Math.min(Math.floor(w * 0.28), 44));
		const rightW = Math.max(10, w - leftW - 3); // 3 = " │ "

		const leftTitle =
			st.focus === "files"
				? t.fg("accent", t.bold(" FILES"))
				: t.fg("dim", " FILES");
		const rightTitle =
			st.focus === "diff"
				? t.fg("accent", t.bold(" DIFF"))
				: t.fg("dim", " DIFF");

		// File header
		const f = st.files[st.selectedIndex];
		const fileLabel = f
			? t.fg(statusColor(f.status), `${icon(f.status)} ${f.path}`)
			: "";
		const rightHeader = `${rightTitle} ${fileLabel}`;

		const titleLine = `${truncateToWidth(leftTitle, leftW)}${" ".repeat(Math.max(0, leftW - visibleWidth(leftTitle)))} ${t.fg("dim", "│")} ${truncateToWidth(rightHeader, rightW)}`;

		const sepLeft = t.fg("dim", "─".repeat(leftW));
		const sepRight = t.fg("dim", "─".repeat(rightW));
		const separatorLine = `${sepLeft} ${t.fg("dim", "┼")} ${sepRight}`;

		const contentH = Math.max(1, bodyH - 2); // minus title + separator
		const left = renderFiles(t, st, leftW, contentH);
		const right = renderDiff(t, st, rightW, contentH);

		while (left.length < contentH) left.push("");
		while (right.length < contentH) right.push("");

		const body: string[] = [];
		body.push(titleLine);
		body.push(separatorLine);
		for (let i = 0; i < contentH; i++) {
			const l = truncateToWidth(left[i] ?? "", leftW);
			const pad = Math.max(0, leftW - visibleWidth(l));
			const r = truncateToWidth(right[i] ?? "", rightW);
			body.push(`${l}${" ".repeat(pad)} ${t.fg("dim", "│")} ${r}`);
		}

		return [...header, ...body, ...footer];
	}
}

// ─── Extension ─────────────────────────────────────────────────────────────

export default function diffOverlayExtension(pi: ExtensionAPI) {
	const handler = async (_args: string, ctx: ExtensionCommandContext) => {
		const root = await gitRoot(pi, ctx.cwd);
		if (!root) {
			if (ctx.hasUI) ctx.ui.notify("Not a git repository", "error");
			else console.log("Not a git repository");
			return;
		}

		const [branch, files] = await Promise.all([
			currentBranch(pi, root),
			changedFiles(pi, root),
		]);

		const st: DiffState = {
			files,
			selectedIndex: 0,
			fileScrollOffset: 0,
			diffCache: new Map(),
			diffScrollOffset: 0,
			branch,
			focus: "files",
			error: null,
		};

		if (!ctx.hasUI) {
			if (files.length === 0) { console.log("Working tree clean."); return; }
			for (const f of files) console.log(`${icon(f.status)} ${f.path}`);
			return;
		}

		// Pre-load first diff
		if (files.length > 0) {
			st.diffCache.set(files[0].path, await fileDiff(pi, root, files[0]));
		}

		await ctx.ui.custom<void>(
			(tui, theme, _kb, done) => {
				const o = new DiffOverlay(pi, root, st, () => done(undefined));
				return {
					render: (w) => o.render(w, (tui as unknown as Tui).height ?? 40, theme as unknown as Theme),
					handleInput: (data) => o.handleInput(data, tui as unknown as Tui),
					invalidate: () => {},
				};
			},
			{ overlay: true, overlayOptions: { width: "95%", maxHeight: "90%", anchor: "center" } },
		);
	};

	pi.registerCommand("diff", {
		description: "Git diff viewer — split-pane file list + diff with focus switching",
		handler,
	});
}
