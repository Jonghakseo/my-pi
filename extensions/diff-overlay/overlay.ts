import path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { DynamicBorder } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import {
	commitStateBadge,
	cycleOverlayDiffScope,
	parseDiffLines,
	toggleOverlayViewMode,
	type BranchCommitEntry,
	type OverlayDiffScope,
} from "./diff-overlay-utils.js";
import { commitFileDiff, commitFilesForHash, fileDiff, loadOverlayData, workingTreeFiles } from "./git.js";
import {
	applyScopeFiles,
	ARROW_SCROLL_STEP,
	buildCommitRowsMeta,
	buildReviewTransferPrompt,
	clamp,
	commitDiffKey,
	commitStateColor,
	countRenderedDiffLines,
	expandTabs,
	fileDisplayPath,
	findFileByPath,
	getVisibleRows,
	icon,
	overlayContentHeight,
	PAGE_SCROLL_STEP,
	restoreDiffScroll,
	saveDiffScroll,
	scopedDiffKey,
	scopeFilesLabel,
	scopeLabel,
	statusColor,
	UNCOMMITTED_HASH,
} from "./overlay-utils.js";
import { renderCommitFiles, renderCommits, renderDiff, renderFiles } from "./render.js";
import type { CommitFile, DiffFile, DiffState, Theme, Tui } from "./types.js";

// ─── Overlay controller ────────────────────────────────────────────────────

export class DiffOverlay {
	private st: DiffState;
	private pi: ExtensionAPI;
	private cwd: string;
	private done: (reviewPrompt?: string) => void;
	private diffLoading = false;
	private lastRightWidth = 80;

	constructor(pi: ExtensionAPI, cwd: string, st: DiffState, done: (reviewPrompt?: string) => void) {
		this.pi = pi;
		this.cwd = cwd;
		this.st = st;
		this.done = done;
	}

	private selectedDiffFile(): DiffFile | null {
		return findFileByPath(this.st, this.st.selectedFilePath);
	}

	private selectDiffFile(filePath: string | null, tui: Tui): void {
		saveDiffScroll(this.st);
		this.st.selectedFilePath = filePath;
		this.st.selectedFilePathByScope[this.st.scope] = filePath;
		restoreDiffScroll(this.st);
		void this.ensureDiff(tui);
	}

	private applyScopeAndFilter(tui: Tui): void {
		applyScopeFiles(this.st);
		void this.ensureDiff(tui);
	}

	private openReviewDraftInput(): void {
		if (!this.selectedDiffFile()) {
			this.st.error = "Select a file before adding review feedback";
			return;
		}
		this.st.reviewInput = { active: true, buffer: "", error: null };
	}

	private submitReviewDraft(): void {
		const file = this.selectedDiffFile();
		if (!file) {
			this.st.reviewInput.error = "No file selected";
			return;
		}
		const prompt = this.st.reviewInput.buffer.trim();
		if (!prompt) {
			this.st.reviewInput.error = "Review message cannot be empty";
			return;
		}
		this.st.reviewDrafts.push({
			scope: this.st.scope,
			filePath: file.path,
			fileDisplayPath: fileDisplayPath(file),
			prompt,
		});
		this.st.reviewInput = { active: false, buffer: "", error: null };
		this.st.error = null;
	}

	private closeReviewDraftInput(): void {
		this.st.reviewInput = { active: false, buffer: "", error: null };
	}

	private closeOverlay(): void {
		const reviewPrompt = buildReviewTransferPrompt(this.st.reviewDrafts);
		this.done(reviewPrompt || undefined);
	}

	private switchScope(nextScope: OverlayDiffScope, tui: Tui): void {
		if (nextScope === this.st.scope) return;
		saveDiffScroll(this.st);
		this.st.scope = nextScope;
		this.st.searchMode = false;
		this.st.diffCache.clear();
		this.st.highlightedDiffCache.clear();
		this.applyScopeAndFilter(tui);
	}

	private selectedCommit(): BranchCommitEntry | null {
		if (this.st.commits.length === 0) return null;
		this.st.commitSelectedIndex = clamp(this.st.commitSelectedIndex, 0, this.st.commits.length - 1);
		return this.st.commits[this.st.commitSelectedIndex] ?? null;
	}

