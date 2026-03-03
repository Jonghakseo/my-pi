/**
 * Blueprint DAG Viewer — TUI overlay for visualizing Blueprint execution
 * as a stage-based directed acyclic graph.
 *
 * Renders blueprint nodes grouped by topological depth (stages),
 * showing parallel execution, dependencies, and real-time status.
 *
 * Layout:
 *   ┌─────────────────────────────────────────────────────────────┐
 *   │  📋 Blueprint Title                        [3/5] running   │
 *   │  ID: bp-1709449200000                                      │
 *   │─────────────────────────────────────────────────────────────│
 *   │  STAGE 1       STAGE 2          STAGE 3        STAGE 4     │
 *   │  ──────────    ──────────       ──────────     ──────────   │
 *   │  ✓ plan-1  ─→  ✓ challenge ─→  ⠹ impl-A  ─→  ○ review    │
 *   │                              ─→  ⠹ impl-B  ─↗             │
 *   │─────────────────────────────────────────────────────────────│
 *   │  ▶ impl-A  implement/high → worker                        │
 *   │    Task: 인증 미들웨어 리팩토링                               │
 *   │    Deps: challenge-1                                       │
 *   │    ⏱ 3m 12s elapsed                                       │
 *   │─────────────────────────────────────────────────────────────│
 *   │  ↑↓/jk select  r refresh  q/Esc close                     │
 *   └─────────────────────────────────────────────────────────────┘
 *
 * Usage: /blueprint [blueprintId]
 */

