import { Type } from "typebox";

export const TOOL_NAME = "interactive_shell";
export const TOOL_LABEL = "Interactive Shell";

export const TOOL_DESCRIPTION = `Run interactive or long-running terminal programs in a visible overlay, or as headless background dispatch when background:true is used (TUI apps, dev servers, REPLs, log viewers, or CLI coding agents when an overlay is needed).

Use bash for ordinary non-interactive commands. Use subagent for normal AI task delegation unless the user specifically needs an interactive CLI overlay.

Modes: interactive blocks for user control; hands-free returns a sessionId for checks; dispatch returns a sessionId and notifies on completion. Prefer dispatch for finite fire-and-forget tasks; for long-running servers/logs use hands-free or set handsFree.autoExitOnQuiet:false because dispatch auto-exits on quiet by default.

Common calls: start with { command, mode?, cwd?, timeout? }; query with { sessionId, outputLines?, drain?/incremental? }; send input with { sessionId, input/inputKeys/inputPaste }; finish with { sessionId, kill: true }. Wait 30-60s between status checks.`;

export const toolParameters = Type.Object({
	command: Type.Optional(
		Type.String({
			description: "Command to start a new overlay session.",
		}),
	),
	sessionId: Type.Optional(
		Type.String({
			description: "Existing session ID",
		}),
	),
	kill: Type.Optional(
		Type.Boolean({
			description: "Kill an existing session.",
		}),
	),
	outputLines: Type.Optional(
		Type.Number({
			description: "Lines to return (default 20, max 200)",
		}),
	),
	outputMaxChars: Type.Optional(
		Type.Number({
			description: "Max returned chars (default 5KB, max 50KB)",
		}),
	),
	outputOffset: Type.Optional(
		Type.Number({
			description: "0-based output line offset for pagination.",
		}),
	),
	drain: Type.Optional(
		Type.Boolean({
			description: "Return only new raw output since last query.",
		}),
	),
	incremental: Type.Optional(
		Type.Boolean({
			description: "Return next unseen output lines.",
		}),
	),
	settings: Type.Optional(
		Type.Object({
			updateInterval: Type.Optional(
				Type.Number({ description: "Change max update interval for existing session (ms)" }),
			),
			quietThreshold: Type.Optional(Type.Number({ description: "Change quiet threshold for existing session (ms)" })),
		}),
	),
	input: Type.Optional(
		Type.String({
			description: "Raw text/keystrokes to send (requires sessionId).",
		}),
	),
	inputKeys: Type.Optional(
		Type.Array(Type.String(), {
			description: "Named keys to send, e.g. enter, ctrl+c, alt+x.",
		}),
	),
	inputHex: Type.Optional(
		Type.Array(Type.String(), {
			description: "Raw hex byte sequences to send.",
		}),
	),
	inputPaste: Type.Optional(
		Type.String({
			description: "Bracketed-paste text to send.",
		}),
	),
	cwd: Type.Optional(
		Type.String({
			description: "Working directory for the command",
		}),
	),
	name: Type.Optional(
		Type.String({
			description: "Optional session name (used for session IDs)",
		}),
	),
	reason: Type.Optional(
		Type.String({
			description: "Overlay header note only.",
		}),
	),
	mode: Type.Optional(
		Type.String({
			description: "interactive | hands-free | dispatch",
		}),
	),
	background: Type.Optional(
		Type.Boolean({
			description: "New background sessions require mode='dispatch'; with sessionId, move overlay to background.",
		}),
	),
	attach: Type.Optional(
		Type.String({
			description: "Background session ID to reattach.",
		}),
	),
	listBackground: Type.Optional(
		Type.Boolean({
			description: "List all background sessions.",
		}),
	),
	dismissBackground: Type.Optional(
		Type.Union([Type.Boolean(), Type.String()], {
			description: "Dismiss background sessions; true = all, string = ID. Kills running/removes exited.",
		}),
	),
	handsFree: Type.Optional(
		Type.Object({
			updateMode: Type.Optional(
				Type.String({
					description: "Update mode: on-quiet or interval",
				}),
			),
			updateInterval: Type.Optional(Type.Number({ description: "Max update interval ms" })),
			quietThreshold: Type.Optional(Type.Number({ description: "Quiet threshold ms" })),
			gracePeriod: Type.Optional(
				Type.Number({
					description: "Startup grace period ms",
				}),
			),
			updateMaxChars: Type.Optional(Type.Number({ description: "Max chars per update" })),
			maxTotalChars: Type.Optional(
				Type.Number({
					description: "Total char budget for updates",
				}),
			),
			autoExitOnQuiet: Type.Optional(
				Type.Boolean({
					description: "Auto-kill after quietThreshold.",
				}),
			),
		}),
	),
	handoffPreview: Type.Optional(
		Type.Object({
			enabled: Type.Optional(Type.Boolean({ description: "Include tail in result details" })),
			lines: Type.Optional(Type.Number({ description: "Tail lines to include" })),
			maxChars: Type.Optional(Type.Number({ description: "Tail preview max chars" })),
		}),
	),
	handoffSnapshot: Type.Optional(
		Type.Object({
			enabled: Type.Optional(Type.Boolean({ description: "Write transcript snapshot" })),
			lines: Type.Optional(Type.Number({ description: "Snapshot tail lines" })),
			maxChars: Type.Optional(Type.Number({ description: "Snapshot max chars" })),
		}),
	),
	timeout: Type.Optional(
		Type.Number({
			description: "Auto-kill process after N milliseconds.",
		}),
	),
});

/** Parsed tool parameters type */
export interface ToolParams {
	command?: string;
	sessionId?: string;
	kill?: boolean;
	outputLines?: number;
	outputMaxChars?: number;
	outputOffset?: number;
	drain?: boolean;
	incremental?: boolean;
	settings?: { updateInterval?: number; quietThreshold?: number };
	input?: string;
	inputKeys?: string[];
	inputHex?: string[];
	inputPaste?: string;
	cwd?: string;
	name?: string;
	reason?: string;
	mode?: "interactive" | "hands-free" | "dispatch";
	background?: boolean;
	attach?: string;
	listBackground?: boolean;
	dismissBackground?: boolean | string;
	handsFree?: {
		updateMode?: "on-quiet" | "interval";
		updateInterval?: number;
		quietThreshold?: number;
		gracePeriod?: number;
		updateMaxChars?: number;
		maxTotalChars?: number;
		autoExitOnQuiet?: boolean;
	};
	handoffPreview?: { enabled?: boolean; lines?: number; maxChars?: number };
	handoffSnapshot?: { enabled?: boolean; lines?: number; maxChars?: number };
	timeout?: number;
}