	private selectedCommitFile(): CommitFile | null {
		const commit = this.selectedCommit();
		if (!commit) return null;
		const files = this.st.commitFilesCache.get(commit.hash);
		if (!files || files.length === 0) return null;
		this.st.commitFileSelectedIndex = clamp(this.st.commitFileSelectedIndex, 0, files.length - 1);
		return files[this.st.commitFileSelectedIndex] ?? null;
	}

	private expandedSet(commitHash: string): Set<string> {
		let set = this.st.commitExpandedByHash.get(commitHash);
		if (!set) {
			set = new Set<string>();
			this.st.commitExpandedByHash.set(commitHash, set);
		}
		return set;
	}

	private resetCommitFilesPanel(): void {
		this.st.commitFileSelectedIndex = 0;
		this.st.commitFileScrollOffset = 0;
		this.st.commitFileManualScroll = false;
	}

	private async ensureDiff(tui: Tui): Promise<void> {
		const f = this.selectedDiffFile();
		if (!f) return;
		const key = scopedDiffKey(this.st.scope, f.path);
		if (this.st.diffCache.has(key) || this.diffLoading) return;
		this.diffLoading = true;
		try {
			this.st.diffCache.set(key, await fileDiff(this.pi, this.cwd, f, this.st.scope, this.st.mergeBase));
		} finally {
			this.diffLoading = false;
		}
		tui.requestRender();
		const current = this.selectedDiffFile();
		if (current) {
			const currentKey = scopedDiffKey(this.st.scope, current.path);
			if (!this.st.diffCache.has(currentKey)) {
				void this.ensureDiff(tui);
			}
		}
	}

	private async ensureCommitFiles(tui: Tui): Promise<void> {
		const commit = this.selectedCommit();
		if (!commit) return;
		if (this.st.commitFilesCache.has(commit.hash) || this.st.commitFilesLoading.has(commit.hash)) return;

		this.st.commitFilesLoading.add(commit.hash);
		tui.requestRender();
		try {
			if (commit.hash === UNCOMMITTED_HASH) {
				const wtFiles = await workingTreeFiles(this.pi, this.cwd);
				this.st.commitFilesCache.set(
					UNCOMMITTED_HASH,
					wtFiles.map((f) => ({
						path: f.path,
						status: f.status,
						rawStatus: f.rawStatus,
						previousPath: f.previousPath ?? null,
					})),
				);
			} else {
				const files = await commitFilesForHash(this.pi, this.cwd, commit.hash);
				this.st.commitFilesCache.set(commit.hash, files);
			}
		} finally {
			this.st.commitFilesLoading.delete(commit.hash);
		}
		tui.requestRender();
	}

	private async ensureCommitFileDiff(commitHash: string, file: CommitFile, tui: Tui): Promise<void> {
		const key = commitDiffKey(commitHash, file.path);
		if (this.st.commitFileDiffCache.has(key) || this.st.commitFileDiffLoading.has(key)) return;
		this.st.commitFileDiffLoading.add(key);
		tui.requestRender();
		try {
			const raw = await commitFileDiff(this.pi, this.cwd, commitHash, file);
			this.st.commitFileDiffCache.set(key, raw);
		} finally {
			this.st.commitFileDiffLoading.delete(key);
		}
		tui.requestRender();
	}

	private async openPath(targetPath: string): Promise<void> {
		const filePath = path.isAbsolute(targetPath) ? targetPath : path.resolve(this.cwd, targetPath);
		const command = process.platform === "darwin" ? "open" : "xdg-open";
		const r = await this.pi.exec(command, [filePath], { cwd: this.cwd });
		this.st.error = r.code === 0 ? null : r.stderr?.trim() || `Failed to open ${targetPath}`;
	}

	private async revealPath(targetPath: string): Promise<void> {
		const filePath = path.isAbsolute(targetPath) ? targetPath : path.resolve(this.cwd, targetPath);
		const command = process.platform === "darwin" ? "open" : "xdg-open";
		const args = process.platform === "darwin" ? ["-R", filePath] : [path.dirname(filePath)];
		const r = await this.pi.exec(command, args, { cwd: this.cwd });
		this.st.error = r.code === 0 ? null : r.stderr?.trim() || `Failed to reveal ${targetPath}`;
	}

