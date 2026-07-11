import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { truncatePlainToWidth } from "../utils/format-utils.js";
import { commitStateBadge, parseDiffLines } from "./diff-overlay-utils.js";
import {
	buildCommitRenderedDiffLines,
	buildHighlightedDiff,
	buildRenderedDiffLines,
	clamp,
	commitDiffKey,
	commitStateColor,
	fileDisplayPath,
	fileTreeLabel,
	findFileByPath,
	getVisibleRows,
	icon,
	scopedDiffKey,
	statusColor,
	UNCOMMITTED_HASH,
} from "./overlay-utils.js";
import type { DiffState, Theme } from "./types.js";

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: tree row rendering keeps selection and styling logic in one place for overlay consistency.
export function renderFiles(t: Theme, st: DiffState, w: number, h: number): string[] {
	const visibleRows = getVisibleRows(st);
	if (visibleRows.length === 0) {
		return [t.fg("muted", st.searchQuery ? ` (no files match: ${st.searchQuery})` : " (no changes)")];
	}

	const active = st.focus === "left";
	const max = Math.max(1, h);

	st.selectedIndex = clamp(st.selectedIndex, 0, Math.max(0, visibleRows.length - 1));
	if (st.selectedIndex < st.fileScrollOffset) st.fileScrollOffset = st.selectedIndex;
	if (st.selectedIndex >= st.fileScrollOffset + max) st.fileScrollOffset = st.selectedIndex - max + 1;

	const start = st.fileScrollOffset;
	const end = Math.min(visibleRows.length, start + max);
	const lines: string[] = [];

	const fileByPath = new Map(st.files.map((f) => [f.path, f]));

	for (let i = start; i < end; i++) {
		const row = visibleRows[i];
		const sel = i === st.selectedIndex;
		const indent = " ".repeat(row.depth * 2);
		const cursor = sel ? (active ? t.fg("accent", "▶") : t.fg("muted", "▸")) : " ";

		if (row.type === "dir") {
			const fold = row.expanded ? "▾" : "▸";
			const foldColored = row.expanded ? t.fg("accent", fold) : t.fg("dim", fold);
			const prefix = `${cursor} ${indent}${foldColored} `;
			const nameW = Math.max(4, w - visibleWidth(prefix) - 1);
			const dirLabel = truncatePlainToWidth(`${row.name}/`, nameW);
			const dirName =
				sel && active ? t.fg("accent", t.bold(dirLabel)) : sel ? t.fg("muted", dirLabel) : t.fg("muted", dirLabel);
			lines.push(truncateToWidth(`${prefix}${dirName}`, w, ""));
		} else {
			const file = fileByPath.get(row.fullPath);
			const reviewCount = file ? st.reviewDrafts.filter((draft) => draft.filePath === file.path).length : 0;
			const reviewMark = reviewCount > 0 ? t.fg("accent", String(reviewCount)) : t.fg("dim", "·");
			const ic = file ? t.fg(statusColor(file.status), icon(file.status)) : " ";
			const badge = file ? t.fg(commitStateColor(file.commitState), `[${commitStateBadge(file.commitState)}]`) : "";
			const prefix = `${cursor} ${indent}${reviewMark} ${ic} ${badge} `;
			const nameW = Math.max(4, w - visibleWidth(prefix));
			const fileName = file ? fileTreeLabel(file, row.name) : row.name;

			let label: string;
			const fileLabel = truncatePlainToWidth(fileName, nameW);
			if (sel && active) {
				label = t.fg("accent", fileLabel);
			} else if (sel) {
				label = t.fg("muted", fileLabel);
			} else {
				label = t.fg("text", fileLabel);
			}
			lines.push(truncateToWidth(`${prefix}${label}`, w, ""));
		}
	}

	if (visibleRows.length > max) {
		const info = t.fg("dim", ` ${start + 1}–${end}/${visibleRows.length}`);
		while (lines.length < max) lines.push("");
		lines[max - 1] = info;
	}

	while (lines.length < max) lines.push("");
	return lines;
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: commit row rendering intentionally mirrors diff-pane selection semantics.
export function renderCommits(t: Theme, st: DiffState, w: number, h: number): string[] {
	if (st.commits.length === 0) return [t.fg("muted", " (no commits in branch scope)")];

	const active = st.focus === "left";
	const max = Math.max(1, h);
	st.commitSelectedIndex = clamp(st.commitSelectedIndex, 0, Math.max(0, st.commits.length - 1));

	if (st.commitSelectedIndex < st.commitScrollOffset) st.commitScrollOffset = st.commitSelectedIndex;
	if (st.commitSelectedIndex >= st.commitScrollOffset + max) st.commitScrollOffset = st.commitSelectedIndex - max + 1;

	const start = st.commitScrollOffset;
	const end = Math.min(st.commits.length, start + max);
	const lines: string[] = [];

	for (let i = start; i < end; i++) {
		const c = st.commits[i];
		const sel = i === st.commitSelectedIndex;
		const cursor = sel ? (active ? t.fg("accent", "▶") : t.fg("muted", "▸")) : " ";
		const isUncommitted = c.hash === UNCOMMITTED_HASH;

		if (isUncommitted) {
			const marker = t.fg(sel && active ? "accent" : "warning", "●●●");
			const prefix = `${cursor} ${marker} `;
			const subjectW = Math.max(4, w - visibleWidth(prefix));
			const subjectText = truncatePlainToWidth(c.subject, subjectW);
			const subject = sel && active ? t.fg("accent", subjectText) : t.fg("warning", subjectText);
			lines.push(truncateToWidth(`${prefix}${subject}`, w, ""));
		} else {
			const hash = t.fg(sel && active ? "accent" : "muted", c.shortHash);
			const prefix = `${cursor} ${hash} `;
			const subjectW = Math.max(4, w - visibleWidth(prefix));
			const subjectText = truncatePlainToWidth(c.subject, subjectW);
			const subject = sel && active ? t.fg("accent", subjectText) : t.fg("text", subjectText);
			lines.push(truncateToWidth(`${prefix}${subject}`, w, ""));
		}
	}

	if (st.commits.length > max) {
		const info = t.fg("dim", ` ${start + 1}–${end}/${st.commits.length}`);
		while (lines.length < max) lines.push("");
		lines[max - 1] = info;
	}

	while (lines.length < max) lines.push("");
	return lines;
}

export function renderDiff(t: Theme, st: DiffState, w: number, h: number): string[] {
	if (st.files.length === 0) return [t.fg("muted", "  No changes")];

	const f = findFileByPath(st, st.selectedFilePath);
	if (!f) return [t.fg("muted", "  Select a file to view diff")];

	const diffKey = scopedDiffKey(st.scope, f.path);
	const raw = st.diffCache.get(diffKey);
	if (raw === undefined) return [t.fg("muted", "  Loading…")];

	// Build syntax-highlighted lines on first render (lazy, cached)
	if (!st.highlightedDiffCache.has(diffKey)) {
		st.highlightedDiffCache.set(diffKey, buildHighlightedDiff(raw, f.path, t));
	}
	const all = st.highlightedDiffCache.get(diffKey);
	if (!all || all.length === 0) return [t.fg("muted", "  (empty diff)")];
	const parsed = parseDiffLines(raw);

	const rendered = buildRenderedDiffLines(t, all, parsed, w, st.wrapLines, st.changedOnly);
	if (rendered.length === 0) return [t.fg("muted", "  (all context hidden by filter)")];

	const max = Math.max(1, h);
	const maxOffset = Math.max(0, rendered.length - max);
	if (st.diffScrollOffset > maxOffset) st.diffScrollOffset = maxOffset;

	const start = st.diffScrollOffset;
	const end = Math.min(rendered.length, start + max);

	const lines: string[] = [];
	for (let i = start; i < end; i++) {
		const line = rendered[i];
		if (!line) continue;
		if (line.category === "added") {
			lines.push(t.bg("toolSuccessBg", line.text));
		} else if (line.category === "removed") {
			lines.push(t.bg("toolErrorBg", line.text));
		} else {
			lines.push(line.text);
		}
	}

	while (lines.length < max) lines.push("");

	if (rendered.length > max) {
		const pct = maxOffset > 0 ? Math.round((st.diffScrollOffset / maxOffset) * 100) : 0;
		const indicator = t.fg("dim", `${pct}% (${start + 1}–${end}/${rendered.length})`);
		lines[max - 1] = truncateToWidth(` ${indicator}`, w, t.fg("dim", "..."));
	}

	return lines;
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: commit file pane interleaves fold state and inline diff rows for TUI rendering.
export function renderCommitFiles(t: Theme, st: DiffState, w: number, h: number): string[] {
	const selectedCommit = st.commits[st.commitSelectedIndex];
	if (!selectedCommit) return [t.fg("muted", "  (no commit selected)")];

	const commitHash = selectedCommit.hash;
	const files = st.commitFilesCache.get(commitHash);
	if (!files) {
		return [
			t.fg(
				"muted",
				st.commitFilesLoading.has(commitHash) ? "  Loading changed files…" : "  (press Enter to load files)",
			),
		];
	}
	if (files.length === 0) return [t.fg("muted", "  (no changed files)")];

	st.commitFileSelectedIndex = clamp(st.commitFileSelectedIndex, 0, Math.max(0, files.length - 1));
	const expanded = st.commitExpandedByHash.get(commitHash) ?? new Set<string>();
	const active = st.focus === "right";

	const rows: string[] = [];
	const fileLineStart: number[] = [];

	for (let i = 0; i < files.length; i++) {
		const file = files[i];
		const selected = i === st.commitFileSelectedIndex;
		fileLineStart[i] = rows.length;

		const cursor = selected ? (active ? t.fg("accent", "▶") : t.fg("muted", "▸")) : " ";
		const fold = expanded.has(file.path) ? t.fg("accent", "▾") : t.fg("dim", "▸");
		const ic = t.fg(statusColor(file.status), icon(file.status));
		const prefix = `${cursor} ${fold} ${ic} `;
		const nameW = Math.max(4, w - visibleWidth(prefix));

		const fileName = truncatePlainToWidth(fileDisplayPath(file), nameW);
		const label = selected ? (active ? t.fg("accent", fileName) : t.fg("muted", fileName)) : t.fg("text", fileName);
		rows.push(truncateToWidth(`${prefix}${label}`, w, ""));

		if (!expanded.has(file.path)) continue;

		const diffKey = commitDiffKey(commitHash, file.path);
		const raw = st.commitFileDiffCache.get(diffKey);
		if (raw === undefined) {
			const loading = st.commitFileDiffLoading.has(diffKey) ? "    Loading diff…" : "    (no diff loaded)";
			rows.push(t.fg("muted", truncatePlainToWidth(loading, w)));
			continue;
		}

		const renderedDiffLines = buildCommitRenderedDiffLines(t, raw, w);
		if (renderedDiffLines.length === 0) {
			rows.push(t.fg("muted", "    (empty diff)"));
			continue;
		}

		for (const line of renderedDiffLines) {
			if (line.category === "added") {
				rows.push(t.bg("toolSuccessBg", line.text));
			} else if (line.category === "removed") {
				rows.push(t.bg("toolErrorBg", line.text));
			} else {
				rows.push(line.text);
			}
		}
	}

	const max = Math.max(1, h);
	const selectedLine = fileLineStart[st.commitFileSelectedIndex] ?? 0;
	if (!st.commitFileManualScroll) {
		if (selectedLine < st.commitFileScrollOffset) st.commitFileScrollOffset = selectedLine;
		if (selectedLine >= st.commitFileScrollOffset + max) st.commitFileScrollOffset = selectedLine - max + 1;
	}

	const maxOffset = Math.max(0, rows.length - max);
	if (st.commitFileScrollOffset < 0) st.commitFileScrollOffset = 0;
	if (st.commitFileScrollOffset > maxOffset) st.commitFileScrollOffset = maxOffset;

	const start = st.commitFileScrollOffset;
	const end = Math.min(rows.length, start + max);
	const visible = rows.slice(start, end);

	while (visible.length < max) visible.push("");
	if (rows.length > max) {
		const info = t.fg("dim", ` ${start + 1}–${end}/${rows.length}`);
		visible[max - 1] = info;
	}

	return visible;
}
