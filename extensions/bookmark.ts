import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import { DynamicBorder, getAgentDir } from "@mariozechner/pi-coding-agent";
import { type AutocompleteItem, Container, type SelectItem, SelectList, Text } from "@mariozechner/pi-tui";

interface Bookmark {
	id: string;
	name: string;
	sessionFile: string;
	cwd: string;
	branch?: string;
	createdAt: number;
}

interface BookmarkStorage {
	version: 1;
	bookmarks: Bookmark[];
}

const SUBCOMMANDS = ["add", "list"] as const;
const STORAGE_VERSION = 1;
const NAME_FALLBACK = "이름 없음";

function bookmarksPath(): string {
	return path.join(getAgentDir(), "bookmarks.json");
}

function loadStorage(): BookmarkStorage {
	const file = bookmarksPath();
	if (!fs.existsSync(file)) return { version: STORAGE_VERSION, bookmarks: [] };
	try {
		const raw = JSON.parse(fs.readFileSync(file, "utf-8")) as unknown;
		if (!raw || typeof raw !== "object") return { version: STORAGE_VERSION, bookmarks: [] };
		const list = (raw as { bookmarks?: unknown }).bookmarks;
		if (!Array.isArray(list)) return { version: STORAGE_VERSION, bookmarks: [] };
		const bookmarks: Bookmark[] = [];
		for (const item of list) {
			if (!item || typeof item !== "object") continue;
			const b = item as Record<string, unknown>;
			if (
				typeof b.id !== "string" ||
				typeof b.name !== "string" ||
				typeof b.sessionFile !== "string" ||
				typeof b.cwd !== "string" ||
				typeof b.createdAt !== "number"
			)
				continue;
			bookmarks.push({
				id: b.id,
				name: b.name,
				sessionFile: b.sessionFile,
				cwd: b.cwd,
				branch: typeof b.branch === "string" ? b.branch : undefined,
				createdAt: b.createdAt,
			});
		}
		return { version: STORAGE_VERSION, bookmarks };
	} catch {
		return { version: STORAGE_VERSION, bookmarks: [] };
	}
}

function saveStorage(storage: BookmarkStorage): void {
	const file = bookmarksPath();
	fs.mkdirSync(path.dirname(file), { recursive: true });
	const tmp = `${file}.tmp`;
	fs.writeFileSync(tmp, JSON.stringify(storage, null, 2), "utf-8");
	fs.renameSync(tmp, file);
}

async function detectBranch(pi: ExtensionAPI, cwd: string): Promise<string | undefined> {
	try {
		const result = await pi.exec("git", ["-C", cwd, "rev-parse", "--abbrev-ref", "HEAD"], { timeout: 2000 });
		if (result.code === 0) {
			const branch = result.stdout.trim();
			return branch || undefined;
		}
	} catch {}
	return undefined;
}

function tildify(p: string): string {
	const home = process.env.HOME;
	if (home && (p === home || p.startsWith(`${home}/`))) return `~${p.slice(home.length)}`;
	return p;
}