	private async refreshFiles(tui: Tui): Promise<void> {
		const data = await loadOverlayData(this.pi, this.cwd, this.st.mergeBase);
		this.st.filesByScope = data.filesByScope;
		this.st.commits = data.commits;
		this.st.diffCache.clear();
		this.st.highlightedDiffCache.clear();
		this.st.commitFilesCache.clear();
		this.st.commitFileDiffCache.clear();
		this.st.commitExpandedByHash.clear();
		this.applyScopeAndFilter(tui);
		if (data.uncommittedFiles.length > 0) {
			this.st.commits.unshift({
				hash: UNCOMMITTED_HASH,
				shortHash: "•••",
				author: "",
				relativeDate: "now",
				subject: `Uncommitted Changes (${data.uncommittedFiles.length} file${data.uncommittedFiles.length !== 1 ? "s" : ""})`,
			});
			this.st.commitFilesCache.set(
				UNCOMMITTED_HASH,
				data.uncommittedFiles.map((f) => ({
					path: f.path,
					status: f.status,
					rawStatus: f.rawStatus,
					previousPath: f.previousPath ?? null,
				})),
			);
		}
		if (this.st.files.length === 0) {
			this.st.selectedIndex = 0;
			this.st.fileScrollOffset = 0;
			this.st.diffScrollOffset = 0;
			this.st.selectedFilePath = null;
			this.st.focus = "left";
		}
	}

	private async stashChanges(tui: Tui): Promise<void> {
		const r = await this.pi.exec("git", ["stash", "push", "-u"], { cwd: this.cwd });
		if (r.code !== 0) {
			this.st.error = r.stderr?.trim() || "Failed to stash changes";
			return;
		}

		this.st.error = null;
		await this.refreshFiles(tui);
		if (this.st.viewMode === "diff") void this.ensureDiff(tui);
	}

	private selectCommit(nextIndex: number, tui: Tui): void {
		if (this.st.commits.length === 0) return;
		const clamped = clamp(nextIndex, 0, this.st.commits.length - 1);
		if (clamped === this.st.commitSelectedIndex) return;
		this.st.commitSelectedIndex = clamped;
		this.resetCommitFilesPanel();
		void this.ensureCommitFiles(tui);
	}

	/** After navigating in the tree, update selectedFilePath if on a file row. */
	private syncSelectedFile(tui: Tui): void {
		const rows = getVisibleRows(this.st);
		const row = rows[this.st.selectedIndex];
		if (row?.type === "file") {
			this.selectDiffFile(row.fullPath, tui);
		}
	}

	// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: keyboard routing is stateful and kept flat to preserve exact overlay behavior.
	private handleDiffModeInput(data: string, tui: Tui): void {
		const st = this.st;

		if (st.reviewInput.active) {
			if (matchesKey(data, Key.escape)) {
				this.closeReviewDraftInput();
				tui.requestRender();
				return;
			}
			if (matchesKey(data, Key.enter)) {
				this.submitReviewDraft();
				tui.requestRender();
				return;
			}
			if (matchesKey(data, Key.backspace)) {
				st.reviewInput.buffer = st.reviewInput.buffer.slice(0, -1);
				st.reviewInput.error = null;
				tui.requestRender();
				return;
			}
			if (data.length === 1 && data >= " " && data !== "\u007f") {
				st.reviewInput.buffer += data;
				st.reviewInput.error = null;
				tui.requestRender();
			}
			return;
		}

		if (st.searchMode) {
			if (matchesKey(data, Key.escape) || matchesKey(data, Key.enter)) {
				st.searchMode = false;
				tui.requestRender();
				return;
			}
			if (matchesKey(data, Key.backspace)) {
				st.searchQuery = st.searchQuery.slice(0, -1);
				this.applyScopeAndFilter(tui);
				tui.requestRender();
				return;
			}
			if (data.length === 1 && data >= " " && data !== "\u007f") {
				st.searchQuery += data;
				this.applyScopeAndFilter(tui);
				tui.requestRender();
			}
			return;
		}

		const rows = getVisibleRows(st);
		const n = rows.length;
		const currentRow = rows[st.selectedIndex];
		const f = this.selectedDiffFile();

		if (data === "/") {
			st.searchMode = true;
			tui.requestRender();
			return;
		}
		if (data === "s") {
			this.switchScope(cycleOverlayDiffScope(st.scope), tui);
			tui.requestRender();
			return;
		}
		if (data === "w") {
			st.wrapLines = !st.wrapLines;
			tui.requestRender();
			return;
		}
		if (data === "c") {
			st.changedOnly = !st.changedOnly;
			tui.requestRender();
			return;
		}
		if (data === "r") {
			this.openReviewDraftInput();
			tui.requestRender();
			return;
		}

		if (st.focus === "left") {
			if (matchesKey(data, Key.escape)) {
				this.closeOverlay();
				return;
			}
			if (matchesKey(data, Key.up) || data === "k") {
				if (st.selectedIndex > 0) {
					st.selectedIndex -= 1;
					this.syncSelectedFile(tui);
				}
			} else if (matchesKey(data, Key.down) || data === "j") {
				if (st.selectedIndex < n - 1) {
					st.selectedIndex += 1;
					this.syncSelectedFile(tui);
				}
			} else if (data === "g") {
				st.selectedIndex = 0;
				this.syncSelectedFile(tui);
			} else if (data === "G") {
				st.selectedIndex = Math.max(0, n - 1);
				this.syncSelectedFile(tui);
			} else if (matchesKey(data, Key.enter)) {
				if (currentRow?.type === "dir") {
					if (st.expandedDirs.has(currentRow.fullPath)) st.expandedDirs.delete(currentRow.fullPath);
					else st.expandedDirs.add(currentRow.fullPath);
				} else if (currentRow?.type === "file") {
					this.selectDiffFile(currentRow.fullPath, tui);
					st.focus = "right";
				}
			} else if (data === "o" && f) {
				void this.openPath(f.path).then(() => tui.requestRender());
			} else if (data === "f" && f) {
				void this.revealPath(f.path).then(() => tui.requestRender());
			}

			tui.requestRender();
			return;
		}

		if (matchesKey(data, Key.escape)) {
			saveDiffScroll(st);
			st.focus = "left";
			tui.requestRender();
			return;
		}

		const raw = f ? (st.diffCache.get(scopedDiffKey(st.scope, f.path)) ?? "") : "";
		const parsed = parseDiffLines(raw);
		const highlighted = f ? (st.highlightedDiffCache.get(scopedDiffKey(st.scope, f.path)) ?? raw.split("\n")) : [];
		const diffLen = countRenderedDiffLines(
			highlighted,
			parsed,
			Math.max(1, this.lastRightWidth),
			st.wrapLines,
			st.changedOnly,
		);
		if (matchesKey(data, Key.up)) {
			st.diffScrollOffset = Math.max(0, st.diffScrollOffset - ARROW_SCROLL_STEP);
		} else if (matchesKey(data, Key.down)) {
			st.diffScrollOffset = Math.min(st.diffScrollOffset + ARROW_SCROLL_STEP, Math.max(0, diffLen - 3));
		} else if (data === "k") {
			st.diffScrollOffset = Math.max(0, st.diffScrollOffset - 1);
		} else if (data === "j") {
			st.diffScrollOffset = Math.min(st.diffScrollOffset + 1, Math.max(0, diffLen - 3));
		} else if (matchesKey(data, Key.pageUp) || matchesKey(data, Key.ctrl("u"))) {
			st.diffScrollOffset = Math.max(0, st.diffScrollOffset - PAGE_SCROLL_STEP);
		} else if (matchesKey(data, Key.pageDown) || matchesKey(data, Key.ctrl("d"))) {
			st.diffScrollOffset = Math.min(st.diffScrollOffset + PAGE_SCROLL_STEP, Math.max(0, diffLen - 3));
		} else if (data === "g") {
			st.diffScrollOffset = 0;
		} else if (data === "G") {
			st.diffScrollOffset = Math.max(0, diffLen - 3);
		} else if (matchesKey(data, Key.left)) {
			saveDiffScroll(st);
			st.focus = "left";
		} else if (data === "o" && f) {
			void this.openPath(f.path).then(() => tui.requestRender());
		} else if (data === "f" && f) {
			void this.revealPath(f.path).then(() => tui.requestRender());
		}

		saveDiffScroll(st);
		tui.requestRender();
	}

	// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: commit-mode navigation combines selection and viewport rules for predictable arrow-key behavior.
	private handleCommitModeInput(data: string, tui: Tui): void {
		const st = this.st;

		if (st.focus === "left") {
			if (matchesKey(data, Key.escape)) {
				this.closeOverlay();
				return;
			}

			if (matchesKey(data, Key.up) || data === "k") {
				this.selectCommit(st.commitSelectedIndex - 1, tui);
			} else if (matchesKey(data, Key.down) || data === "j") {
				this.selectCommit(st.commitSelectedIndex + 1, tui);
			} else if (matchesKey(data, Key.pageUp) || matchesKey(data, Key.ctrl("u"))) {
				this.selectCommit(st.commitSelectedIndex - 10, tui);
			} else if (matchesKey(data, Key.pageDown) || matchesKey(data, Key.ctrl("d"))) {
				this.selectCommit(st.commitSelectedIndex + 10, tui);
			} else if (data === "g") {
				this.selectCommit(0, tui);
			} else if (data === "G") {
				this.selectCommit(Math.max(0, st.commits.length - 1), tui);
			} else if (matchesKey(data, Key.enter)) {
				st.focus = "right";
				this.resetCommitFilesPanel();
				void this.ensureCommitFiles(tui);
			}

			tui.requestRender();
			return;
		}

		if (matchesKey(data, Key.escape) || matchesKey(data, Key.left)) {
			st.focus = "left";
			tui.requestRender();
			return;
		}

		const commit = this.selectedCommit();
		if (!commit) {
			tui.requestRender();
			return;
		}

		void this.ensureCommitFiles(tui);
		const files = st.commitFilesCache.get(commit.hash);
		if (!files || files.length === 0) {
			tui.requestRender();
			return;
		}

		const maxIndex = files.length - 1;
		st.commitFileSelectedIndex = clamp(st.commitFileSelectedIndex, 0, maxIndex);
		const selectedIndex = st.commitFileSelectedIndex;
		const selectedFile = files[selectedIndex];
		const expanded = this.expandedSet(commit.hash);
		const selectedExpanded = Boolean(selectedFile && expanded.has(selectedFile.path));

		const contentH = overlayContentHeight(tui.terminal?.rows ?? 40);
		const rowsMeta = buildCommitRowsMeta(files, commit.hash, expanded, st.commitFileDiffCache);
		const maxOffset = Math.max(0, rowsMeta.totalRows - contentH);
		st.commitFileScrollOffset = clamp(st.commitFileScrollOffset, 0, maxOffset);
		const viewportStart = st.commitFileScrollOffset;
		const viewportEnd = viewportStart + contentH - 1;

		const prevIndex = selectedIndex - 1;
		const nextIndex = selectedIndex + 1;
		const prevStart = prevIndex >= 0 ? (rowsMeta.fileStarts[prevIndex] ?? 0) : -1;
		const nextStart =
			nextIndex <= maxIndex ? (rowsMeta.fileStarts[nextIndex] ?? rowsMeta.totalRows) : rowsMeta.totalRows;
		const selectedStart = rowsMeta.fileStarts[selectedIndex] ?? 0;
		const selectedEnd = rowsMeta.fileEnds[selectedIndex] ?? selectedStart;

		const shouldArrowUpScroll =
			selectedExpanded &&
			st.commitFileScrollOffset > 0 &&
			((prevIndex >= 0 && prevStart < viewportStart) || (prevIndex < 0 && selectedStart < viewportStart));
		const shouldArrowDownScroll =
			selectedExpanded &&
			st.commitFileScrollOffset < maxOffset &&
			((nextIndex <= maxIndex && nextStart > viewportEnd) || (nextIndex > maxIndex && selectedEnd > viewportEnd));

		if (matchesKey(data, Key.up)) {
			if (shouldArrowUpScroll) {
				st.commitFileScrollOffset = Math.max(0, st.commitFileScrollOffset - ARROW_SCROLL_STEP);
				st.commitFileManualScroll = true;
			} else {
				st.commitFileSelectedIndex = clamp(selectedIndex - 1, 0, maxIndex);
				st.commitFileManualScroll = false;
			}
		} else if (matchesKey(data, Key.down)) {
			if (shouldArrowDownScroll) {
				st.commitFileScrollOffset = Math.min(maxOffset, st.commitFileScrollOffset + ARROW_SCROLL_STEP);
				st.commitFileManualScroll = true;
			} else {
				st.commitFileSelectedIndex = clamp(selectedIndex + 1, 0, maxIndex);
				st.commitFileManualScroll = false;
			}
		} else if (data === "k") {
			st.commitFileSelectedIndex = clamp(selectedIndex - 1, 0, maxIndex);
			st.commitFileManualScroll = false;
		} else if (data === "j") {
			st.commitFileSelectedIndex = clamp(selectedIndex + 1, 0, maxIndex);
			st.commitFileManualScroll = false;
		} else if (matchesKey(data, Key.pageUp) || matchesKey(data, Key.ctrl("u"))) {
			st.commitFileScrollOffset = Math.max(0, st.commitFileScrollOffset - PAGE_SCROLL_STEP);
			st.commitFileManualScroll = true;
		} else if (matchesKey(data, Key.pageDown) || matchesKey(data, Key.ctrl("d"))) {
			st.commitFileScrollOffset = Math.min(maxOffset, st.commitFileScrollOffset + PAGE_SCROLL_STEP);
			st.commitFileManualScroll = true;
		} else if (data === "g") {
			st.commitFileSelectedIndex = 0;
			st.commitFileManualScroll = false;
		} else if (data === "G") {
			st.commitFileSelectedIndex = maxIndex;
			st.commitFileManualScroll = false;
		} else if (matchesKey(data, Key.enter)) {
			const file = files[st.commitFileSelectedIndex];
			if (file) {
				if (expanded.has(file.path)) {
					expanded.delete(file.path);
				} else {
					expanded.add(file.path);
					void this.ensureCommitFileDiff(commit.hash, file, tui);
				}
				st.commitFileManualScroll = false;
			}
		} else if (data === "o") {
			const file = this.selectedCommitFile();
			if (file) void this.openPath(file.path).then(() => tui.requestRender());
		} else if (data === "f") {
			const file = this.selectedCommitFile();
			if (file) void this.revealPath(file.path).then(() => tui.requestRender());
		}

		tui.requestRender();
	}