import { Container, Key, matchesKey, Spacer, Text, truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";
import { loadBlueprint } from "./blueprint.js";
import type { Blueprint, BlueprintNode } from "./types.js";

// ─── DAG Layout Computation ──────────────────────────────────────────────────

interface StageLayout {
	/** Nodes grouped by topological depth */
	stages: BlueprintNode[][];
	/** Depth (stage index) for each node ID */
	nodeDepths: Map<string, number>;
	/** Flattened nodes in stage-order (left→right, top→bottom within stage) */
	flatOrder: BlueprintNode[];
}

/**
 * Compute topological depths and group nodes into stages.
 * Nodes with no dependencies → stage 0.
 * Otherwise → max(dependency depths) + 1.
 *
 * Cycle guard: each top-level call starts with a fresh `visiting` Set.
 * Recursive DFS calls pass a growing Set so cycles are detected and
 * broken by returning depth 0 (rather than infinite-looping).
 */
function computeLayout(blueprint: Blueprint): StageLayout {
	const nodeMap = new Map(blueprint.nodes.map((n) => [n.id, n]));
	const depths = new Map<string, number>();

	function getDepth(id: string, visiting = new Set<string>()): number {
		// Already computed — return cached result
		if (depths.has(id)) return depths.get(id)!;
		// Cycle detected — break it by assigning depth 0
		if (visiting.has(id)) {
			depths.set(id, 0);
			return 0;
		}
		const node = nodeMap.get(id);
		if (!node || node.dependsOn.length === 0) {
			depths.set(id, 0);
			return 0;
		}
		// Pass a new Set with the current id added to detect back-edges
		const nextVisiting = new Set(visiting);
		nextVisiting.add(id);
		const parentDepths = node.dependsOn.filter((d) => nodeMap.has(d)).map((d) => getDepth(d, nextVisiting));
		const depth = parentDepths.length > 0 ? Math.max(...parentDepths) + 1 : 0;
		depths.set(id, depth);
		return depth;
	}

	// Each top-level call starts with a fresh `visiting` Set (default param),
	// so there is no cross-node contamination between loop iterations.
	for (const n of blueprint.nodes) {
		getDepth(n.id);
	}

	const maxDepth = blueprint.nodes.length > 0 ? Math.max(0, ...Array.from(depths.values())) : 0;

	const stages: BlueprintNode[][] = Array.from({ length: maxDepth + 1 }, () => []);
	for (const n of blueprint.nodes) {
		stages[depths.get(n.id) ?? 0].push(n);
	}

	const flatOrder: BlueprintNode[] = [];
	for (const stage of stages) {
		flatOrder.push(...stage);
	}

	return { stages, nodeDepths: depths, flatOrder };
}

// ─── Status Visual Helpers ───────────────────────────────────────────────────

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const;
const SPINNER_INTERVAL_MS = 120;

function getStatusIcon(status: string, theme: any): string {
	const frame = Math.floor(Date.now() / SPINNER_INTERVAL_MS) % SPINNER_FRAMES.length;
	switch (status) {
		case "completed":
			return theme.fg("success", "✓");
		case "running":
			return theme.fg("warning", SPINNER_FRAMES[frame]);
		case "failed":
			return theme.fg("error", "✗");
		case "skipped":
			return theme.fg("muted", "⏭");
		default:
			return theme.fg("muted", "○");
	}
}

function getStatusColor(status: string): string {
	switch (status) {
		case "completed":
			return "success";
		case "running":
			return "warning";
		case "failed":
			return "error";
		case "skipped":
			return "muted";
		default:
			return "dim";
	}
}

// ─── Time Helpers ────────────────────────────────────────────────────────────

function formatMs(ms: number): string {
	const sec = Math.max(0, Math.floor(ms / 1000));
	if (sec < 60) return `${sec}s`;
	const min = Math.floor(sec / 60);
	const remSec = sec % 60;
	return remSec > 0 ? `${min}m ${remSec}s` : `${min}m`;
}

function elapsedSince(isoStr?: string): string {
	if (!isoStr) return "";
	return formatMs(Date.now() - new Date(isoStr).getTime());
}

function durationBetween(start?: string, end?: string): string {
	if (!start) return "";
	const s = new Date(start).getTime();
	const e = end ? new Date(end).getTime() : Date.now();
	return formatMs(Math.max(0, e - s));
}

// ─── Blueprint DAG Viewer Options ───────────────────────────────────────────

export interface BlueprintDagViewerOptions {
	confirmMode?: boolean;
	onConfirm?: () => void;
	onCancel?: () => void;
}

// ─── Blueprint DAG Viewer ────────────────────────────────────────────────────

export class BlueprintDagViewer {
	private blueprint: Blueprint;
	private layout: StageLayout;
	private selectedIndex = 0;
	private onDone: () => void;
	private confirmMode: boolean;
	private viewerOptions?: BlueprintDagViewerOptions;

	constructor(blueprint: Blueprint, onDone: () => void, options?: BlueprintDagViewerOptions) {
		this.blueprint = blueprint;
		this.layout = computeLayout(blueprint);
		this.selectedIndex = 0;
		this.onDone = onDone;
		this.confirmMode = options?.confirmMode ?? false;
		this.viewerOptions = options;
	}

	handleInput(data: string, tui: any): void {
		// Confirm mode key handling
		if (this.confirmMode) {
			if (data === "\r" || data === "y" || data === "Y") {
				this.viewerOptions?.onConfirm?.();
				return;
			}
			if (matchesKey(data, Key.escape) || data === "n" || data === "N" || data === "q" || data === "Q") {
				this.viewerOptions?.onCancel?.();
				return;
			}
		} else {
			// View mode
			if (matchesKey(data, Key.escape) || data === "q" || data === "Q") {
				this.onDone();
				return;
			}
		}
		// Navigation (both modes)
		if (matchesKey(data, Key.up) || data === "k") {
			this.selectedIndex = Math.max(0, this.selectedIndex - 1);
		} else if (matchesKey(data, Key.down) || data === "j") {
			this.selectedIndex = Math.min(this.layout.flatOrder.length - 1, this.selectedIndex + 1);
		} else if (!this.confirmMode && data === "g") {
			this.selectedIndex = 0;
		} else if (!this.confirmMode && data === "G") {
			this.selectedIndex = Math.max(0, this.layout.flatOrder.length - 1);
		} else if (!this.confirmMode && data === "r") {
			const reloaded = loadBlueprint(this.blueprint.id);
			if (reloaded) {
				this.blueprint = reloaded;
				this.layout = computeLayout(reloaded);
				this.selectedIndex = Math.min(this.selectedIndex, Math.max(0, this.layout.flatOrder.length - 1));
			}
		}
		tui.requestRender();
	}

	render(width: number, theme: any): string[] {
		const container = new Container();
		const pad = "  ";
		const innerW = Math.max(40, width - 4);

		const sep = () => new Text(pad + theme.fg("muted", "─".repeat(Math.min(innerW, width - 4))), 0, 0);

		// ═══ HEADER ═══
		container.addChild(new Spacer(1));
		this.renderHeader(container, innerW, pad, theme);
		container.addChild(sep());

		// ═══ DAG GRID ═══
		container.addChild(new Spacer(1));
		this.renderDagGrid(container, innerW, pad, theme);
		container.addChild(new Spacer(1));
		container.addChild(sep());

		// ═══ DETAIL PANEL ═══
		const selectedNode = this.layout.flatOrder[this.selectedIndex];
		if (selectedNode) {
			this.renderDetailPanel(container, selectedNode, innerW, pad, theme);
			container.addChild(sep());
		}

		// ═══ HELP ═══
		if (this.confirmMode) {
			container.addChild(
				new Text(
					pad +
						theme.fg("dim", "↑↓/jk select  ") +
						theme.fg("success", "Enter/y 실행") +
						theme.fg("dim", "  ") +
						theme.fg("error", "n/Esc 취소"),
					0,
					0,
				),
			);
		} else {
			container.addChild(new Text(pad + theme.fg("dim", "↑↓/jk select  g/G top/end  r refresh  q/Esc close"), 0, 0));
		}
		container.addChild(new Spacer(1));

		return container.render(width);
	}

	// ─── Header ──────────────────────────────────────────────────────────────

	private renderHeader(container: Container, innerW: number, pad: string, theme: any): void {
		const bp = this.blueprint;
		const completed = bp.nodes.filter((n) => n.status === "completed").length;
		const total = bp.nodes.length;
		const running = bp.nodes.filter((n) => n.status === "running").length;
		const failed = bp.nodes.filter((n) => n.status === "failed").length;

		const statusColor =
			bp.status === "completed" ? "success" : bp.status === "failed" || bp.status === "aborted" ? "error" : "accent";

		const progressParts = [`${completed}/${total}`];
		if (running > 0) progressParts.push(`${running} running`);
		if (failed > 0) progressParts.push(`${failed} failed`);

		container.addChild(
			new Text(
				truncateToWidth(
					pad +
						theme.fg(statusColor, theme.bold(`📋 ${bp.title}`)) +
						theme.fg("dim", `  [${progressParts.join(", ")}]  `) +
						theme.fg(statusColor, bp.status),
					innerW,
				),
				0,
				0,
			),
		);

		container.addChild(new Text(pad + theme.fg("dim", `ID: ${bp.id}`), 0, 0));
	}

	// ─── DAG Grid ────────────────────────────────────────────────────────────

	private renderDagGrid(container: Container, innerW: number, pad: string, theme: any): void {
		const { stages } = this.layout;
		const numStages = stages.length;

		if (numStages === 0) {
			container.addChild(new Text(pad + theme.fg("muted", "(no nodes)"), 0, 0));
			return;
		}

		// Calculate column widths — min 14 to keep at least ~11 chars of node ID visible
		const arrowW = 4; // " ─→ "
		const totalArrowSpace = Math.max(0, numStages - 1) * arrowW;
		const availableForCols = innerW - totalArrowSpace;
		const colW = Math.max(14, Math.floor(availableForCols / numStages));

		// ── Adaptive layout: fall back to compact vertical when horizontal overflows ──
		// When numStages × colW + arrowSpace > innerW, the rightmost stage columns
		// would be truncated. Switch to a vertical per-stage layout instead.
		const neededW = numStages * colW + totalArrowSpace;
		if (neededW > innerW) {
			this.renderDagGridCompact(container, innerW, pad, theme);
			return;
		}

		// Stage headers
		const headerParts: string[] = [];
		for (let s = 0; s < numStages; s++) {
			headerParts.push(padRight(`STAGE ${s + 1}`, colW));
			if (s < numStages - 1) headerParts.push("    ");
		}
		container.addChild(new Text(pad + theme.fg("accent", truncateToWidth(headerParts.join(""), innerW)), 0, 0));

		// Underlines
		const underParts: string[] = [];
		for (let s = 0; s < numStages; s++) {
			underParts.push("─".repeat(Math.max(1, colW - 1)) + " ");
			if (s < numStages - 1) underParts.push("    ");
		}
		container.addChild(new Text(pad + theme.fg("dim", truncateToWidth(underParts.join(""), innerW)), 0, 0));

		// Node rows
		const maxRows = Math.max(...stages.map((s) => s.length));

		for (let row = 0; row < maxRows; row++) {
			const lineParts: string[] = [];

			for (let s = 0; s < numStages; s++) {
				const node = stages[s][row];

				if (node) {
					const flatIdx = this.layout.flatOrder.indexOf(node);
					const isSelected = flatIdx === this.selectedIndex;
					const icon = getStatusIcon(node.status, theme);

					// Truncate node name to fit column
					const nameMax = colW - 3; // icon(1-2) + space(1) + name
					const name = node.id.length > nameMax ? node.id.slice(0, Math.max(1, nameMax - 1)) + "…" : node.id;

					let cell = `${icon} ${name}`;

					// Pad cell to column width (account for ANSI in icon)
					const cellVis = visibleWidth(cell);
					if (cellVis < colW) {
						cell += " ".repeat(colW - cellVis);
					}

					if (isSelected) {
						cell = theme.bg("selectedBg", cell);
					}

					lineParts.push(cell);
				} else {
					lineParts.push(" ".repeat(colW));
				}

				// Arrow connector between stages
				if (s < numStages - 1) {
					if (node) {
						// Check if this node connects forward
						const hasForwardEdge = stages[s + 1]?.some((next) => next.dependsOn.includes(node.id));
						if (hasForwardEdge) {
							lineParts.push(theme.fg("accent", " ─→ "));
						} else {
							lineParts.push(theme.fg("dim", " ── "));
						}
					} else {
						// Check if there's a merge arrow from a node above in this stage
						const hasUpwardMerge = this.checkMergeArrow(s, row);
						if (hasUpwardMerge) {
							lineParts.push(theme.fg("dim", " ─↗ "));
						} else {
							lineParts.push("    ");
						}
					}
				}
			}

			container.addChild(new Text(pad + truncateToWidth(lineParts.join(""), innerW), 0, 0));
		}
	}

	/**
	 * Compact vertical fallback layout used when terminal is too narrow for
	 * the horizontal grid (numStages × colW + arrowSpace > innerW).
	 *
	 * Renders one stage per line-group:
	 *   [S1]  ✓ plan-1
	 *   [S2]  ✓ challenge-1
	 *   [S3]  ⠹ impl-A  ⠹ impl-B
	 *   [S4]  ○ review
	 */
	private renderDagGridCompact(container: Container, innerW: number, pad: string, theme: any): void {
		const { stages } = this.layout;

		// Stage label width: "[S99]" = 5 chars + 1 space = 6
		const labelW = 6;
		const nodeAreaW = Math.max(20, innerW - labelW);

		for (let s = 0; s < stages.length; s++) {
			const nodes = stages[s];
			const label = theme.fg("accent", `[S${s + 1}]`);

			// Build node cells for this stage
			// Each cell: icon(1) + space(1) + id; cells separated by "  "
			const cellGap = "  ";
			const cells: string[] = [];

			for (const node of nodes) {
				const flatIdx = this.layout.flatOrder.indexOf(node);
				const isSelected = flatIdx === this.selectedIndex;
				const icon = getStatusIcon(node.status, theme);
				// Max name length: remaining area (rough estimate per node)
				const maxName = Math.max(4, Math.floor(nodeAreaW / Math.max(1, nodes.length)) - 4);
				const name = node.id.length > maxName ? node.id.slice(0, Math.max(1, maxName - 1)) + "…" : node.id;
				let cell = `${icon} ${name}`;
				if (isSelected) {
					cell = theme.bg("selectedBg", cell);
				}
				cells.push(cell);
			}

			const nodesStr = cells.join(cellGap);
			// Truncate only the node area (label is outside the truncation)
			const nodeLine = truncateToWidth(nodesStr, nodeAreaW);

			container.addChild(new Text(pad + label + " " + nodeLine, 0, 0));
		}
	}

	/**
	 * Check if there should be a merge arrow at position (stageIdx, row).
	 * This happens when a node above in the next stage depends on a node
	 * above in the current stage, creating a visual merge.
	 */
	private checkMergeArrow(stageIdx: number, row: number): boolean {
		const { stages } = this.layout;
		const nextStage = stages[stageIdx + 1];
		const currStage = stages[stageIdx];
		if (!nextStage || !currStage) return false;

		// Check if any node above in next stage depends on a node above in current stage
		for (let r = 0; r < row; r++) {
			const currNode = currStage[r];
			if (!currNode) continue;
			for (const nextNode of nextStage) {
				if (nextNode.dependsOn.includes(currNode.id)) {
					// There's a connection that passes through this row
					return false; // Actually this is already handled in the main row
				}
			}
		}
		return false;
	}

	// ─── Detail Panel ────────────────────────────────────────────────────────

	private renderDetailPanel(container: Container, node: BlueprintNode, innerW: number, pad: string, theme: any): void {
		const statusColor = getStatusColor(node.status);

		// Node title line
		container.addChild(
			new Text(
				truncateToWidth(
					pad +
						theme.fg(statusColor, theme.bold(`▶ ${node.id}`)) +
						theme.fg("dim", `  ${node.purpose}/${node.difficulty}`) +
						(node.agent ? theme.fg("dim", ` → ${node.agent}`) : ""),
					innerW,
				),
				0,
				0,
			),
		);

		// Task description
		const taskMax = Math.max(20, innerW - 12);
		const task = node.task.replace(/\s*\n+\s*/g, " ").trim();
		const taskTrunc = task.length > taskMax ? `${task.slice(0, taskMax - 3)}...` : task;
		container.addChild(new Text(truncateToWidth(pad + theme.fg("text", `  Task: ${taskTrunc}`), innerW), 0, 0));

		// Dependencies
		if (node.dependsOn.length > 0) {
			container.addChild(
				new Text(truncateToWidth(pad + theme.fg("dim", `  Deps: ${node.dependsOn.join(", ")}`), innerW), 0, 0),
			);
		}

		// Chain from
		if (node.chainFrom) {
			container.addChild(new Text(truncateToWidth(pad + theme.fg("dim", `  Chain ← ${node.chainFrom}`), innerW), 0, 0));
		}

		// Timing info
		if (node.status === "running" && node.startedAt) {
			container.addChild(
				new Text(
					truncateToWidth(pad + theme.fg("warning", `  ⏱ ${elapsedSince(node.startedAt)} elapsed`), innerW),
					0,
					0,
				),
			);
		} else if (node.status === "completed" && node.startedAt) {
			container.addChild(
				new Text(
					truncateToWidth(
						pad + theme.fg("success", `  ✓ Completed in ${durationBetween(node.startedAt, node.completedAt)}`),
						innerW,
					),
					0,
					0,
				),
			);
		} else if (node.status === "failed") {
			const errMsg = node.error ? `: ${node.error.slice(0, 80)}` : "";
			container.addChild(new Text(truncateToWidth(pad + theme.fg("error", `  ✗ Failed${errMsg}`), innerW), 0, 0));
		}

		// Result preview (if available)
		if (node.result) {
			const preview = node.result.replace(/\s*\n+\s*/g, " ").trim();
			const maxLen = Math.max(20, innerW - 14);
			const resultTrunc = preview.length > maxLen ? `${preview.slice(0, maxLen - 3)}...` : preview;
			container.addChild(new Text(truncateToWidth(pad + theme.fg("muted", `  Result: ${resultTrunc}`), innerW), 0, 0));
		}

		// Result file path
		if (node.resultPath) {
			container.addChild(new Text(truncateToWidth(pad + theme.fg("dim", `  📄 ${node.resultPath}`), innerW), 0, 0));
		}
	}
}

// ─── Plain Text DAG Renderer (for tool results) ─────────────────────────────

/** Status icons for plain text rendering (no ANSI). */
const TEXT_ICONS: Record<string, string> = {
	pending: "○",
	running: "⟳",
	completed: "✓",
	failed: "✗",
	skipped: "⏭",
};

/**
 * Render a Blueprint DAG as plain text (no ANSI/theme).
 * Suitable for embedding in tool results, sendMessage content, etc.
 *
 * Output example:
 *   📋 로그인 버그 수정  [2/4]  running
 *   ────────────────────────────────────────
 *   STAGE 1       STAGE 2        STAGE 3
 *   ──────────    ──────────     ──────────
 *   ✓ plan-1  ─→  ✓ challenge ─→  ⟳ impl-A
 *                              ─→  ○ review
 *   ────────────────────────────────────────
 *   ✓ plan-1 [plan/medium] → planner: ...
 *   ✓ challenge [challenge/medium] → challenger: ...
 *   ⟳ impl-A [implement/high] → worker: ...
 *   ○ review [review/medium] → reviewer: ...
 */
export function renderBlueprintDAGText(blueprint: Blueprint, _width: number = 80): string {
	const layout = computeLayout(blueprint);
	const { stages } = layout;
	const lines: string[] = [];

	const completed = blueprint.nodes.filter((n) => n.status === "completed").length;
	const total = blueprint.nodes.length;
	const running = blueprint.nodes.filter((n) => n.status === "running").length;
	const failed = blueprint.nodes.filter((n) => n.status === "failed").length;

	// ── Header ─────────────────────────────────────────────────────────────
	const counters = [`${completed}/${total} 완료`];
	if (running > 0) counters.push(`${running} running`);
	if (failed > 0) counters.push(`${failed} failed`);
	lines.push(`📋 ${blueprint.title}  [${counters.join(", ")}]`);
	lines.push("");

	if (stages.length === 0) {
		lines.push("(no nodes)");
		return lines.join("\n");
	}

	// ── Vertical DAG flow ──────────────────────────────────────────────────
	// Each stage is a row of nodes rendered top-to-bottom with connector lines between stages.

	// Dynamic column width: icon(1) + space(1) + longest-id + 1 margin, min 20
	const maxNodeIdLen = Math.max(...blueprint.nodes.map((n) => n.id.length));
	const NODE_COL_W = Math.max(20, maxNodeIdLen + 3);
	const NODE_GAP = 2; // spaces between adjacent node columns

	const maxNodesInAnyStage = stages.reduce((m, s) => Math.max(m, s.length), 0);
	const canvasW = maxNodesInAnyStage * NODE_COL_W + Math.max(0, maxNodesInAnyStage - 1) * NODE_GAP;

	/** Get the center X position of the k-th node in a stage of `count` nodes. */
	function nodeCenter(k: number, count: number): number {
		const totalW = count * NODE_COL_W + Math.max(0, count - 1) * NODE_GAP;
		const startX = Math.floor((canvasW - totalW) / 2);
		return startX + k * (NODE_COL_W + NODE_GAP) + Math.floor(NODE_COL_W / 2);
	}

	/** Build a line of `canvasW` spaces, then stamp a string at position x (clamped). */
	function blankLine(): string[] {
		return Array(canvasW).fill(" ");
	}
	function stamp(chars: string[], x: number, text: string) {
		for (let i = 0; i < text.length; i++) {
			if (x + i >= 0 && x + i < chars.length) {
				chars[x + i] = text[i];
			}
		}
	}

	/** Render one stage (row of nodes). Returns a trimmed string. */
	function renderStageRow(stageIdx: number): string {
		const nodes = stages[stageIdx];
		const count = nodes.length;
		const chars = blankLine();
		for (let k = 0; k < count; k++) {
			const node = nodes[k];
			const icon = TEXT_ICONS[node.status] || "○";
			const rawLabel = `${icon} ${node.id}`;
			// Truncate label to fit within column width (with ellipsis for overflow)
			const maxLabelW = NODE_COL_W - 1;
			const label = rawLabel.length > maxLabelW ? `${rawLabel.slice(0, maxLabelW - 1)}…` : rawLabel;
			const cx = nodeCenter(k, count);
			// Clamp startX so label never extends past the left canvas edge
			const startX = Math.max(0, cx - Math.floor(label.length / 2));
			stamp(chars, startX, label);
		}
		return chars.join("").trimEnd();
	}

	/** Render connector lines between stageIdx and stageIdx+1.
	 *  Returns 2-3 line strings: vertical drops, convergence/divergence bar, and vertical drops to next stage. */
	function renderConnectors(stageIdx: number): string[] {
		const srcNodes = stages[stageIdx];
		const dstNodes = stages[stageIdx + 1];

		// Find which src→dst edges exist
		const edges: Array<{ srcK: number; dstK: number }> = [];
		for (let dk = 0; dk < dstNodes.length; dk++) {
			for (let sk = 0; sk < srcNodes.length; sk++) {
				if (dstNodes[dk].dependsOn.includes(srcNodes[sk].id)) {
					edges.push({ srcK: sk, dstK: dk });
				}
			}
		}

		if (edges.length === 0) {
			// No edges between stages — just a blank line
			return [""];
		}

		const srcCenters = srcNodes.map((_, k) => nodeCenter(k, srcNodes.length));
		const dstCenters = dstNodes.map((_, k) => nodeCenter(k, dstNodes.length));

		// Collect active src/dst centers
		const activeSrcSet = new Set(edges.map((e) => e.srcK));
		const activeDstSet = new Set(edges.map((e) => e.dstK));
		const activeSrcCenters = [...activeSrcSet].map((k) => srcCenters[k]).sort((a, b) => a - b);
		const activeDstCenters = [...activeDstSet].map((k) => dstCenters[k]).sort((a, b) => a - b);

		const outputLines: string[] = [];

		// Line 1: vertical bars down from each active source
		{
			const c = blankLine();
			for (const x of activeSrcCenters) stamp(c, x, "│");
			outputLines.push(c.join("").trimEnd());
		}

		const isSimple =
			activeSrcCenters.length === 1 && activeDstCenters.length === 1 && activeSrcCenters[0] === activeDstCenters[0];

		if (!isSimple) {
			// Line 2: horizontal merge/split bar
			const c = blankLine();
			const allXs = [...activeSrcCenters, ...activeDstCenters].sort((a, b) => a - b);
			const leftX = allXs[0];
			const rightX = allXs[allXs.length - 1];

			// Determine the "hub" x: center between left and right
			const hubX = Math.round((leftX + rightX) / 2);

			// Draw horizontal line from left to right
			for (let x = leftX; x <= rightX; x++) stamp(c, x, "─");

			// Stamp junction chars
			for (const x of activeSrcCenters) {
				if (x === leftX && activeDstCenters.includes(x)) stamp(c, x, "├");
				else if (x === rightX && activeDstCenters.includes(x)) stamp(c, x, "┤");
				else if (activeDstCenters.includes(x)) stamp(c, x, "┼");
				else if (x === leftX) stamp(c, x, "└");
				else if (x === rightX) stamp(c, x, "┘");
				else stamp(c, x, "┴");
			}
			for (const x of activeDstCenters) {
				if (!activeSrcCenters.includes(x)) {
					if (x === leftX) stamp(c, x, "┌");
					else if (x === rightX) stamp(c, x, "┐");
					else stamp(c, x, "┬");
				}
			}

			// If single fan-in/fan-out, mark the hub
			if (activeSrcCenters.length > 1 && activeDstCenters.length === 1) {
				const dx = activeDstCenters[0];
				if (!activeSrcCenters.includes(dx)) stamp(c, dx, "┬");
			} else if (activeSrcCenters.length === 1 && activeDstCenters.length > 1) {
				const sx = activeSrcCenters[0];
				if (!activeDstCenters.includes(sx)) stamp(c, sx, "┴");
			}

			// If hub is different from all stamped positions, add ┬ or ┴
			if (!activeSrcCenters.includes(hubX) && !activeDstCenters.includes(hubX) && hubX > leftX && hubX < rightX) {
				// skip — hub is only needed for pure fan-in/fan-out cases handled above
			}

			outputLines.push(c.join("").trimEnd());

			// Line 3: vertical bars down to each active destination
			if (activeDstCenters.length > 0) {
				const c2 = blankLine();
				for (const x of activeDstCenters) stamp(c2, x, "│");
				outputLines.push(c2.join("").trimEnd());
			}
		}

		return outputLines;
	}

	// ── Render all stages top-to-bottom ────────────────────────────────────
	for (let s = 0; s < stages.length; s++) {
		lines.push(renderStageRow(s));
		if (s < stages.length - 1) {
			const connectors = renderConnectors(s);
			for (const cl of connectors) lines.push(cl);
		}
	}

	// ── Node summary list ───────────────────────────────────────────────────
	const sepW = Math.max(48, canvasW);
	lines.push("");
	lines.push("─".repeat(sepW));
	for (const node of blueprint.nodes) {
		const stageNum = stages.findIndex((s) => s.some((n) => n.id === node.id)) + 1;
		const icon = TEXT_ICONS[node.status] || "○";
		const agent = node.agent ? ` → ${node.agent}` : "";
		const deps = node.dependsOn.length > 0 ? `  (deps: ${node.dependsOn.join(", ")})` : "";
		const chain = node.chainFrom ? ` [chain←${node.chainFrom}]` : "";
		// Align node IDs using dynamic padding
		const idPadded = node.id.padEnd(maxNodeIdLen);
		lines.push(`[${stageNum}] ${icon} ${idPadded}  ${node.purpose}/${node.difficulty}${agent}${deps}${chain}`);
		// Collapse newlines in task text, then truncate to 90 chars for readability
		const taskText = node.task.replace(/\n+\s*/g, " ").trim();
		const taskPreview = taskText.length > 90 ? `${taskText.slice(0, 87)}...` : taskText;
		lines.push(`    ${taskPreview}`);
	}

	return lines.join("\n");
}

// ─── Utility ─────────────────────────────────────────────────────────────────

/** Right-pad a string to targetWidth (plain text, no ANSI). */
function padRight(str: string, targetWidth: number): string {
	return str.length < targetWidth ? str + " ".repeat(targetWidth - str.length) : str;
}