function formatTime(ts: number): string {
	const d = new Date(ts);
	const pad = (n: number) => String(n).padStart(2, "0");
	return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

async function handleAdd(pi: ExtensionAPI, ctx: ExtensionCommandContext): Promise<void> {
	const sessionFile = ctx.sessionManager.getSessionFile();
	if (!sessionFile) {
		ctx.ui.notify("저장할 세션이 없습니다 (ephemeral session)", "error");
		return;
	}
	const cwd = ctx.cwd;
	const branch = await detectBranch(pi, cwd);
	const sessionName = ctx.sessionManager.getSessionName();
	const storage = loadStorage();
	const existingIdx = storage.bookmarks.findIndex((b) => b.sessionFile === sessionFile);

	const bookmark: Bookmark = {
		id: existingIdx >= 0 ? storage.bookmarks[existingIdx].id : randomUUID(),
		name: sessionName?.trim() || NAME_FALLBACK,
		sessionFile,
		cwd,
		branch,
		createdAt: existingIdx >= 0 ? storage.bookmarks[existingIdx].createdAt : Date.now(),
	};

	if (existingIdx >= 0) storage.bookmarks[existingIdx] = bookmark;
	else storage.bookmarks.push(bookmark);
	saveStorage(storage);

	const label = bookmark.branch ? `${bookmark.name} (${bookmark.branch})` : bookmark.name;
	ctx.ui.notify(`📑 북마크 ${existingIdx >= 0 ? "갱신" : "저장"}: ${label}`, "info");
}

function buildItems(storage: BookmarkStorage): { items: SelectItem[]; byId: Map<string, Bookmark> } {
	const sorted = storage.bookmarks.slice().sort((a, b) => b.createdAt - a.createdAt);
	const items: SelectItem[] = sorted.map((b) => ({
		value: b.id,
		label: b.name,
		description: [b.branch ? `⌥ ${b.branch}` : undefined, tildify(b.cwd), formatTime(b.createdAt)]
			.filter(Boolean)
			.join("  •  "),
	}));
	const byId = new Map(sorted.map((b) => [b.id, b]));
	return { items, byId };
}

async function openInGhosttyPanel(pi: ExtensionAPI, bookmark: Bookmark): Promise<{ ok: boolean; stderr?: string }> {
	const esc = (s: string) => s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
	const script = `tell application "Ghostty"
  set currentTerm to focused terminal of selected tab of front window
  set newTerm to split currentTerm direction right
  input text "cd \\"${esc(bookmark.cwd)}\\" && pi --session \\"${esc(bookmark.sessionFile)}\\"" to newTerm
  send key "enter" to newTerm
end tell`;
	const result = await pi.exec("osascript", ["-e", script]);
	return { ok: result.code === 0, stderr: result.stderr };
}

async function activate(pi: ExtensionAPI, ctx: ExtensionCommandContext, bookmark: Bookmark): Promise<void> {
	if (!fs.existsSync(bookmark.sessionFile)) {
		ctx.ui.notify(`세션 파일을 찾을 수 없습니다: ${bookmark.sessionFile}`, "error");
		return;
	}
	const sameCwd = path.resolve(bookmark.cwd) === path.resolve(ctx.cwd);
	if (sameCwd) {
		await ctx.switchSession(bookmark.sessionFile);
		return;
	}
	const result = await openInGhosttyPanel(pi, bookmark);
	if (!result.ok) {
		ctx.ui.notify(`Ghostty 패널 열기 실패: ${result.stderr ?? ""}`, "error");
		return;
	}
	ctx.ui.notify(`📑 패널 열기 → ${bookmark.name}`, "info");
}

type ListResult = { kind: "select"; id: string } | { kind: "delete"; id: string } | null;

async function showListOverlay(ctx: ExtensionCommandContext, items: SelectItem[]): Promise<ListResult> {
	return ctx.ui.custom<ListResult>((tui, theme, _kb, done) => {
		const container = new Container();
		container.addChild(new DynamicBorder((s) => theme.fg("accent", s)));
		container.addChild(new Text(theme.fg("accent", theme.bold("📑 Bookmarks"))));

		const list = new SelectList(items, Math.min(Math.max(items.length, 1), 12), {
			selectedPrefix: (t) => theme.fg("accent", t),
			selectedText: (t) => theme.fg("accent", t),
			description: (t) => theme.fg("muted", t),
			scrollInfo: (t) => theme.fg("dim", t),
			noMatch: (t) => theme.fg("warning", t),
		});
		list.onSelect = (item) => done({ kind: "select", id: item.value });
		list.onCancel = () => done(null);

		container.addChild(list);
		container.addChild(new Text(theme.fg("dim", "↑↓ navigate • enter open • d delete • esc cancel")));
		container.addChild(new DynamicBorder((s) => theme.fg("accent", s)));

		return {
			render(width: number) {
				return container.render(width);
			},
			invalidate() {
				container.invalidate();
			},
			handleInput(data: string) {
				if (data === "d" || data === "D") {
					const sel = list.getSelectedItem();
					if (sel) {
						done({ kind: "delete", id: sel.value });
						return;
					}
				}
				list.handleInput(data);
				tui.requestRender();
			},
		};
	});
}

async function handleList(pi: ExtensionAPI, ctx: ExtensionCommandContext): Promise<void> {
	while (true) {
		const storage = loadStorage();
		if (storage.bookmarks.length === 0) {
			ctx.ui.notify("저장된 북마크가 없습니다. /bookmark add 로 추가하세요.", "warning");
			return;
		}
		const { items, byId } = buildItems(storage);
		const result = await showListOverlay(ctx, items);
		if (!result) return;

		const target = byId.get(result.id);
		if (!target) continue;

		if (result.kind === "delete") {
			const ok = await ctx.ui.confirm("북마크 삭제", `"${target.name}" 을(를) 삭제할까요?`);
			if (ok) {
				saveStorage({ version: STORAGE_VERSION, bookmarks: storage.bookmarks.filter((b) => b.id !== target.id) });
				ctx.ui.notify(`📑 삭제됨: ${target.name}`, "info");
			}
			continue;
		}

		await activate(pi, ctx, target);
		return;
	}
}

async function handleRoot(pi: ExtensionAPI, ctx: ExtensionCommandContext): Promise<void> {
	const choice = await ctx.ui.select("📑 Bookmark", ["add — 현재 세션 저장", "list — 저장된 북마크 보기"]);
	if (!choice) return;
	if (choice.startsWith("add")) await handleAdd(pi, ctx);
	else if (choice.startsWith("list")) await handleList(pi, ctx);
}

export default function (pi: ExtensionAPI) {
	pi.registerCommand("bookmark", {
		description: "현재 pi 세션을 북마크하거나 저장된 북마크를 열기 (사용: /bookmark [add|list])",
		getArgumentCompletions: (prefix: string): AutocompleteItem[] | null => {
			const filtered = SUBCOMMANDS.filter((s) => s.startsWith(prefix.toLowerCase()));
			if (filtered.length === 0) return null;
			return filtered.map((value) => ({ value, label: value }));
		},
		handler: async (args, ctx) => {
			const sub = args.trim().toLowerCase();
			if (sub === "") {
				await handleRoot(pi, ctx);
				return;
			}
			if (sub === "add") {
				await handleAdd(pi, ctx);
				return;
			}
			if (sub === "list" || sub === "ls") {
				await handleList(pi, ctx);
				return;
			}
			ctx.ui.notify(`알 수 없는 서브커맨드: ${sub}. 사용 가능: add, list`, "error");
		},
	});
}
