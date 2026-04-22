/**
 * User-defined companion extensions for this pi-extensions repo.
 *
 * Each entry teaches `claude-code-oauth` how to:
 *   1. Identify a companion extension's tools via sourceInfo metadata
 *      (baseDir basename === dirName, or path contains /dirName/ or /packageName/).
 *   2. Re-load the extension's factory via jiti with a capture shim to extract
 *      full tool definitions (execute function included).
 *   3. Re-register those tools under MCP-style alias names so they survive
 *      Anthropic OAuth tool-name filtering.
 *   4. Rename flat → MCP names in the outgoing payload and in historical
 *      tool_use blocks so the model sees consistent names.
 *
 * Adding a new companion:
 *   - dirName: directory basename (for local repo extensions) or the package
 *     directory name under node_modules (for npm-installed extensions).
 *   - packageName: npm scoped/unscoped name, or a "local/..." placeholder for
 *     repo-local extensions.
 *   - aliases: [flatName, mcpName] pairs. mcpName MUST start with `mcp__`.
 *
 * Caveats:
 *   - Extensions are re-executed via jiti to capture tool definitions. Module
 *     top-level side effects (file watchers, timers, global state init) WILL
 *     run a second time. For heavy stateful extensions this could cause
 *     surprising behavior; prefer pure factories.
 */

import type { CompanionSpec } from "./index.js";

export const USER_COMPANIONS: CompanionSpec[] = [
	// ------------------------------------------------------------------
	// Local repo extensions
	// ------------------------------------------------------------------
	{
		dirName: "subagent",
		packageName: "local/subagent",
		aliases: [
			["subagent", "mcp__pi__subagent"],
			["ask_master", "mcp__pi__ask_master"],
			["list-agents", "mcp__pi__list_agents"],
		],
	},
	{
		dirName: "interactive-shell",
		packageName: "local/interactive-shell",
		aliases: [["interactive_shell", "mcp__pi__interactive_shell"]],
	},
	{
		dirName: "web-access",
		packageName: "local/web-access",
		aliases: [
			// web_search is already in Pi's core tool allowlist; no alias needed.
			["fetch_content", "mcp__pi__fetch_content"],
			["get_search_content", "mcp__pi__get_search_content"],
		],
	},
	{
		dirName: "upload-image-url",
		packageName: "local/upload-image-url",
		aliases: [["upload_image_url", "mcp__pi__upload_image_url"]],
	},

	// ------------------------------------------------------------------
	// npm-installed extensions (@ryan_nookpi/*)
	// ------------------------------------------------------------------
	{
		dirName: "pi-extension-ask-user-question",
		packageName: "@ryan_nookpi/pi-extension-ask-user-question",
		aliases: [["ask_user_question", "mcp__pi__ask_user_question"]],
	},
	{
		dirName: "pi-extension-clipboard",
		packageName: "@ryan_nookpi/pi-extension-clipboard",
		aliases: [["copy_to_clipboard", "mcp__pi__copy_to_clipboard"]],
	},
	{
		dirName: "pi-extension-generative-ui",
		packageName: "@ryan_nookpi/pi-extension-generative-ui",
		aliases: [
			["show_widget", "mcp__pi__show_widget"],
			["visualize_read_me", "mcp__pi__visualize_read_me"],
		],
	},
	{
		dirName: "pi-extension-memory-layer",
		packageName: "@ryan_nookpi/pi-extension-memory-layer",
		aliases: [
			["recall", "mcp__pi__recall"],
			["remember", "mcp__pi__remember"],
			["forget", "mcp__pi__forget"],
			["memory_list", "mcp__pi__memory_list"],
		],
	},
	{
		dirName: "pi-extension-todo-write",
		packageName: "@ryan_nookpi/pi-extension-todo-write",
		aliases: [["todo_write", "mcp__pi__todo_write"]],
	},
];
