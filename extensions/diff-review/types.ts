export type ReviewScope = "branch" | "commits" | "all";

export type ChangeStatus = "modified" | "added" | "deleted" | "renamed";

export interface ReviewFileComparison {
	status: ChangeStatus;
	oldPath: string | null;
	newPath: string | null;
	displayPath: string;
	hasOriginal: boolean;
	hasModified: boolean;
}

export interface ReviewFile {
	id: string;
	path: string;
	worktreeStatus: ChangeStatus | null;
	hasWorkingTreeFile: boolean;
	/** True when the file is touched by the current branch diff (merge-base/base ref vs HEAD). */
	inGitDiff: boolean;
	/** Diff comparison to render for the file in the current scope.
	 *  - branch scope: merge-base/base ref vs HEAD
	 *  - commits scope: commit vs commit^ (populated when loaded via request-commit) */
	gitDiff: ReviewFileComparison | null;
}

export interface ReviewCommitInfo {
	sha: string;
	shortSha: string;
	subject: string;
	authorName: string;
	authorDate: string;
}

export interface ReviewFileContents {
	originalContent: string;
	modifiedContent: string;
}

export type CommentSide = "original" | "modified" | "file";

export interface DiffReviewComment {
	id: string;
	fileId: string;
	scope: ReviewScope;
	/** Commit SHA when scope === "commits". */
	commitSha?: string | null;
	/** Short commit identifier to render in the prompt (e.g. first 7 chars of SHA). */
	commitShort?: string | null;
	side: CommentSide;
	startLine: number | null;
	endLine: number | null;
	body: string;
}

export interface ReviewSubmitPayload {
	type: "submit";
	overallComment: string;
	comments: DiffReviewComment[];
}

export interface ReviewCancelPayload {
	type: "cancel";
}

export interface ReviewRequestFilePayload {
	type: "request-file";
	requestId: string;
	fileId: string;
	scope: ReviewScope;
	commitSha?: string | null;
}

export interface ReviewRequestCommitPayload {
	type: "request-commit";
	requestId: string;
	sha: string;
}

export type ReviewWindowMessage =
	| ReviewSubmitPayload
	| ReviewCancelPayload
	| ReviewRequestFilePayload
	| ReviewRequestCommitPayload;

export interface ReviewFileDataMessage {
	type: "file-data";
	requestId: string;
	fileId: string;
	scope: ReviewScope;
	originalContent: string;
	modifiedContent: string;
}

export interface ReviewFileErrorMessage {
	type: "file-error";
	requestId: string;
	fileId: string;
	scope: ReviewScope;
	message: string;
}

export interface ReviewCommitDataMessage {
	type: "commit-data";
	requestId: string;
	sha: string;
	files: ReviewFile[];
}

export interface ReviewCommitErrorMessage {
	type: "commit-error";
	requestId: string;
	sha: string;
	message: string;
}

export type ReviewHostMessage =
	| ReviewFileDataMessage
	| ReviewFileErrorMessage
	| ReviewCommitDataMessage
	| ReviewCommitErrorMessage;

export interface ReviewWindowData {
	repoRoot: string;
	files: ReviewFile[];
	commits: ReviewCommitInfo[];
	branchBaseRef: string | null;
	branchMergeBaseSha: string | null;
}
