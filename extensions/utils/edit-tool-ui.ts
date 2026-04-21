import * as os from "node:os";
import { isAbsolute, resolve as resolvePath } from "node:path";
import { createEditToolDefinition, type ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type { Component } from "@mariozechner/pi-tui";
import { Container, Spacer, Text } from "@mariozechner/pi-tui";
import { applyEditOverrideToRawContent, type EditOverrideEdit } from "./edit-override.ts";
import { renderEditSideBySide } from "./edit-side-by-side.ts";
import { loadFileKindAndText } from "./file-kind.ts";

type EditPreview =
	| {
			diff: string;
			firstChangedLine?: number;
	  }
	| {
			error: string;
	  };

type EditResultDetails = {
	diff?: string;
	firstChangedLine?: number;
};

type EditRenderState = {
	argsKey?: string;
	preview?: EditPreview;
};

type DiffTheme = {
	fg: (color: unknown, text: string) => string;
	bg: (color: unknown, text: string) => string;
	bold: (text: string) => string;
};

const PREVIEW_ROW_LIMIT = 5;
const GENERIC_SUCCESS_RE = /^Successfully replaced \d+ block\(s\) in /;
const BASE_EDIT_TOOL = createEditToolDefinition(process.cwd());

function clonePreviewArgs<T>(value: T): T {
	try {
		return structuredClone(value);
	} catch {
		return value;
	}
}

function expandPath(filePath: string): string {
	if (filePath === "~") return os.homedir();
	if (filePath.startsWith("~/")) return os.homedir() + filePath.slice(1);
	return filePath;
}

function resolveToCwd(filePath: string, cwd: string): string {
	const expanded = expandPath(filePath);
	return isAbsolute(expanded) ? expanded : resolvePath(cwd, expanded);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function getRenderablePreviewInput(args: unknown): { path: string; edits: EditOverrideEdit[] } | null {
	const prepared = BASE_EDIT_TOOL.prepareArguments?.(clonePreviewArgs(args)) ?? args;
	if (!isRecord(prepared) || typeof prepared.path !== "string" || !Array.isArray(prepared.edits)) {
		return null;
	}

	const edits: EditOverrideEdit[] = [];
	for (const entry of prepared.edits) {
		if (!isRecord(entry) || typeof entry.oldText !== "string" || typeof entry.newText !== "string") {
			return null;
		}
		edits.push({ oldText: entry.oldText, newText: entry.newText });
	}

	return edits.length > 0 ? { path: prepared.path, edits } : null;
}

function formatEditCall(
	args: { path: string } | undefined,
	state: EditRenderState,
	options: { showPreviewError: boolean },
	theme: {
		bold: (text: string) => string;
		fg: (token: unknown, text: string) => string;
	},
): string {
	const pathDisplay =
		typeof args?.path === "string" && args.path.length > 0
			? theme.fg("accent", args.path)
			: theme.fg("toolOutput", "...");
	let text = `${theme.fg("toolTitle", theme.bold("edit"))} ${pathDisplay}`;

	if (state.preview && "error" in state.preview && options.showPreviewError) {
		text += `\n\n${theme.fg("error", state.preview.error)}`;
	}

	return text;
}

function createEditDiffComponent(
	details: { diff: string },
	theme: DiffTheme,
	expanded: boolean,
	isPreview: boolean,
): Component {
	return new (class implements Component {
		render(width: number): string[] {
			return renderEditSideBySide({
				diff: details.diff,
				width,
				theme,
				maxRows: expanded ? undefined : PREVIEW_ROW_LIMIT,
				isPreview,
			});
		}

		invalidate(): void {}
	})();
}

function renderEditCallComponent(
	args: { path: string } | undefined,
	state: EditRenderState,
	theme: DiffTheme,
	context: { expanded: boolean; executionStarted?: boolean; lastComponent?: Component },
): Component {
	const preview = state.preview;
	const showPreviewBody = !!preview && !("error" in preview) && !context.executionStarted;
	const headerText = formatEditCall(args, state, { showPreviewError: !context.executionStarted }, theme);

	if (!showPreviewBody || !preview || "error" in preview) {
		const text = context.lastComponent instanceof Text ? context.lastComponent : new Text("", 0, 0);
		text.setText(headerText);
		return text;
	}

	const container = context.lastComponent instanceof Container ? context.lastComponent : new Container();
	container.clear();
	container.addChild(new Text(headerText, 0, 0));
	container.addChild(new Spacer(1));
	container.addChild(createEditDiffComponent(preview, theme, context.expanded, true));
	return container;
}

async function computeEditPreview(request: unknown, cwd: string): Promise<EditPreview> {
	const previewInput = getRenderablePreviewInput(request);
	if (!previewInput) {
		return { error: "No edits provided." };
	}

	const { path, edits } = previewInput;
	const absolutePath = resolveToCwd(path, cwd);

	try {
		const file = await loadFileKindAndText(absolutePath);
		if (file.kind === "directory") {
			return { error: `Path is a directory: ${path}. Use ls to inspect directories.` };
		}
		if (file.kind === "image") {
			return { error: `Path is an image file: ${path}. Edit preview only supports UTF-8 text files.` };
		}
		if (file.kind === "binary") {
			return {
				error: `Path is a binary file: ${path} (${file.description}). Edit preview only supports UTF-8 text files.`,
			};
		}

		const preview = applyEditOverrideToRawContent(file.text, edits, path);
		return {
			diff: preview.diff,
			firstChangedLine: preview.firstChangedLine,
		};
	} catch (error: unknown) {
		return { error: error instanceof Error ? error.message : String(error) };
	}
}

function getRenderedEditTextContent(result: { content?: Array<{ type: string; text?: string }> }): string | undefined {
	const textContent = result.content?.find(
		(entry): entry is { type: "text"; text: string } => entry.type === "text" && typeof entry.text === "string",
	);
	return textContent?.text;
}

export function registerEditTool(pi: ExtensionAPI): void {
	pi.registerTool({
		...BASE_EDIT_TOOL,
		renderShell: "self",
		renderCall(args, theme, context) {
			const previewInput = getRenderablePreviewInput(args);
			if (!context.argsComplete || !previewInput) {
				context.state.argsKey = undefined;
				context.state.preview = undefined;
			} else {
				const argsKey = JSON.stringify({ cwd: context.cwd, previewInput });
				if (context.state.argsKey !== argsKey) {
					context.state.argsKey = argsKey;
					context.state.preview = undefined;
					computeEditPreview(previewInput, context.cwd)
						.then((preview) => {
							if (context.state.argsKey === argsKey) {
								context.state.preview = preview;
								context.invalidate();
							}
						})
						.catch((error: unknown) => {
							if (context.state.argsKey === argsKey) {
								context.state.preview = {
									error: error instanceof Error ? error.message : String(error),
								};
								context.invalidate();
							}
						});
				}
			}

			return renderEditCallComponent(
				previewInput ? { path: previewInput.path } : undefined,
				context.state as EditRenderState,
				theme as DiffTheme,
				context,
			);
		},
		renderResult(result, { expanded, isPartial }, theme, context) {
			if (isPartial) {
				const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
				text.setText(theme.fg("warning", "Editing..."));
				return text;
			}

			const renderedText = getRenderedEditTextContent(result as { content?: Array<{ type: string; text?: string }> });
			if (context.isError) {
				const text = context.lastComponent instanceof Text ? context.lastComponent : new Text("", 0, 0);
				text.setText(`\n${theme.fg("error", renderedText ?? "Edit failed.")}`);
				return text;
			}

			const details = result.details as EditResultDetails | undefined;
			if (typeof details?.diff === "string" && details.diff.length > 0) {
				const container = context.lastComponent instanceof Container ? context.lastComponent : new Container();
				container.clear();
				container.addChild(createEditDiffComponent({ diff: details.diff }, theme as DiffTheme, expanded, false));
				if (renderedText && !GENERIC_SUCCESS_RE.test(renderedText)) {
					container.addChild(new Spacer(1));
					container.addChild(new Text(renderedText, 0, 0));
				}
				return container;
			}

			const text = context.lastComponent instanceof Text ? context.lastComponent : new Text("", 0, 0);
			text.setText(renderedText ?? "");
			return text;
		},
		async execute(toolCallId, params, signal, onUpdate, ctx) {
			const builtinTool = createEditToolDefinition(ctx.cwd);
			const prepared = builtinTool.prepareArguments?.(clonePreviewArgs(params)) ?? params;
			return builtinTool.execute(toolCallId, prepared, signal, onUpdate, ctx);
		},
	});
}
