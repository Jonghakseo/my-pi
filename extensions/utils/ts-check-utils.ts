/**
 * Pure utilities for ts-check extension.
 * Extracted for testability — no I/O, no process spawning.
 */

import { relative } from "node:path";

// ── Types ───────────────────────────────────────────────────────────

/** Minimal diagnostic shape matching LSP publishDiagnostics. */
export interface LspDiagnostic {
	severity?: number;
	range?: { start?: { line?: number; character?: number } };
	code?: number | string;
	message: string;
}

/** Minimal server shape needed by pure formatting/parsing helpers. */
export interface DiagnosticsMap {
	diagnostics: Map<string, LspDiagnostic[]>;
}

/** Minimal pending-map shape for JSON-RPC message routing. */
export interface PendingMap {
	pending: Map<number, { resolve: (v: any) => void; reject: (e: any) => void }>;
	diagnostics: Map<string, LspDiagnostic[]>;
	buffer: string;
}

// ── Language detection ──────────────────────────────────────────────

/** Map file extension to LSP languageId. */
export function langId(path: string): string {
	if (path.endsWith(".tsx")) return "typescriptreact";
	if (path.endsWith(".jsx")) return "javascriptreact";
	if (path.endsWith(".js") || path.endsWith(".mjs") || path.endsWith(".cjs")) return "javascript";
	return "typescript";
}

// ── Diagnostics formatting ──────────────────────────────────────────

export interface FormatResult {
	text: string;
	totalErrors: number;
	totalWarnings: number;
}

/**
 * Format LSP diagnostics into a human-readable report.
 * Returns empty text when there are no diagnostics.
 */
export function formatDiagnostics(server: DiagnosticsMap, root: string): FormatResult {
	const lines: string[] = [];
	let totalErrors = 0;
	let totalWarnings = 0;

	for (const [uri, diags] of server.diagnostics) {
		if (diags.length === 0) continue;
		const filePath = uri.replace("file://", "");
		const relPath = relative(root, filePath);
		for (const d of diags) {
			const sev = d.severity === 1 ? "error" : d.severity === 2 ? "warning" : "info";
			if (d.severity === 1) totalErrors++;
			if (d.severity === 2) totalWarnings++;
			const line = (d.range?.start?.line ?? 0) + 1;
			const col = (d.range?.start?.character ?? 0) + 1;
			const code = d.code ? ` TS${d.code}` : "";
			lines.push(`${relPath}:${line}:${col} ${sev}${code}: ${d.message}`);
		}
	}

	if (lines.length === 0) return { text: "", totalErrors: 0, totalWarnings: 0 };
	const text = `${totalErrors} error(s), ${totalWarnings} warning(s):\n${lines.slice(0, 20).join("\n")}${lines.length > 20 ? `\n... and ${lines.length - 20} more` : ""}`;
	return { text, totalErrors, totalWarnings };
}

// ── JSON-RPC message parsing ────────────────────────────────────────

export interface ParsedMessage {
	id?: number;
	method?: string;
	params?: any;
	result?: any;
	error?: any;
}

/**
 * Parse JSON-RPC messages from a raw chunk appended to a buffer.
 * Mutates `state.buffer` as messages are consumed.
 * Returns all fully parsed messages.
 */
export function parseJsonRpcMessages(state: { buffer: string }, chunk: string): ParsedMessage[] {
	state.buffer += chunk;
	const messages: ParsedMessage[] = [];

	while (true) {
		const headerEnd = state.buffer.indexOf("\r\n\r\n");
		if (headerEnd === -1) break;
		const header = state.buffer.slice(0, headerEnd);
		const match = header.match(/Content-Length: (\d+)/);
		if (!match) {
			state.buffer = state.buffer.slice(headerEnd + 4);
			continue;
		}
		const length = parseInt(match[1]);
		const bodyStart = headerEnd + 4;
		if (state.buffer.length < bodyStart + length) break;
		const body = state.buffer.slice(bodyStart, bodyStart + length);
		state.buffer = state.buffer.slice(bodyStart + length);
		try {
			messages.push(JSON.parse(body));
		} catch {}
	}

	return messages;
}

/**
 * Route a parsed JSON-RPC message: resolve/reject pending requests,
 * capture publishDiagnostics notifications.
 */
export function routeMessage(server: PendingMap, msg: ParsedMessage): void {
	if (msg.id !== undefined && server.pending.has(msg.id)) {
		const p = server.pending.get(msg.id)!;
		server.pending.delete(msg.id);
		if (msg.error) p.reject(msg.error);
		else p.resolve(msg.result);
	}
	if (msg.method === "textDocument/publishDiagnostics" && msg.params) {
		server.diagnostics.set(msg.params.uri, msg.params.diagnostics || []);
	}
}
