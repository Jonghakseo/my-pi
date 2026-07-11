import type { ThemeColor } from "@earendil-works/pi-coding-agent";
import type {
	BranchCommitEntry,
	CommitState,
	DiffFileStatus,
	FileTreeNode,
	OverlayDiffScope,
	OverlayViewMode,
} from "./diff-overlay-utils.js";

// ─── Types ─────────────────────────────────────────────────────────────────

export interface DiffFile {
	path: string;
	status: DiffFileStatus;
	rawStatus: string;
	commitState: CommitState;
	previousPath?: string | null;
}

export interface CommitFile {
	path: string;
	status: DiffFileStatus;
	rawStatus: string;
	previousPath?: string | null;
}

export type FocusPane = "left" | "right";

export interface ReviewDraft {
	scope: OverlayDiffScope;
	filePath: string;
	fileDisplayPath: string;
	prompt: string;
}

export interface ReviewInputState {
	active: boolean;
	buffer: string;
	error: string | null;
}

export interface DiffState {
	// Diff mode
	files: DiffFile[];
	filesByScope: Record<OverlayDiffScope, DiffFile[]>;
	scope: OverlayDiffScope;
	searchQuery: string;
	searchMode: boolean;
	selectedIndex: number;
	fileScrollOffset: number;
	diffCache: Map<string, string>;
	highlightedDiffCache: Map<string, string[]>;
	diffScrollOffset: number;
	diffScrollMemory: Map<string, number>;
	selectedFilePathByScope: Record<OverlayDiffScope, string | null>;
	wrapLines: boolean;
	changedOnly: boolean;
	reviewDrafts: ReviewDraft[];
	reviewInput: ReviewInputState;

	// Tree state for diff mode
	treeNodes: FileTreeNode[];
	expandedDirs: Set<string>;
	selectedFilePath: string | null;

	// Commit mode
	commits: BranchCommitEntry[];
	commitSelectedIndex: number;
	commitScrollOffset: number;
	commitFilesCache: Map<string, CommitFile[]>;
	commitFilesLoading: Set<string>;
	commitFileDiffCache: Map<string, string>;
	commitFileDiffLoading: Set<string>;
	commitExpandedByHash: Map<string, Set<string>>;
	commitFileSelectedIndex: number;
	commitFileScrollOffset: number; // line-based scroll in right commit pane
	commitFileManualScroll: boolean;

	viewMode: OverlayViewMode;
	focus: FocusPane;

	branch: string;
	mergeBase: string | null;
	baseBranch: string | null;
	error: string | null;
}

export interface Theme {
	fg: (color: ThemeColor, text: string) => string;
	bg: (color: "toolSuccessBg" | "toolErrorBg" | "selectedBg", text: string) => string;
	bold: (text: string) => string;
}

export interface Tui {
	requestRender: () => void;
	terminal?: { rows?: number };
}
