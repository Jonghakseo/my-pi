import * as path from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { DynamicBorder } from "@earendil-works/pi-coding-agent";
import { type AutocompleteItem, Container, type SelectItem, SelectList, Text } from "@earendil-works/pi-tui";

const PROTECTED_BRANCHES = new Set(["development", "production", "main", "master"]);
const BASE_BRANCHES = ["development", "production"] as const;
const STATUS_CONCURRENCY = 8;
const GIT_TIMEOUT = 5000;

interface Worktree {
	path: string;
	branch?: string;
	head?: string;
	detached: boolean;
	bare: boolean;
	locked: boolean;
	prunable: boolean;
	isMain: boolean;
	isCurrent: boolean;
	// enriched
	dirty?: number;
	ahead?: number;
	behind?: number;
	lastCommit?: string;
}

async function git(
	pi: ExtensionAPI,
	cwd: string,
	args: string[],
	timeout = GIT_TIMEOUT,
): Promise<{ code: number; stdout: string; stderr: string }> {
	try {
		return await pi.exec("git", ["-C", cwd, ...args], { timeout });
	} catch (err) {
		return { code: 1, stdout: "", stderr: err instanceof Error ? err.message : String(err) };
	}
}

function tildify(p: string): string {
	const home = process.env.HOME;
	if (home && (p === home || p.startsWith(`${home}/`))) return `~${p.slice(home.length)}`;
	return p;
}

async function repoToplevel(pi: ExtensionAPI, cwd: string): Promise<string | undefined> {
	const r = await git(pi, cwd, ["rev-parse", "--show-toplevel"]);
	if (r.code !== 0) return undefined;
	return r.stdout.trim() || undefined;
}

async function mainWorktreePath(pi: ExtensionAPI, cwd: string): Promise<string | undefined> {
	const r = await git(pi, cwd, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
	if (r.code !== 0) return undefined;
	const commonDir = r.stdout.trim();
	if (!commonDir) return undefined;
	return path.basename(commonDir) === ".git" ? path.dirname(commonDir) : commonDir;
}

function applyPorcelainLine(wt: Worktree, line: string): void {
	if (line.startsWith("worktree ")) wt.path = line.slice("worktree ".length);
	else if (line.startsWith("HEAD ")) wt.head = line.slice("HEAD ".length);
	else if (line.startsWith("branch ")) wt.branch = line.slice("branch ".length).replace(/^refs\/heads\//, "");
	else if (line === "detached") wt.detached = true;
	else if (line === "bare") wt.bare = true;
	else if (line === "locked" || line.startsWith("locked ")) wt.locked = true;
	else if (line === "prunable" || line.startsWith("prunable ")) wt.prunable = true;
}

function parseWorktrees(porcelain: string): Worktree[] {
	const out: Worktree[] = [];
	for (const block of porcelain.split(/\n\n+/)) {
		const lines = block.split("\n").filter(Boolean);
		if (lines.length === 0) continue;
		const wt: Worktree = {
			path: "",
			detached: false,
			bare: false,
			locked: false,
			prunable: false,
			isMain: false,
			isCurrent: false,
		};
		for (const line of lines) applyPorcelainLine(wt, line);
		if (wt.path) out.push(wt);
	}
	return out;
}

async function enrich(pi: ExtensionAPI, wt: Worktree): Promise<void> {
	if (wt.prunable || wt.bare) return;
	const status = await git(pi, wt.path, ["status", "--porcelain"], 4000);
	if (status.code === 0) wt.dirty = status.stdout.split("\n").filter((l) => l.trim()).length;
	const ab = await git(pi, wt.path, ["rev-list", "--left-right", "--count", "@{upstream}...HEAD"], 4000);
	if (ab.code === 0) {
		const m = ab.stdout.trim().split(/\s+/);
		if (m.length === 2) {
			wt.behind = Number(m[0]);
			wt.ahead = Number(m[1]);
		}
	}
	const log = await git(pi, wt.path, ["log", "-1", "--format=%cr|%s"], 4000);
	if (log.code === 0) wt.lastCommit = log.stdout.trim();
}

async function runPool<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
	let idx = 0;
	const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
		while (idx < items.length) {
			const cur = items[idx++];
			await fn(cur);
		}
	});
	await Promise.all(workers);
}