	handleInput(data: string, tui: Tui): void {
		if (data === "q" && !this.st.searchMode && !this.st.reviewInput.active) {
			this.closeOverlay();
			return;
		}

		if (this.st.viewMode === "diff" && (this.st.searchMode || this.st.reviewInput.active)) {
			this.handleDiffModeInput(data, tui);
			return;
		}

		if (data === "S") {
			void this.stashChanges(tui).then(() => tui.requestRender());
			return;
		}

		if (matchesKey(data, Key.tab) || data === "v") {
			this.st.viewMode = toggleOverlayViewMode(this.st.viewMode);
			this.st.focus = "left";
			if (this.st.viewMode === "diff") {
				void this.ensureDiff(tui);
			} else {
				this.resetCommitFilesPanel();
				void this.ensureCommitFiles(tui);
			}
			tui.requestRender();
			return;
		}

		if (this.st.viewMode === "diff") this.handleDiffModeInput(data, tui);
		else this.handleCommitModeInput(data, tui);
	}

	// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: frame rendering composes multiple panes and headers in one pass for width-aware alignment.
	render(w: number, h: number, t: Theme): string[] {
		const st = this.st;

		const header: string[] = [];
		header.push(...new DynamicBorder((s: string) => t.fg("accent", s)).render(w));

		const branch = st.branch ? t.fg("muted", st.branch) : t.fg("dim", "(detached)");
		const baseInfo = st.baseBranch ? ` ${t.fg("dim", "vs")} ${t.fg("muted", st.baseBranch)}` : "";
		const scopeFileCount = st.filesByScope[st.scope].length;
		const fileCnt = t.fg(
			"muted",
			st.searchQuery
				? `${st.files.length}/${scopeFileCount} file${scopeFileCount !== 1 ? "s" : ""}`
				: `${scopeFileCount} file${scopeFileCount !== 1 ? "s" : ""}`,
		);
		const commitCnt = t.fg("muted", `${st.commits.length} commit${st.commits.length !== 1 ? "s" : ""}`);
		const mode = st.viewMode === "diff" ? t.fg("accent", "diff") : t.fg("accent", "commit");
		header.push(
			`  ${t.fg("accent", t.bold("DIFF"))} ${t.fg("dim", "|")} ${branch}${baseInfo} ${t.fg("dim", "·")} ${fileCnt} ${t.fg("dim", "·")} ${commitCnt} ${t.fg("dim", "·")} mode:${mode}`,
		);
		header.push(
			`  ${t.fg("dim", "scope:")}${t.fg("muted", scopeLabel(st.scope))} ${t.fg("dim", "· filter:")}${t.fg(st.searchMode ? "accent" : "muted", st.searchQuery || "-")} ${t.fg("dim", "· wrap:")}${t.fg(st.wrapLines ? "success" : "muted", st.wrapLines ? "on" : "off")} ${t.fg("dim", "· changed-only:")}${t.fg(st.changedOnly ? "success" : "muted", st.changedOnly ? "on" : "off")} ${t.fg("dim", "· reviews:")}${t.fg(st.reviewDrafts.length > 0 ? "accent" : "muted", String(st.reviewDrafts.length))}`,
		);

		const footer: string[] = [];
		if (st.reviewInput.active) {
			footer.push(
				truncateToWidth(
					`  ${t.fg("accent", "review>")} ${st.reviewInput.buffer || t.fg("dim", "type review message (line numbers go here too)")}`,
					w,
				),
			);
			footer.push(st.reviewInput.error ? t.fg("error", `  ${st.reviewInput.error}`) : "");
		} else {
			footer.push(st.error ? t.fg("error", `  ${st.error}`) : "");
		}

		const hint =
			st.viewMode === "diff"
				? st.reviewInput.active
					? `  Review draft · type message · Enter save · Esc cancel`
					: st.searchMode
						? "  Search mode · type to filter · Backspace delete · Enter/Esc close"
						: st.focus === "left"
							? "  ↑/↓ Select File  ·  / Search  ·  s Scope  ·  w Wrap  ·  c Changed-only  ·  r Review draft  ·  Enter → Diff  ·  Tab/v Commit  ·  o Open  ·  f Finder  ·  S Stash  ·  q/Esc Close"
							: "  ↑/↓ Scroll 5 lines  ·  j/k Scroll 1 line  ·  PgUp/PgDn Fast  ·  / Search  ·  s Scope  ·  w Wrap  ·  c Changed-only  ·  r Review draft  ·  Tab/v Commit  ·  o Open  ·  f Finder  ·  ←/Esc → Files  ·  q Close"
				: st.focus === "left"
					? "  ↑/↓ Select Commit  ·  Enter → Changed Files  ·  Tab/v Toggle Diff  ·  S Stash  ·  q/Esc Close"
					: "  ↑/↓ Select (overflow 시 5-line scroll)  ·  j/k Select File  ·  Enter Fold/Unfold Diff  ·  PgUp/PgDn Scroll  ·  Tab/v Toggle Diff  ·  o Open  ·  f Finder  ·  ←/Esc → Commits  ·  q Close";
		footer.push(t.fg("dim", hint));
		footer.push(...new DynamicBorder((s: string) => t.fg("accent", s)).render(w));

		const bodyH = Math.max(3, h - header.length - footer.length);
		const leftW = Math.max(14, Math.min(Math.floor(w * 0.28), 44));
		const rightW = Math.max(10, w - leftW - 3);
		this.lastRightWidth = rightW;

		const leftTitleLabel = st.viewMode === "diff" ? ` FILES · ${scopeFilesLabel(st.scope)}` : " COMMITS";
		const rightTitleLabel = st.viewMode === "diff" ? " DIFF" : " CHANGED FILES";
		const leftTitle = st.focus === "left" ? t.fg("accent", t.bold(leftTitleLabel)) : t.fg("dim", leftTitleLabel);
		const rightTitle = st.focus === "right" ? t.fg("accent", t.bold(rightTitleLabel)) : t.fg("dim", rightTitleLabel);

		const selectedFile = findFileByPath(st, st.selectedFilePath);
		const selectedFileReviewCount = selectedFile
			? st.reviewDrafts.filter((draft) => draft.filePath === selectedFile.path).length
			: 0;
		const fileLabel = selectedFile
			? `${t.fg(statusColor(selectedFile.status), icon(selectedFile.status))} ${t.fg(commitStateColor(selectedFile.commitState), `[${commitStateBadge(selectedFile.commitState)}]`)} ${t.fg(selectedFileReviewCount > 0 ? "accent" : "dim", selectedFileReviewCount > 0 ? `${selectedFileReviewCount} review${selectedFileReviewCount !== 1 ? "s" : ""}` : "no reviews")} ${t.fg("muted", fileDisplayPath(selectedFile))}`
			: t.fg("muted", "(no file)");

		const selectedCommit = st.commits[st.commitSelectedIndex];
		let commitLabel = t.fg("muted", "(no commit)");
		if (selectedCommit) {
			const commitFiles = st.commitFilesCache.get(selectedCommit.hash);
			const filesInfo = commitFiles
				? `${commitFiles.length} file${commitFiles.length !== 1 ? "s" : ""}`
				: st.commitFilesLoading.has(selectedCommit.hash)
					? "loading files…"
					: "files: -";
			if (selectedCommit.hash === UNCOMMITTED_HASH) {
				commitLabel = `${t.fg("warning", "●●●")} ${t.fg("warning", selectedCommit.subject)} ${t.fg("dim", `· ${filesInfo}`)}`;
			} else {
				commitLabel = `${t.fg("muted", selectedCommit.shortHash)} ${t.fg("text", selectedCommit.subject)} ${t.fg("dim", `· ${filesInfo}`)}`;
			}
		}

		const rightHeader = st.viewMode === "diff" ? `${rightTitle} ${fileLabel}` : `${rightTitle} ${commitLabel}`;
		const fittedLeftTitle = truncateToWidth(leftTitle, leftW, "");
		const fittedRightHeader = truncateToWidth(rightHeader, rightW, t.fg("muted", "..."));
		const titleLine = `${fittedLeftTitle}${" ".repeat(Math.max(0, leftW - visibleWidth(fittedLeftTitle)))} ${t.fg("dim", "│")} ${fittedRightHeader}`;

		const separatorLine = `${t.fg("dim", "─".repeat(leftW))} ${t.fg("dim", "┼")} ${t.fg("dim", "─".repeat(rightW))}`;
		const contentH = Math.max(1, bodyH - 2);

		const left = st.viewMode === "diff" ? renderFiles(t, st, leftW, contentH) : renderCommits(t, st, leftW, contentH);
		const right =
			st.viewMode === "diff" ? renderDiff(t, st, rightW, contentH) : renderCommitFiles(t, st, rightW, contentH);

		while (left.length < contentH) left.push("");
		while (right.length < contentH) right.push("");

		const body: string[] = [titleLine, separatorLine];
		for (let i = 0; i < contentH; i++) {
			const l = truncateToWidth(left[i] ?? "", leftW, "");
			const pad = Math.max(0, leftW - visibleWidth(l));
			const r = truncateToWidth(right[i] ?? "", rightW, "");
			body.push(`${l}${" ".repeat(pad)} ${t.fg("dim", "│")} ${r}`);
		}

		return [...header, ...body, ...footer].map((line) => truncateToWidth(expandTabs(line), w, ""));
	}
}
