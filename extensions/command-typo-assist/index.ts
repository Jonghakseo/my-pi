/**
 * Command Typo Assist
 *
 * Extension-only slash command typo detection.
 * No core patching — uses the `input` event hook to intercept unknown commands
 * before they reach the LLM, then suggests the closest known command and
 * prefills the editor so the user can just press Enter.
 *
 * Flow:
 *   1. User types `/relod` → builtin check fails → session.prompt("/relod")
 *   2. Extension command check fails → `input` event fires
 *   3. This handler detects unknown command, finds closest match via Levenshtein
 *   4. Shows notification + prefills editor with corrected command
 *   5. Returns { action: "handled" } so nothing is sent to the LLM
 */

import * as fs from "node:fs";
import type { ExtensionAPI, ExtensionContext, InputEvent, InputEventResult } from "@mariozechner/pi-coding-agent";
import { levenshtein, maxDistance } from "../utils/string-utils.js";

// ─── Builtin commands (hardcoded — not exposed via pi.getCommands()) ─────────
const BUILTIN_COMMANDS = [
	"settings",
	"model",
	"scoped-models",
	"export",
	"share",
	"copy",
	"name",
	"session",
	"changelog",
	"hotkeys",
	"fork",
	"tree",
	"login",
	"logout",
	"new",
	"compact",
	"reload",
	"resume",
	"quit",
	"debug",
] as const;

// ─── Levenshtein distance (imported from utils/string-utils.ts) ────────────────

// ─── Threshold heuristic (imported from utils/string-utils.ts) ──────────────
// maxDistance is imported from utils/string-utils.ts

// ─── Extension entry point ───────────────────────────────────────────────────
function shouldInterceptSlashCommand(text: string): boolean {
	if (!text.startsWith("/")) return false;
	const spaceIdx = text.indexOf(" ");
	const cmdName = spaceIdx === -1 ? text.slice(1) : text.slice(1, spaceIdx);
	if (!cmdName) return false;

	// Absolute filesystem paths like /var/folders/... are user input, not slash commands.
	if (cmdName.includes("/")) return false;
	if (spaceIdx === -1) {
		try {
			if (fs.existsSync(text)) return false;
		} catch {
			// Ignore filesystem probe errors and fall through to command handling.
		}
	}

	return true;
}

export { shouldInterceptSlashCommand };

export default function commandTypoAssist(pi: ExtensionAPI) {
	pi.on("input", (event: InputEvent, ctx: ExtensionContext): InputEventResult | undefined => {
		const text = event.text.trim();

		// Only intercept actual slash commands, not pasted absolute paths.
		if (!shouldInterceptSlashCommand(text)) return;

		// Parse command token + trailing args
		const spaceIdx = text.indexOf(" ");
		const cmdName = spaceIdx === -1 ? text.slice(1) : text.slice(1, spaceIdx);
		const cmdArgs = spaceIdx === -1 ? "" : text.slice(spaceIdx);

		// ── Build full known-command set ──────────────────────────────────
		// pi.getCommands() returns extension commands, prompt templates, and skills
		// (skills have "skill:" prefix). We normalize skill names to drop the prefix
		// since users type `/skill:name` as-is.
		const extensionCmdNames = pi.getCommands().map((c) => c.name);
		const allCommands = [...new Set([...BUILTIN_COMMANDS, ...extensionCmdNames])];

		// ── Exact match → let it through ─────────────────────────────────
		if (allCommands.includes(cmdName)) return;

		// ── Fuzzy match ──────────────────────────────────────────────────
		const lowerCmd = cmdName.toLowerCase();
		let bestMatch = "";
		let bestDist = Number.POSITIVE_INFINITY;

		for (const known of allCommands) {
			const dist = levenshtein(lowerCmd, known.toLowerCase());
			if (dist < bestDist) {
				bestDist = dist;
				bestMatch = known;
			}
		}

		const threshold = maxDistance(cmdName.length);

		if (bestDist <= threshold && bestMatch) {
			// Close match found — suggest + prefill
			const corrected = `/${bestMatch}${cmdArgs}`;
			if (ctx.hasUI) {
				ctx.ui.notify(`Did you mean /${bestMatch}?`, "warning");
				ctx.ui.setEditorText(corrected);
			}
			return { action: "handled" };
		}

		// No close match — warn and swallow (don't send garbage to LLM)
		if (ctx.hasUI) {
			ctx.ui.notify(`Unknown command: /${cmdName}`, "warning");
		}
		return { action: "handled" };
	});
}