async function loadWorktrees(pi: ExtensionAPI, cwd: string): Promise<Worktree[] | undefined> {
	const top = await repoToplevel(pi, cwd);
	if (!top) return undefined;
	const list = await git(pi, top, ["worktree", "list", "--porcelain"]);
	if (list.code !== 0) return undefined;
	const worktrees = parseWorktrees(list.stdout);
	const mainPath = await mainWorktreePath(pi, top);
	for (const wt of worktrees) {
		wt.isMain = mainPath ? path.resolve(wt.path) === path.resolve(mainPath) : false;
		wt.isCurrent = path.resolve(wt.path) === path.resolve(top);
	}
	await runPool(worktrees, STATUS_CONCURRENCY, (wt) => enrich(pi, wt));
	// current first, then main, then by branch/path
	worktrees.sort((a, b) => {
		if (a.isCurrent !== b.isCurrent) return a.isCurrent ? -1 : 1;
		if (a.isMain !== b.isMain) return a.isMain ? -1 : 1;
		return (a.branch ?? a.path).localeCompare(b.branch ?? b.path);
	});
	return worktrees;
}

function label(wt: Worktree): string {
	if (wt.bare) return "(bare)";
	if (wt.detached || !wt.branch) return `(detached) ${wt.head?.slice(0, 9) ?? ""}`.trim();
	return wt.branch;
}

function statusBadges(wt: Worktree): string {
	const parts: string[] = [];
	if (wt.isCurrent) parts.push("● current");
	if (wt.isMain && !wt.isCurrent) parts.push("base");
	if (wt.prunable) parts.push("⚠ prunable");
	if (wt.locked) parts.push("🔒 locked");
	if (wt.dirty && wt.dirty > 0) parts.push(`✱${wt.dirty}`);
	if (wt.ahead) parts.push(`↑${wt.ahead}`);
	if (wt.behind) parts.push(`↓${wt.behind}`);
	return parts.join(" ");
}

function buildItems(worktrees: Worktree[]): { items: SelectItem[]; byPath: Map<string, Worktree> } {
	const items: SelectItem[] = worktrees.map((wt) => {
		const badges = statusBadges(wt);
		const desc = [badges || undefined, tildify(wt.path), wt.lastCommit ? wt.lastCommit.replace("|", " · ") : undefined]
			.filter(Boolean)
			.join("  •  ");
		return { value: wt.path, label: label(wt), description: desc };
	});
	return { items, byPath: new Map(worktrees.map((w) => [w.path, w])) };
}

function isGhosttyOnMac(): boolean {
	return process.platform === "darwin" && process.env.TERM_PROGRAM === "ghostty";
}

async function openWorktreePanel(pi: ExtensionAPI, dir: string): Promise<{ ok: boolean; stderr?: string }> {
	const esc = (s: string) => s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
	const script = `tell application "Ghostty"
  set currentTerm to focused terminal of selected tab of front window
  set newTerm to split currentTerm direction right
  input text "cd \\"${esc(dir)}\\" && pi" to newTerm
  send key "enter" to newTerm
end tell`;
	const result = await pi.exec("osascript", ["-e", script]);
	return { ok: result.code === 0, stderr: result.stderr };
}

async function openWorktree(pi: ExtensionAPI, ctx: ExtensionCommandContext, wt: Worktree): Promise<void> {
	if (path.resolve(wt.path) === path.resolve(ctx.cwd)) {
		ctx.ui.notify("이미 현재 worktree입니다", "info");
		return;
	}
	if (!isGhosttyOnMac()) {
		ctx.ui.notify(`다른 worktree 열기는 macOS Ghostty에서만 지원합니다. 수동 실행: cd "${wt.path}" && pi`, "warning");
		return;
	}
	const r = await openWorktreePanel(pi, wt.path);
	if (!r.ok) {
		ctx.ui.notify(`패널 열기 실패: ${r.stderr ?? ""}`, "error");
		return;
	}
	ctx.ui.notify(`🌿 패널 열기 → ${label(wt)}`, "info");
}

async function deriveBaseDir(pi: ExtensionAPI, cwd: string, worktrees: Worktree[]): Promise<string> {
	const counts = new Map<string, number>();
	for (const wt of worktrees) {
		if (wt.isMain) continue;
		const parent = path.dirname(wt.path);
		counts.set(parent, (counts.get(parent) ?? 0) + 1);
	}
	let best: string | undefined;
	let bestN = 0;
	for (const [dir, n] of counts) {
		if (n > bestN) {
			best = dir;
			bestN = n;
		}
	}
	if (best) return best;
	const top = (await repoToplevel(pi, cwd)) ?? cwd;
	return path.join(path.dirname(top), `${path.basename(top)}-worktrees`);
}

