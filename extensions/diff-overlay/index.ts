/**
 * /diff — Git diff overlay
 *
 * Split-pane view with mode toggle:
 * - Diff mode: left = changed files, right = aggregated file diff (current behavior)
 * - Commit mode: left = commits, right = changed files per selected commit (fold/expand)
 *
 * Global: Tab / v toggles Diff ↔ Commit mode
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { flattenVisibleTree, type OverlayDiffScope } from "./diff-overlay-utils.js";
import { currentBranch, fileDiff, findMergeBase, gitRoot, loadOverlayData } from "./git.js";
import { icon, rebuildTree, scopedDiffKey, UNCOMMITTED_HASH } from "./overlay-utils.js";
import { DiffOverlay } from "./overlay.js";
import type { DiffState, Tui } from "./types.js";

// ─── Extension ─────────────────────────────────────────────────────────────

export default function diffOverlayExtension(pi: ExtensionAPI) {
	// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: command bootstrap assembles repo state, caches, and UI fallback in one flow.
	const handler = async (_args: string, ctx: ExtensionCommandContext) => {
		const root = await gitRoot(pi, ctx.cwd);
		if (!root) {
			if (ctx.hasUI) ctx.ui.notify("Not a git repository", "error");
			// biome-ignore lint/suspicious/noConsole: non-UI fallback needs plain terminal output.
			else console.log("Not a git repository");
			return;
		}

		const branch = await currentBranch(pi, root);
		const mergeBaseInfo = await findMergeBase(pi, root, branch);
		const mergeBase = mergeBaseInfo?.commit ?? null;
		const overlayData = await loadOverlayData(pi, root, mergeBase);
		const commits = [...overlayData.commits];
		const workingFiles = overlayData.filesByScope.working;
		const initialScope: OverlayDiffScope =
			overlayData.filesByScope.branch.length > 0 ? "branch" : workingFiles.length > 0 ? "working" : "last-commit";
		const files = overlayData.filesByScope[initialScope];
		const { treeNodes, expandedDirs } = rebuildTree(files);
		const firstVisibleRows = flattenVisibleTree(treeNodes, expandedDirs);
		const firstFileRow = firstVisibleRows.find((r) => r.type === "file");
		const initialSelectedFilePath = firstFileRow ? firstFileRow.fullPath : files.length > 0 ? files[0].path : null;

		if (overlayData.uncommittedFiles.length > 0) {
			commits.unshift({
				hash: UNCOMMITTED_HASH,
				shortHash: "•••",
				author: "",
				relativeDate: "now",
				subject: `Uncommitted Changes (${overlayData.uncommittedFiles.length} file${overlayData.uncommittedFiles.length !== 1 ? "s" : ""})`,
			});
		}

		const st: DiffState = {
			files,
			filesByScope: overlayData.filesByScope,
			scope: initialScope,
			searchQuery: "",
			searchMode: false,
			selectedIndex: 0,
			fileScrollOffset: 0,
			diffCache: new Map(),
			highlightedDiffCache: new Map(),
			diffScrollOffset: 0,
			diffScrollMemory: new Map(),
			selectedFilePathByScope: {
				branch: initialScope === "branch" ? initialSelectedFilePath : null,
				working: initialScope === "working" ? initialSelectedFilePath : null,
				"last-commit": initialScope === "last-commit" ? initialSelectedFilePath : null,
			},
			wrapLines: true,
			changedOnly: false,
			reviewDrafts: [],
			reviewInput: { active: false, buffer: "", error: null },

			treeNodes,
			expandedDirs,
			selectedFilePath: initialSelectedFilePath,

			commits,
			commitSelectedIndex: 0,
			commitScrollOffset: 0,
			commitFilesCache: new Map(),
			commitFilesLoading: new Set(),
			commitFileDiffCache: new Map(),
			commitFileDiffLoading: new Set(),
			commitExpandedByHash: new Map(),
			commitFileSelectedIndex: 0,
			commitFileScrollOffset: 0,
			commitFileManualScroll: false,

			viewMode: "diff",
			focus: "left",
			branch,
			mergeBase,
			baseBranch: mergeBaseInfo?.baseBranch ?? null,
			error: null,
		};

		// Pre-populate uncommitted files cache for commit mode
		if (overlayData.uncommittedFiles.length > 0) {
			st.commitFilesCache.set(
				UNCOMMITTED_HASH,
				overlayData.uncommittedFiles.map((f) => ({
					path: f.path,
					status: f.status,
					rawStatus: f.rawStatus,
					previousPath: f.previousPath ?? null,
				})),
			);
		}

		if (!ctx.hasUI) {
			if (files.length === 0) {
				// biome-ignore lint/suspicious/noConsole: non-UI fallback needs plain terminal output.
				console.log("No changes.");
				return;
			}
			// biome-ignore lint/suspicious/noConsole: non-UI fallback lists changed files in the terminal.
			for (const f of files) console.log(`${icon(f.status)} ${f.path}`);
			return;
		}

		if (st.selectedFilePath) {
			const firstFile = files.find((f) => f.path === st.selectedFilePath);
			if (firstFile) {
				st.diffCache.set(
					scopedDiffKey(st.scope, firstFile.path),
					await fileDiff(pi, root, firstFile, st.scope, mergeBase),
				);
			}
		}

		const reviewPrompt = await ctx.ui.custom<string | undefined>(
			(tui, theme, _kb, done) => {
				const overlay = new DiffOverlay(pi, root, st, (prompt) => done(prompt));
				const tuiRef = tui as Tui;
				return {
					render: (w) => overlay.render(w, tuiRef.terminal?.rows ?? 40, theme),
					handleInput: (data) => overlay.handleInput(data, tuiRef),
					invalidate: () => {},
				};
			},
			{ overlay: true, overlayOptions: { width: "100%", maxHeight: "100%", anchor: "center" } },
		);
		if (reviewPrompt) {
			ctx.ui.setEditorText(reviewPrompt);
			ctx.ui.notify("Moved review feedback into the editor.", "info");
		}
	};

	pi.registerCommand("diff", {
		description: "Git diff viewer — diff mode + commit mode (per-commit foldable file diffs)",
		handler,
	});
}
