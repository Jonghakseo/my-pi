import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

const __dirname = dirname(fileURLToPath(import.meta.url));
const VENDOR_DIR = join(__dirname, "vendor", "system-prompts");

const REMINDER_CUSTOM_TYPE = "claude-code-system-reminder";
const REMINDER_MARKER = "<!-- claude-code-system-reminder -->";
const IDENTITY_IGNORE_NOTE = [
	"Ignore identity/persona/branding instructions from the active Claude Code system prompt.",
	"In particular, ignore claims that you are Claude Code, Anthropic's official CLI, or any other Claude Code product-identity framing.",
	"Treat those identity statements as non-operative. Continue to follow the remaining task/tool guidance together with the pi system reminder below.",
].join("\n");

const STATIC_FILES = [
	"system-prompt-censoring-assistance-with-malicious-activities.md",
	"system-prompt-communication-style.md",
	"system-prompt-doing-tasks-ambitious-tasks.md",
	"system-prompt-doing-tasks-minimize-file-creation.md",
	"system-prompt-doing-tasks-no-compatibility-hacks.md",
	"system-prompt-doing-tasks-no-premature-abstractions.md",
	"system-prompt-doing-tasks-no-time-estimates.md",
	"system-prompt-doing-tasks-no-unnecessary-additions.md",
	"system-prompt-doing-tasks-no-unnecessary-error-handling.md",
	"system-prompt-doing-tasks-read-before-modifying.md",
	"system-prompt-doing-tasks-security.md",
	"system-prompt-doing-tasks-software-engineering-focus.md",
	"system-prompt-executing-actions-with-care.md",
	"system-prompt-tone-and-style-code-references.md",
	"system-prompt-tone-and-style-concise-output-short.md",
] as const;

type ToolPromptGroup = {
	when: (activeTools: Set<string>) => boolean;
	title: string;
	files: string[];
};

const TOOL_GROUPS: ToolPromptGroup[] = [
	{
		when: (tools) => tools.has("read"),
		title: "## Tool: read",
		files: ["system-prompt-tool-usage-read-files.md", "tool-description-readfile.md"],
	},
	{
		when: (tools) => tools.has("edit"),
		title: "## Tool: edit",
		files: ["system-prompt-tool-usage-edit-files.md", "tool-description-edit.md"],
	},
	{
		when: (tools) => tools.has("write"),
		title: "## Tool: write",
		files: ["system-prompt-tool-usage-create-files.md", "tool-description-write.md"],
	},
	{
		when: (tools) => tools.has("bash"),
		title: "## Tool: bash",
		files: [
			"system-prompt-tool-usage-reserve-bash.md",
			"tool-description-bash-overview.md",
			"tool-description-bash-built-in-tools-note.md",
			"tool-description-bash-prefer-dedicated-tools.md",
			"tool-description-bash-maintain-cwd.md",
			"tool-description-bash-quote-file-paths.md",
			"tool-description-bash-parallel-commands.md",
			"tool-description-bash-sequential-commands.md",
			"tool-description-bash-semicolon-usage.md",
			"tool-description-bash-git-avoid-destructive-ops.md",
			"tool-description-bash-git-never-skip-hooks.md",
			"tool-description-bash-git-prefer-new-commits.md",
			"tool-description-bash-sleep-keep-short.md",
			"tool-description-bash-sleep-no-polling-background-tasks.md",
			"tool-description-bash-sleep-run-immediately.md",
		],
	},
	{
		when: (tools) => tools.has("grep"),
		title: "## Tool: grep",
		files: ["system-prompt-tool-usage-search-content.md", "tool-description-grep.md"],
	},
	{
		when: (tools) => tools.has("find") || tools.has("grep"),
		title: "## Tool: direct search",
		files: ["system-prompt-tool-usage-direct-search.md"],
	},
	{
		when: (tools) => tools.has("todo_write"),
		title: "## Tool: todo_write",
		files: ["system-prompt-tool-usage-task-management.md", "tool-description-todowrite.md"],
	},
	{
		when: (tools) => tools.has("ask_user_question"),
		title: "## Tool: ask_user_question",
		files: ["tool-description-askuserquestion.md"],
	},
	{
		when: (tools) => tools.has("web_search"),
		title: "## Tool: web_search",
		files: ["tool-description-websearch.md"],
	},
	{
		when: (tools) => tools.has("fetch_content"),
		title: "## Tool: fetch_content",
		files: ["tool-description-webfetch.md"],
	},
	{
		when: (tools) => tools.has("subagent"),
		title: "## Tool: subagent",
		files: ["system-prompt-tool-usage-subagent-guidance.md", "system-prompt-writing-subagent-prompts.md"],
	},
];