async function handleCreate(pi: ExtensionAPI, ctx: ExtensionCommandContext, worktrees: Worktree[]): Promise<void> {
	const name = await ctx.ui.input("새 worktree 이름", "예: fix-payment 또는 feature/login");
	if (!name?.trim()) return;
	const clean = name.trim();
	const base = await ctx.ui.select("base 브랜치 선택", [...BASE_BRANCHES]);
	if (!base) return;

	const baseDir = await deriveBaseDir(pi, ctx.cwd, worktrees);
	const dirName = clean.replace(/\//g, "-");
	const wtPath = path.join(baseDir, dirName);
	const top = (await repoToplevel(pi, ctx.cwd)) ?? ctx.cwd;

	ctx.ui.notify(`origin/${base} fetch 중…`, "info");
	await git(pi, top, ["fetch", "origin", "--prune"], 30000);

	const add = await git(pi, top, ["worktree", "add", "-b", clean, wtPath, `origin/${base}`], 30000);
	if (add.code !== 0) {
		// branch may already exist — retry without -b
		const retry = await git(pi, top, ["worktree", "add", wtPath, clean], 30000);
		if (retry.code !== 0) {
			ctx.ui.notify(`worktree 생성 실패: ${(add.stderr || retry.stderr).trim().split("\n")[0]}`, "error");
			return;
		}
	}
	ctx.ui.notify(`🌿 생성됨: ${clean} → ${tildify(wtPath)}`, "info");
	const open = await ctx.ui.confirm("worktree 열기", `"${clean}" worktree를 새 패널에서 열까요?`);
	if (open)
		await openWorktree(pi, ctx, { ...({} as Worktree), path: wtPath, branch: clean, detached: false } as Worktree);
}

async function handleDelete(pi: ExtensionAPI, ctx: ExtensionCommandContext, wt: Worktree): Promise<boolean> {
	if (wt.isMain || wt.isCurrent) {
		ctx.ui.notify("현재/메인 worktree는 삭제할 수 없습니다", "warning");
		return false;
	}
	const dirtyWarn = wt.dirty && wt.dirty > 0 ? `\n⚠ 커밋되지 않은 변경 ${wt.dirty}건이 있습니다.` : "";
	const ok = await ctx.ui.confirm("worktree 삭제", `"${label(wt)}"\n${tildify(wt.path)} 를 삭제할까요?${dirtyWarn}`);
	if (!ok) return false;
	const top = (await repoToplevel(pi, ctx.cwd)) ?? ctx.cwd;
	const force = wt.dirty && wt.dirty > 0 ? ["--force"] : [];
	const r = await git(pi, top, ["worktree", "remove", ...force, wt.path], 15000);
	if (r.code !== 0) {
		ctx.ui.notify(`삭제 실패: ${r.stderr.trim().split("\n")[0]}`, "error");
		return false;
	}
	ctx.ui.notify(`🗑 삭제됨: ${label(wt)}`, "info");
	return true;
}

async function handleSync(pi: ExtensionAPI, ctx: ExtensionCommandContext, wt: Worktree): Promise<void> {
	if (wt.bare || wt.prunable) {
		ctx.ui.notify("동기화할 수 없는 worktree입니다", "warning");
		return;
	}
	ctx.ui.notify(`🔄 ${label(wt)} 동기화 중…`, "info");
	await git(pi, wt.path, ["fetch", "origin", "--prune"], 30000);
	const pull = await git(pi, wt.path, ["pull", "--ff-only"], 30000);
	if (pull.code === 0) {
		ctx.ui.notify(`✅ ${label(wt)} 동기화 완료`, "info");
		return;
	}
	ctx.ui.notify(
		`동기화 실패(ff-only): ${pull.stderr.trim().split("\n")[0] || pull.stdout.trim().split("\n")[0]}`,
		"warning",
	);
}

async function handleGc(pi: ExtensionAPI, ctx: ExtensionCommandContext, worktrees: Worktree[]): Promise<boolean> {
	const top = (await repoToplevel(pi, ctx.cwd)) ?? ctx.cwd;
	await git(pi, top, ["worktree", "prune"], 10000);
	const mergedRes = await git(
		pi,
		top,
		["branch", "--merged", "origin/development", "--format=%(refname:short)"],
		10000,
	);
	const merged = new Set(
		mergedRes.code === 0
			? mergedRes.stdout
					.split("\n")
					.map((l) => l.trim())
					.filter(Boolean)
			: [],
	);
	const candidates = worktrees.filter(
		(wt) =>
			!wt.isMain &&
			!wt.isCurrent &&
			!wt.bare &&
			wt.branch &&
			!PROTECTED_BRANCHES.has(wt.branch) &&
			merged.has(wt.branch) &&
			(wt.dirty ?? 0) === 0,
	);
	if (candidates.length === 0) {
		ctx.ui.notify("정리할 merged worktree가 없습니다", "info");
		return false;
	}
	const listText = candidates.map((c) => `• ${c.branch}  (${tildify(c.path)})`).join("\n");
	const ok = await ctx.ui.confirm(
		"merged worktree 정리",
		`origin/development에 머지된 worktree ${candidates.length}개를 삭제할까요?\n\n${listText}`,
	);
	if (!ok) return false;
	let removed = 0;
	for (const wt of candidates) {
		const r = await git(pi, top, ["worktree", "remove", wt.path], 15000);
		if (r.code === 0) removed++;
	}
	ctx.ui.notify(`🧹 ${removed}/${candidates.length}개 worktree 정리됨`, "info");
	return removed > 0;
}

type ListResult =
	| { kind: "open"; path: string }
	| { kind: "delete"; path: string }
	| { kind: "sync"; path: string }
	| { kind: "create" }
	| { kind: "gc" }
	| { kind: "refresh" }
	| null;

async function showOverlay(ctx: ExtensionCommandContext, items: SelectItem[]): Promise<ListResult> {
	return ctx.ui.custom<ListResult>((tui, theme, _kb, done) => {
		const container = new Container();
		container.addChild(new DynamicBorder((s) => theme.fg("accent", s)));
		container.addChild(new Text(theme.fg("accent", theme.bold("🌿 Worktrees"))));

		const list = new SelectList(items, Math.min(Math.max(items.length, 1), 14), {
			selectedPrefix: (t) => theme.fg("accent", t),
			selectedText: (t) => theme.fg("accent", t),
			description: (t) => theme.fg("muted", t),
			scrollInfo: (t) => theme.fg("dim", t),
			noMatch: (t) => theme.fg("warning", t),
		});
		list.onSelect = (item) => done({ kind: "open", path: item.value });
		list.onCancel = () => done(null);

		container.addChild(list);
		container.addChild(
			new Text(theme.fg("dim", "↑↓ 이동 • enter 열기 • n 생성 • d 삭제 • s 동기화 • g 정리 • r 새로고침 • esc 닫기")),
		);
		container.addChild(new DynamicBorder((s) => theme.fg("accent", s)));

		return {
			render(width: number) {
				return container.render(width);
			},
			invalidate() {
				container.invalidate();
			},
			handleInput(data: string) {
				const sel = list.getSelectedItem();
				if (data === "n" || data === "N") return done({ kind: "create" });
				if (data === "g" || data === "G") return done({ kind: "gc" });
				if (data === "r" || data === "R") return done({ kind: "refresh" });
				if ((data === "d" || data === "D") && sel) return done({ kind: "delete", path: sel.value });
				if ((data === "s" || data === "S") && sel) return done({ kind: "sync", path: sel.value });
				list.handleInput(data);
				tui.requestRender();
			},
		};
	});
}

async function handleList(pi: ExtensionAPI, ctx: ExtensionCommandContext): Promise<void> {
	let cache: Worktree[] | undefined;
	while (true) {
		if (!cache) {
			ctx.ui.notify("worktree 정보 로딩 중…", "info");
			cache = await loadWorktrees(pi, ctx.cwd);
		}
		if (!cache) {
			ctx.ui.notify("git 저장소를 찾을 수 없습니다", "error");
			return;
		}
		if (cache.length === 0) {
			ctx.ui.notify("worktree가 없습니다", "warning");
			return;
		}
		const { items, byPath } = buildItems(cache);
		const result = await showOverlay(ctx, items);
		if (!result) return;

		if (result.kind === "refresh") {
			cache = undefined;
			continue;
		}
		if (result.kind === "create") {
			await handleCreate(pi, ctx, cache);
			cache = undefined;
			continue;
		}
		if (result.kind === "gc") {
			await handleGc(pi, ctx, cache);
			cache = undefined;
			continue;
		}
		const target = byPath.get(result.path);
		if (!target) {
			cache = undefined;
			continue;
		}
		if (result.kind === "open") {
			await openWorktree(pi, ctx, target);
			return;
		}
		if (result.kind === "delete") {
			await handleDelete(pi, ctx, target);
			cache = undefined;
			continue;
		}
		if (result.kind === "sync") {
			await handleSync(pi, ctx, target);
			cache = undefined;
		}
	}
}

export default function (pi: ExtensionAPI) {
	pi.registerCommand("worktree", {
		description: "git worktree 목록/전환/생성/삭제/동기화/정리 (사용: /worktree [new])",
		getArgumentCompletions: (prefix: string): AutocompleteItem[] | null => {
			const subs = ["new"];
			const filtered = subs.filter((s) => s.startsWith(prefix.toLowerCase()));
			return filtered.length > 0 ? filtered.map((value) => ({ value, label: value })) : null;
		},
		handler: async (args, ctx) => {
			const sub = args.trim().toLowerCase();
			if (sub === "new" || sub === "add" || sub === "n") {
				const cache = (await loadWorktrees(pi, ctx.cwd)) ?? [];
				await handleCreate(pi, ctx, cache);
				return;
			}
			await handleList(pi, ctx);
		},
	});
}