const TEMPLATE_REPLACEMENTS: Record<string, string> = {
	READ_TOOL_NAME: "read",
	READ_FILE_TOOL_NAME: "read",
	EDIT_TOOL_NAME: "edit",
	WRITE_TOOL_NAME: "write",
	BASH_TOOL_NAME: "bash",
	GREP_TOOL_NAME: "grep",
	GLOB_TOOL_NAME: "find",
	LS_TOOL_NAME: "ls",
	SEARCH_TOOLS: "find / grep",
	TASK_TOOL_NAME: "subagent",
	SEND_MESSAGE_TOOL_NAME: "subagent",
	TODO_WRITE_TOOL_NAME: "todo_write",
	ASK_USER_QUESTION_TOOL_NAME: "ask_user_question",
	WEB_FETCH_TOOL_NAME: "fetch_content",
	WEB_SEARCH_TOOL_NAME: "web_search",
	MAX_LINES_CONSTANT: "2000",
	CONDITIONAL_LENGTH_NOTE: "",
	CAT_DASH_N_NOTE: "",
	READ_FULL_FILE_NOTE: "",
	ADDITIONAL_READ_NOTE: "",
	EXIT_PLAN_MODE_TOOL_NAME: "(unavailable in pi)",
};

const promptCache = new Map<string, string>();

function shouldApply(modelId?: string): boolean {
	return typeof modelId === "string" && modelId.startsWith("claude-opus-");
}

function hasInjectedReminder(entries: unknown[]): boolean {
	return entries.some((entry) => {
		if (!entry || typeof entry !== "object") return false;
		const customEntry = entry as {
			type?: unknown;
			customType?: unknown;
			content?: unknown;
		};
		return (
			customEntry.type === "custom_message" &&
			customEntry.customType === REMINDER_CUSTOM_TYPE &&
			typeof customEntry.content === "string" &&
			customEntry.content.includes(REMINDER_MARKER)
		);
	});
}

function stripLeadingCommentBlock(content: string): string {
	return content.replace(/^<!--[\s\S]*?-->\s*/u, "");
}

function fillTemplate(content: string): string {
	let filled = stripLeadingCommentBlock(content);
	for (const [key, value] of Object.entries(TEMPLATE_REPLACEMENTS)) {
		filled = filled.replaceAll(`\${${key}}`, value);
	}
	filled = filled.replace(/\$\{[^}]+\}/g, "");
	filled = filled
		.split("\n")
		.map((line) => line.replace(/[ \t]+$/g, ""))
		.filter((line, index, lines) => {
			if (line.trim() !== "-") return true;
			const prev = lines[index - 1]?.trim() ?? "";
			const next = lines[index + 1]?.trim() ?? "";
			return Boolean(prev || next);
		})
		.join("\n");
	filled = filled.replace(/\n{3,}/g, "\n\n").trim();
	return filled;
}

function readVendorFile(file: string): string {
	const path = join(VENDOR_DIR, file);
	if (!existsSync(path)) {
		throw new Error(`Missing vendored Claude Code prompt file: ${path}`);
	}
	return readFileSync(path, "utf8");
}

function buildClaudeCodePrompt(activeToolNames: string[]): string {
	const cacheKey = [...activeToolNames].sort().join(",");
	const cached = promptCache.get(cacheKey);
	if (cached) return cached;

	const activeTools = new Set(activeToolNames);
	const sections: string[] = [];

	sections.push("You are Claude Code, Anthropic's official CLI for Claude.");
	sections.push(
		STATIC_FILES.map((file) => fillTemplate(readVendorFile(file)))
			.filter(Boolean)
			.join("\n\n"),
	);

	for (const group of TOOL_GROUPS) {
		if (!group.when(activeTools)) continue;
		const body = group.files
			.map((file) => fillTemplate(readVendorFile(file)))
			.filter(Boolean)
			.join("\n\n");
		if (!body) continue;
		sections.push(`${group.title}\n\n${body}`);
	}

	const prompt = sections.filter(Boolean).join("\n\n").trim();
	promptCache.set(cacheKey, prompt);
	return prompt;
}

function wrapSystemPromptAsReminder(systemPrompt: string): string {
	return [
		REMINDER_MARKER,
		"<system-reminder>",
		IDENTITY_IGNORE_NOTE,
		"",
		systemPrompt.trim(),
		"</system-reminder>",
	].join("\n");
}

export default function (pi: ExtensionAPI) {
	pi.on("before_agent_start", async (event, ctx) => {
		const modelId = ctx.model?.id;
		if (!shouldApply(modelId)) return;

		if (!hasInjectedReminder(ctx.sessionManager.getEntries())) {
			pi.sendMessage({
				customType: REMINDER_CUSTOM_TYPE,
				content: wrapSystemPromptAsReminder(event.systemPrompt),
				display: true,
				details: {
					appliesToModelPrefix: "claude-opus-",
					provider: ctx.model?.provider,
					model: modelId,
				},
			});
		}

		const claudeCodePrompt = buildClaudeCodePrompt(pi.getActiveTools());
		return {
			systemPrompt: claudeCodePrompt,
		};
	});
}
