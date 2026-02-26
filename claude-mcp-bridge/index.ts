import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { ExtensionAPI, ExtensionContext, Theme } from "@mariozechner/pi-coding-agent";
import type { TUI } from "@mariozechner/pi-tui";
import { matchesKey, truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";

type RawMcpServer = {
	type?: string;
	enabled?: boolean;
	command?: string;
	args?: string[];
	env?: Record<string, string>;
	cwd?: string;
	url?: string;
	headers?: Record<string, string>;
};

type NormalizedMcpServer =
	| {
			name: string;
			type: "stdio";
			enabled: boolean;
			command: string;
			args: string[];
			env: Record<string, string>;
			cwd?: string;
	  }
	| {
			name: string;
			type: "sse" | "http";
			enabled: boolean;
			url: string;
			headers: Record<string, string>;
	  };

type DiscoveredTool = {
	name: string;
	description?: string;
	inputSchema: Record<string, unknown>;
};

type ServerStatus = "connecting" | "connected" | "disconnected" | "error";

class McpConnection {
	private static readonly MAX_RECONNECT_ATTEMPTS = 5;
	private static readonly INITIAL_RECONNECT_DELAY_MS = 2_000;
	private static readonly MAX_RECONNECT_DELAY_MS = 30_000;

	private client: Client | null = null;
	private transport: StdioClientTransport | SSEClientTransport | StreamableHTTPClientTransport | null = null;

	/** When true, suppress onclose/onerror side-effects (e.g. during intentional disconnect or cleanup). */
	private intentionalDisconnect = false;
	private reconnectAttempts = 0;
	private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
	/** Deduplicates concurrent connect() calls. */
	private connectingPromise: Promise<void> | null = null;

	public status: ServerStatus = "disconnected";
	public error?: string;
	public tools: DiscoveredTool[] = [];

	constructor(public readonly server: NormalizedMcpServer) {}

	// ── public API ────────────────────────────────────────────

	async connect(): Promise<void> {
		// Deduplicate concurrent connect() invocations.
		if (this.connectingPromise) return this.connectingPromise;
		this.connectingPromise = this._doConnect();
		try {
			await this.connectingPromise;
		} finally {
			this.connectingPromise = null;
		}
	}

	async disconnect(): Promise<void> {
		this.intentionalDisconnect = true;
		this.clearReconnectTimer();
		await this.cleanupConnection();

		if (this.status !== "error") {
			this.status = "disconnected";
			this.error = undefined;
		}
		this.tools = [];
	}

	async refreshTools(): Promise<void> {
		if (!this.client) return;
		try {
			const result = await this.client.listTools();
			this.tools = result.tools.map((tool) => ({
				name: tool.name,
				description: tool.description,
				inputSchema: (tool.inputSchema ?? {}) as Record<string, unknown>,
			}));
		} catch {
			this.tools = [];
		}
	}

	/**
	 * Ensure the connection is alive before calling a tool.
	 * If disconnected / errored, attempt a fresh reconnect.
	 */
	async ensureConnected(): Promise<void> {
		if (this.status === "connected" && this.client) return;

		// If a connect() is already in flight, piggy-back on it.
		if (this.connectingPromise) {
			await this.connectingPromise;
			if (this.status === "connected" && this.client) return;
		}

		// Cancel any pending scheduled reconnect and try immediately.
		this.clearReconnectTimer();
		this.reconnectAttempts = 0;
		await this.connect();
	}

	async callTool(toolName: string, args: Record<string, unknown>): Promise<unknown> {
		if (!this.client || this.status !== "connected") {
			await this.ensureConnected();
		}
		if (!this.client || this.status !== "connected") {
			throw new Error(`MCP server '${this.server.name}' is not connected (status: ${this.status})`);
		}
		return this.client.callTool({ name: toolName, arguments: args });
	}

	// ── internals ─────────────────────────────────────────────

	private async _doConnect(): Promise<void> {
		this.clearReconnectTimer();

		// Guard: prevent the onclose handler of the *old* client from firing
		// a spurious reconnect while we tear it down.
		this.intentionalDisconnect = true;
		await this.cleanupConnection();
		this.intentionalDisconnect = false;

		this.status = "connecting";
		this.error = undefined;
		this.tools = [];

		try {
			this.client = new Client({ name: "pi-claude-mcp-bridge", version: "0.1.0" }, { capabilities: {} });

			if (this.server.type === "stdio") {
				this.transport = new StdioClientTransport({
					command: this.server.command,
					args: this.server.args,
					env: this.server.env,
					cwd: this.server.cwd,
					// Suppress noisy MCP server bootstrap logs on stderr by default.
					// Set PI_MCP_STDERR=inherit when debugging MCP connection issues.
					stderr: process.env.PI_MCP_STDERR === "inherit" ? "inherit" : "ignore",
				});
			} else if (this.server.type === "sse") {
				const sseHeaders = this.server.headers;
				this.transport = new SSEClientTransport(new URL(this.server.url), {
					// EventSourceInit does not support a headers property directly.
					// Inject custom headers into the SSE stream via a fetch wrapper.
					eventSourceInit:
						Object.keys(sseHeaders).length > 0
							? {
									fetch: (url, init) =>
										fetch(url, {
											...init,
											headers: { ...init.headers, ...sseHeaders },
										}),
								}
							: undefined,
					requestInit: { headers: sseHeaders },
				});
			} else {
				this.transport = new StreamableHTTPClientTransport(new URL(this.server.url), {
					requestInit: { headers: this.server.headers },
				});
			}

			await this.client.connect(this.transport);

			// ── Detect unexpected disconnection & auto-reconnect ──
			this.client.onclose = () => {
				if (this.intentionalDisconnect) return;
				this.status = "disconnected";
				this.client = null;
				this.transport = null;
				this.scheduleReconnect();
			};

			this.client.onerror = (error: Error) => {
				if (this.intentionalDisconnect) return;
				const msg = error instanceof Error ? error.message : String(error);
				if (msg.includes("unknown message ID")) return; // harmless race; ignore
				this.error = msg;
			};

			await this.refreshTools();
			this.status = "connected";
			this.reconnectAttempts = 0;
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			// Clean up the half-initialised connection (guard the onclose handler).
			this.intentionalDisconnect = true;
			await this.cleanupConnection();
			this.intentionalDisconnect = false;

			this.status = "error";
			this.error = message;
		}
	}

	private async cleanupConnection(): Promise<void> {
		if (this.client) {
			try {
				await this.client.close();
			} catch {
				/* ignore */
			}
			this.client = null;
		}
		if (this.transport) {
			try {
				await this.transport.close();
			} catch {
				/* ignore */
			}
			this.transport = null;
		}
	}

	private clearReconnectTimer(): void {
		if (this.reconnectTimer) {
			clearTimeout(this.reconnectTimer);
			this.reconnectTimer = null;
		}
	}

	/**
	 * Schedule a reconnection attempt with exponential back-off.
	 * Called automatically when an unexpected transport close is detected.
	 */
	private scheduleReconnect(): void {
		this.clearReconnectTimer();

		if (this.reconnectAttempts >= McpConnection.MAX_RECONNECT_ATTEMPTS) {
			this.status = "error";
			this.error = `Reconnection failed after ${McpConnection.MAX_RECONNECT_ATTEMPTS} attempts for '${this.server.name}'`;
			return;
		}

		const delay = Math.min(
			McpConnection.INITIAL_RECONNECT_DELAY_MS * Math.pow(2, this.reconnectAttempts),
			McpConnection.MAX_RECONNECT_DELAY_MS,
		);
		this.reconnectAttempts++;
		this.status = "connecting";

		this.reconnectTimer = setTimeout(async () => {
			await this.connect();
			// If still not connected (connect() swallows its own errors), keep trying.
			if (this.status !== "connected" && !this.intentionalDisconnect) {
				this.scheduleReconnect();
			}
		}, delay);
	}
}

class McpManager {
	private connections = new Map<string, McpConnection>();
	public sourcePath: string | null = null;

	async replaceServers(servers: NormalizedMcpServer[], sourcePath: string | null): Promise<void> {
		await this.disconnectAll();
		this.connections.clear();
		for (const server of servers) {
			this.connections.set(server.name, new McpConnection(server));
		}
		this.sourcePath = sourcePath;
	}

	async connectAll(): Promise<void> {
		for (const conn of this.connections.values()) {
			if (!conn.server.enabled) continue;
			await conn.connect();
		}
	}

	async disconnectAll(): Promise<void> {
		for (const conn of this.connections.values()) {
			await conn.disconnect();
		}
	}

	getStates(): Array<{
		name: string;
		status: ServerStatus;
		type: NormalizedMcpServer["type"];
		toolCount: number;
		error?: string;
	}> {
		return Array.from(this.connections.values()).map((conn) => ({
			name: conn.server.name,
			status: conn.status,
			type: conn.server.type,
			toolCount: conn.tools.length,
			error: conn.error,
		}));
	}

	getAllTools(): Array<{ serverName: string; tool: DiscoveredTool }> {
		const tools: Array<{ serverName: string; tool: DiscoveredTool }> = [];
		for (const conn of this.connections.values()) {
			if (conn.status !== "connected") continue;
			for (const tool of conn.tools) {
				tools.push({ serverName: conn.server.name, tool });
			}
		}
		return tools;
	}

	async callTool(serverName: string, toolName: string, args: Record<string, unknown>): Promise<unknown> {
		const conn = this.connections.get(serverName);
		if (!conn) {
			throw new Error(`MCP server '${serverName}' not found`);
		}
		return conn.callTool(toolName, args);
	}

	async reconnectServer(name: string): Promise<void> {
		const conn = this.connections.get(name);
		if (!conn) return;
		await conn.disconnect();
		await conn.connect();
	}

	getServerTools(name: string): DiscoveredTool[] {
		const conn = this.connections.get(name);
		if (!conn) return [];
		return [...conn.tools];
	}
}

type LoadedConfig = {
	sourcePath: string | null;
	servers: NormalizedMcpServer[];
	warnings: string[];
};

function expandEnvVars(value: string): string {
	return value.replace(/\$\{([^}]+)\}/g, (_, key: string) => process.env[key] ?? "");
}

function expandRecord(input?: Record<string, string>): Record<string, string> {
	const output: Record<string, string> = {};
	if (!input) return output;
	for (const [k, v] of Object.entries(input)) {
		output[k] = expandEnvVars(v);
	}
	return output;
}

function safeReadJson(filePath: string): unknown | null {
	if (!fs.existsSync(filePath)) return null;
	try {
		const raw = fs.readFileSync(filePath, "utf-8");
		return JSON.parse(raw);
	} catch {
		return null;
	}
}

function extractRawServers(data: unknown): Record<string, RawMcpServer> | null {
	if (!data || typeof data !== "object") return null;
	const record = data as Record<string, unknown>;

	if (record.mcpServers && typeof record.mcpServers === "object") {
		return record.mcpServers as Record<string, RawMcpServer>;
	}

	const mcp = record.mcp as Record<string, unknown> | undefined;
	if (mcp?.servers && typeof mcp.servers === "object") {
		return mcp.servers as Record<string, RawMcpServer>;
	}

	if (record.servers && typeof record.servers === "object") {
		return record.servers as Record<string, RawMcpServer>;
	}

	return null;
}

function normalizeServer(name: string, raw: RawMcpServer): NormalizedMcpServer | null {
	if (raw.enabled === false) return null;
	const type = raw.type?.toLowerCase();

	if (raw.command || type === "stdio") {
		if (!raw.command) return null;

		const envFromProcess: Record<string, string> = {};
		for (const [k, v] of Object.entries(process.env)) {
			if (typeof v === "string") envFromProcess[k] = v;
		}

		return {
			name,
			type: "stdio",
			enabled: true,
			command: expandEnvVars(raw.command),
			args: (raw.args ?? []).map(expandEnvVars),
			env: { ...envFromProcess, ...expandRecord(raw.env) },
			cwd: raw.cwd ? expandEnvVars(raw.cwd) : undefined,
		};
	}

	if (raw.url) {
		const expandedUrl = expandEnvVars(raw.url);
		const headers = expandRecord(raw.headers);
		const inferred =
			type === "sse" ? "sse" : type === "http" ? "http" : /\/sse(?:\/)?(?:\?|$)/i.test(expandedUrl) ? "sse" : "http";

		return {
			name,
			type: inferred,
			enabled: true,
			url: expandedUrl,
			headers,
		};
	}

	return null;
}

function collectScopedConfigCandidates(cwd: string): string[] {
	const candidates: string[] = [];
	const seen = new Set<string>();

	const push = (candidate: string): void => {
		const resolved = path.resolve(candidate);
		if (seen.has(resolved)) return;
		seen.add(resolved);
		candidates.push(resolved);
	};

	let current = path.resolve(cwd);
	const home = path.resolve(os.homedir());
	const root = path.parse(current).root;

	while (true) {
		push(path.join(current, ".pi", "mcp.json"));
		push(path.join(current, ".mcp.json"));
		push(path.join(current, "backend", ".mcp.json"));
		push(path.join(current, "frontend", ".mcp.json"));

		if (current === home || current === root) break;
		const parent = path.dirname(current);
		if (parent === current) break;
		current = parent;
	}

	push(path.join(os.homedir(), ".mcp.json"));
	push(path.join(os.homedir(), ".claude.json"));

	return candidates;
}

function loadConfig(cwd: string): LoadedConfig {
	const warnings: string[] = [];

	const explicitPath = process.env.PI_MCP_CONFIG;
	const candidates = explicitPath ? [path.resolve(expandEnvVars(explicitPath))] : collectScopedConfigCandidates(cwd);

	const loadedSources: string[] = [];
	const serversByName = new Map<string, NormalizedMcpServer>();

	for (const candidate of candidates) {
		const parsed = safeReadJson(candidate);
		if (!parsed) continue;

		const rawServers = extractRawServers(parsed);
		if (!rawServers || Object.keys(rawServers).length === 0) continue;
		loadedSources.push(candidate);

		for (const [name, raw] of Object.entries(rawServers)) {
			if (serversByName.has(name)) {
				warnings.push(`Skipped duplicate MCP server config: ${name} (from ${candidate})`);
				continue;
			}

			const normalized = normalizeServer(name, raw);
			if (normalized) serversByName.set(name, normalized);
			else warnings.push(`Skipped invalid MCP server config: ${name}`);
		}
	}

	return {
		sourcePath: loadedSources.length > 0 ? loadedSources.join(", ") : null,
		servers: Array.from(serversByName.values()),
		warnings,
	};
}

function sanitizeName(value: string): string {
	return value
		.toLowerCase()
		.replace(/[^a-z0-9_]+/g, "_")
		.replace(/^_+|_+$/g, "")
		.slice(0, 80);
}

function buildPiToolName(serverName: string, toolName: string): string {
	const safeServer = sanitizeName(serverName) || "server";
	const safeTool = sanitizeName(toolName) || "tool";
	return `mcp_${safeServer}_${safeTool}`;
}

function mimeToExt(mimeType: string): string {
	switch (mimeType) {
		case "image/png":
			return "png";
		case "image/jpeg":
			return "jpg";
		case "image/gif":
			return "gif";
		case "image/webp":
			return "webp";
		case "image/svg+xml":
			return "svg";
		default:
			return "png";
	}
}

type FormattedToolResult = { text: string; imagePaths: string[] };

function formatToolResult(result: unknown): FormattedToolResult {
	const imagePaths: string[] = [];

	if (typeof result === "string") return { text: result, imagePaths };

	if (result && typeof result === "object") {
		const maybe = result as {
			content?: Array<{ type?: string; text?: string; data?: string; mimeType?: string }>;
			structuredContent?: unknown;
		};

		if (Array.isArray(maybe.content)) {
			const chunks = maybe.content
				.map((item) => {
					if (item?.type === "text") return item.text ?? "";
					if (item?.type === "image" && item.data) {
						const ext = mimeToExt(item.mimeType ?? "image/png");
						const tmpFile = path.join(
							os.tmpdir(),
							`mcp-image-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`,
						);
						try {
							fs.writeFileSync(tmpFile, Buffer.from(item.data, "base64"));
							imagePaths.push(tmpFile);
							return `[Image saved: ${tmpFile}]`;
						} catch {
							return `[Image save failed: ${item.mimeType}, ${item.data.length} chars]`;
						}
					}
					return JSON.stringify(item);
				})
				.filter(Boolean);
			if (chunks.length > 0) return { text: chunks.join("\n"), imagePaths };
		}

		if (maybe.structuredContent !== undefined) {
			return { text: JSON.stringify(maybe.structuredContent, null, 2), imagePaths };
		}
	}

	return { text: JSON.stringify(result, null, 2), imagePaths };
}

type JsonSchemaProp = {
	type?: string;
	description?: string;
	enum?: unknown[];
	items?: { type?: string };
};

/**
 * Map a single JSON Schema property to the appropriate TypeBox type.
 * Preserves type, description, and enum information so the LLM receives
 * accurate type hints and the framework can validate/coerce values.
 */
function mapPropertyType(prop: JsonSchemaProp): ReturnType<typeof Type.Any> {
	const opts: Record<string, unknown> = {};
	if (typeof prop.description === "string") opts.description = prop.description;

	switch (prop.type) {
		case "string":
			if (Array.isArray(prop.enum) && prop.enum.every((v): v is string => typeof v === "string")) {
				return Type.Union(
					prop.enum.map((v) => Type.Literal(v)),
					opts,
				) as unknown as ReturnType<typeof Type.Any>;
			}
			return Type.String(opts) as unknown as ReturnType<typeof Type.Any>;
		case "boolean":
			return Type.Boolean(opts) as unknown as ReturnType<typeof Type.Any>;
		case "number":
			return Type.Number(opts) as unknown as ReturnType<typeof Type.Any>;
		case "integer":
			return Type.Integer(opts) as unknown as ReturnType<typeof Type.Any>;
		case "array":
			return Type.Array(Type.Any(), opts) as unknown as ReturnType<typeof Type.Any>;
		default:
			return Type.Any(opts);
	}
}

function createParameterSchema(inputSchema: Record<string, unknown>): ReturnType<typeof Type.Object> {
	const schema = inputSchema as {
		type?: string;
		properties?: Record<string, JsonSchemaProp>;
		required?: string[];
	};

	if (schema.type !== "object" || !schema.properties) {
		return Type.Object({});
	}

	const required = new Set(schema.required ?? []);
	const properties: Record<string, ReturnType<typeof Type.Any>> = {};

	for (const [key, prop] of Object.entries(schema.properties)) {
		const base = mapPropertyType(prop);

		if (required.has(key)) {
			properties[key] = base;
		} else {
			properties[key] = Type.Optional(base) as unknown as ReturnType<typeof Type.Any>;
		}
	}

	return Type.Object(properties, { additionalProperties: true });
}

// ── Overlay shared helpers ────────────────────────────────────

type McpServerState = {
	name: string;
	status: ServerStatus;
	type: string;
	toolCount: number;
	error?: string;
};

type ServerAction = "viewTools" | "reconnect";

function sColor(status: ServerStatus): "success" | "error" | "warning" | "muted" {
	switch (status) {
		case "connected":
			return "success";
		case "error":
			return "error";
		case "disconnected":
			return "warning";
		default:
			return "muted";
	}
}

function sIcon(status: ServerStatus): string {
	switch (status) {
		case "connected":
			return "●";
		case "error":
			return "✗";
		case "disconnected":
			return "○";
		default:
			return "◐";
	}
}

function boxTop(th: Theme, title: string, innerW: number): string {
	const t = ` ${title} `;
	const tW = visibleWidth(t);
	const p1 = Math.floor((innerW - tW) / 2);
	const p2 = Math.max(0, innerW - tW - p1);
	return th.fg("border", "╭" + "─".repeat(p1)) + th.fg("accent", th.bold(t)) + th.fg("border", "─".repeat(p2) + "╮");
}

function boxSep(th: Theme, innerW: number): string {
	return th.fg("border", "├" + "─".repeat(innerW) + "┤");
}

function boxBot(th: Theme, innerW: number): string {
	return th.fg("border", "╰" + "─".repeat(innerW) + "╯");
}

function boxRow(th: Theme, content: string, innerW: number): string {
	return th.fg("border", "│") + truncateToWidth(` ${content}`, innerW, "…", true) + th.fg("border", "│");
}

// ── Overlay 1: Server list (navigable) ───────────────────────

class McpStatusOverlay {
	private tui: TUI;
	private theme: Theme;
	private done: (value: string | null) => void;
	private states: McpServerState[];
	private sourcePath: string | null;
	private warnings: string[];
	private sel = 0;

	constructor(
		tui: TUI,
		theme: Theme,
		done: (value: string | null) => void,
		states: McpServerState[],
		sourcePath: string | null,
		warnings: string[],
	) {
		this.tui = tui;
		this.theme = theme;
		this.done = done;
		this.states = states;
		this.sourcePath = sourcePath;
		this.warnings = warnings;
	}

	handleInput(data: string): void {
		if (matchesKey(data, "escape") || data === "q") {
			this.done(null);
		} else if (matchesKey(data, "up") || data === "k") {
			this.sel = Math.max(0, this.sel - 1);
			this.tui.requestRender();
		} else if (matchesKey(data, "down") || data === "j") {
			this.sel = Math.min(this.states.length - 1, this.sel + 1);
			this.tui.requestRender();
		} else if (matchesKey(data, "return")) {
			if (this.states.length > 0) this.done(this.states[this.sel]!.name);
		}
	}

	invalidate(): void {}

	render(width: number): string[] {
		const th = this.theme;
		const iW = Math.max(1, width - 2);
		const lines: string[] = [];

		lines.push(boxTop(th, "MCP Server Status", iW));
		if (this.sourcePath) {
			lines.push(boxRow(th, th.fg("muted", `Source: ${this.sourcePath}`), iW));
		}
		lines.push(boxSep(th, iW));

		for (let i = 0; i < this.states.length; i++) {
			const st = this.states[i]!;
			const c = sColor(st.status);
			const ico = sIcon(st.status);
			const sel = i === this.sel;
			const cursor = sel ? th.fg("accent", "▸") : " ";
			const name = sel ? th.fg("accent", th.bold(st.name)) : st.name;
			const tools = st.toolCount > 0 ? th.fg("muted", ` ${st.toolCount} tools`) : "";
			const err = st.error ? `  ${th.fg("error", "⚠")}` : "";
			lines.push(boxRow(th, `${cursor} ${th.fg(c, ico)} ${name}  ${th.fg("muted", st.type)}${tools}${err}`, iW));
		}

		if (this.warnings.length > 0) {
			lines.push(boxSep(th, iW));
			lines.push(boxRow(th, th.fg("warning", `⚠ ${this.warnings.length} warning(s)`), iW));
		}

		lines.push(boxSep(th, iW));
		lines.push(boxRow(th, th.fg("muted", "↑↓ navigate · enter select · ESC close"), iW));
		lines.push(boxBot(th, iW));
		return lines;
	}
}

// ── Overlay 2: Server action menu ────────────────────────────

class McpActionOverlay {
	private tui: TUI;
	private theme: Theme;
	private done: (value: ServerAction | null) => void;
	private state: McpServerState;
	private actions: Array<{ id: ServerAction; label: string; hint: string }> = [
		{ id: "viewTools", label: "View Tools", hint: "List registered tools" },
		{ id: "reconnect", label: "Reconnect", hint: "Disconnect & reconnect" },
	];
	private sel = 0;

	constructor(tui: TUI, theme: Theme, done: (value: ServerAction | null) => void, state: McpServerState) {
		this.tui = tui;
		this.theme = theme;
		this.done = done;
		this.state = state;
	}

	handleInput(data: string): void {
		if (matchesKey(data, "escape")) {
			this.done(null);
		} else if (matchesKey(data, "up") || data === "k") {
			this.sel = Math.max(0, this.sel - 1);
			this.tui.requestRender();
		} else if (matchesKey(data, "down") || data === "j") {
			this.sel = Math.min(this.actions.length - 1, this.sel + 1);
			this.tui.requestRender();
		} else if (matchesKey(data, "return")) {
			this.done(this.actions[this.sel]!.id);
		}
	}

	invalidate(): void {}

	render(width: number): string[] {
		const th = this.theme;
		const iW = Math.max(1, width - 2);
		const { state: st } = this;
		const c = sColor(st.status);
		const ico = sIcon(st.status);
		const lines: string[] = [];

		lines.push(boxTop(th, st.name, iW));
		lines.push(boxRow(th, `${th.fg(c, `${ico} ${st.status}`)}  ${th.fg("muted", st.type)}`, iW));
		if (st.toolCount > 0) {
			lines.push(boxRow(th, th.fg("muted", `${st.toolCount} tools registered`), iW));
		}
		if (st.error) {
			lines.push(boxRow(th, th.fg("error", `⚠ ${st.error}`), iW));
		}
		lines.push(boxSep(th, iW));

		for (let i = 0; i < this.actions.length; i++) {
			const a = this.actions[i]!;
			const sel = i === this.sel;
			const cursor = sel ? th.fg("accent", "▸") : " ";
			const label = sel ? th.fg("accent", th.bold(a.label)) : a.label;
			lines.push(boxRow(th, `${cursor} ${label}  ${th.fg("muted", a.hint)}`, iW));
		}

		lines.push(boxSep(th, iW));
		lines.push(boxRow(th, th.fg("muted", "↑↓ navigate · enter select · ESC back"), iW));
		lines.push(boxBot(th, iW));
		return lines;
	}
}

// ── Overlay 3: Tool list ─────────────────────────────────────

class McpToolListOverlay {
	private tui: TUI;
	private theme: Theme;
	private onClose: () => void;
	private serverName: string;
	private tools: DiscoveredTool[];
	private scroll = 0;
	private maxVisible = 15;

	constructor(tui: TUI, theme: Theme, onClose: () => void, serverName: string, tools: DiscoveredTool[]) {
		this.tui = tui;
		this.theme = theme;
		this.onClose = onClose;
		this.serverName = serverName;
		this.tools = tools;
	}

	handleInput(data: string): void {
		if (matchesKey(data, "escape")) {
			this.onClose();
		} else if (matchesKey(data, "up") || data === "k") {
			this.scroll = Math.max(0, this.scroll - 1);
			this.tui.requestRender();
		} else if (matchesKey(data, "down") || data === "j") {
			this.scroll = Math.min(Math.max(0, this.tools.length - this.maxVisible), this.scroll + 1);
			this.tui.requestRender();
		}
	}

	invalidate(): void {}

	render(width: number): string[] {
		const th = this.theme;
		const iW = Math.max(1, width - 2);
		const lines: string[] = [];

		lines.push(boxTop(th, `${this.serverName} · Tools`, iW));

		if (this.tools.length === 0) {
			lines.push(boxRow(th, th.fg("muted", "No tools available"), iW));
		} else {
			const slice = this.tools.slice(this.scroll, this.scroll + this.maxVisible);
			for (const tool of slice) {
				const piName = buildPiToolName(this.serverName, tool.name);
				lines.push(boxRow(th, th.fg("accent", piName), iW));
				if (tool.description) {
					lines.push(boxRow(th, th.fg("muted", tool.description), iW));
				}
			}
			if (this.tools.length > this.maxVisible) {
				lines.push(boxSep(th, iW));
				const info = `${this.scroll + 1}–${Math.min(this.scroll + this.maxVisible, this.tools.length)} of ${this.tools.length}`;
				lines.push(boxRow(th, th.fg("muted", info), iW));
			}
		}

		lines.push(boxSep(th, iW));
		lines.push(boxRow(th, th.fg("muted", "↑↓ scroll · ESC back"), iW));
		lines.push(boxBot(th, iW));
		return lines;
	}
}

export default async function claudeMcpBridge(pi: ExtensionAPI) {
	const manager = new McpManager();
	const registeredTools = new Set<string>();
	let loadedAt: LoadedConfig = { sourcePath: null, servers: [], warnings: [] };

	function updateStatus(ctx: ExtensionContext): void {
		if (!ctx.hasUI) return;
		const states = manager.getStates();
		const total = states.length;
		if (total === 0) {
			ctx.ui.setStatus("mcp", undefined);
			return;
		}
		const connected = states.filter((s) => s.status === "connected").length;
		const icon = connected === total ? "●" : connected > 0 ? "◐" : "○";
		ctx.ui.setStatus("mcp", `${icon} MCP ${connected}/${total}`);
	}

	function registerDiscoveredTools(): void {
		for (const { serverName, tool } of manager.getAllTools()) {
			const piToolName = buildPiToolName(serverName, tool.name);
			if (registeredTools.has(piToolName)) continue;

			pi.registerTool({
				name: piToolName,
				label: `MCP ${serverName}/${tool.name}`,
				description: tool.description ?? `MCP tool ${serverName}/${tool.name}`,
				parameters: createParameterSchema(tool.inputSchema),
				async execute(_toolCallId, params, signal, onUpdate, _ctx) {
					if (signal?.aborted) {
						return {
							content: [{ type: "text" as const, text: "Cancelled" }],
							details: { server: serverName, tool: tool.name, cancelled: true },
						};
					}

					onUpdate?.({
						content: [{ type: "text" as const, text: `Calling MCP ${serverName}/${tool.name}...` }],
						details: { server: serverName, tool: tool.name, status: "running" },
					});

					try {
						const result = await manager.callTool(serverName, tool.name, params as Record<string, unknown>);
						const formatted = formatToolResult(result);
						const content: Array<{ type: "text"; text: string }> = [{ type: "text", text: formatted.text }];
						for (const imgPath of formatted.imagePaths) {
							content.push({ type: "text", text: `📎 Use Read tool to view: ${imgPath}` });
						}
						return {
							content,
							details: {
								server: serverName,
								tool: tool.name,
								raw: result,
								isError: Boolean((result as { isError?: boolean })?.isError),
							},
						};
					} catch (error) {
						const message = error instanceof Error ? error.message : String(error);
						return {
							content: [{ type: "text" as const, text: `MCP error: ${message}` }],
							details: { server: serverName, tool: tool.name, error: message, isError: true },
						};
					}
				},
			});

			registeredTools.add(piToolName);
		}
	}

	async function loadAndConnect(cwd: string): Promise<LoadedConfig> {
		const loaded = loadConfig(cwd);
		await manager.replaceServers(loaded.servers, loaded.sourcePath);
		await manager.connectAll();
		registerDiscoveredTools();
		loadedAt = loaded;
		return loaded;
	}

	// IMPORTANT: register MCP tools during extension load so pi includes them in tool registry.
	// NOTE(user-approved): 초기 연결 실패 시 재시도/도구 재등록 강화는 현재 동작을 유지한다.
	await loadAndConnect(process.cwd());

	pi.on("session_start", async (_event, ctx) => {
		updateStatus(ctx);
	});

	pi.on("session_shutdown", async () => {
		await manager.disconnectAll();
	});

	pi.registerCommand("mcp-status", {
		description: "Show MCP server connection status",
		handler: async (_args, ctx) => {
			if (manager.getStates().length === 0) {
				ctx.ui.notify("MCP: no configured servers", "warning");
				return;
			}

			if (!ctx.hasUI) {
				const states = manager.getStates();
				const summary = states
					.map((s) => `${s.name}=${s.status}${s.toolCount > 0 ? `(${s.toolCount})` : ""}`)
					.join(", ");
				const sourceText = manager.sourcePath ? ` | source: ${manager.sourcePath}` : "";
				ctx.ui.notify(`MCP: ${summary}${sourceText}`, "info");
				return;
			}

			// Loop: server list → action menu → sub-view, then back
			serverList: while (true) {
				const freshStates = manager.getStates();
				const serverName = await ctx.ui.custom<string | null>(
					(tui, theme, _kb, done) =>
						new McpStatusOverlay(tui, theme, done, freshStates, manager.sourcePath, loadedAt.warnings),
					{ overlay: true, overlayOptions: { anchor: "center", width: "80%", minWidth: 50, maxHeight: "80%" } },
				);
				if (!serverName) break;

				// Action menu for selected server
				actionMenu: while (true) {
					const serverState = manager.getStates().find((s) => s.name === serverName);
					if (!serverState) break;

					const action = await ctx.ui.custom<ServerAction | null>(
						(tui, theme, _kb, done) => new McpActionOverlay(tui, theme, done, serverState),
						{ overlay: true, overlayOptions: { anchor: "center", width: "80%", minWidth: 50, maxHeight: "80%" } },
					);

					if (action === "viewTools") {
						const tools = manager.getServerTools(serverName);
						await ctx.ui.custom<null>(
							(tui, theme, _kb, done) => new McpToolListOverlay(tui, theme, () => done(null), serverName, tools),
							{ overlay: true, overlayOptions: { anchor: "center", width: "80%", minWidth: 50, maxHeight: "80%" } },
						);
						continue actionMenu;
					}

					if (action === "reconnect") {
						await manager.reconnectServer(serverName);
						registerDiscoveredTools();
						updateStatus(ctx);
						const updated = manager.getStates().find((s) => s.name === serverName);
						if (updated?.status === "connected") {
							ctx.ui.notify(`${serverName}: reconnected (${updated.toolCount} tools)`, "info");
						} else {
							ctx.ui.notify(
								`${serverName}: ${updated?.status ?? "unknown"}${updated?.error ? ` – ${updated.error}` : ""}`,
								"warning",
							);
						}
						continue serverList;
					}

					// null (ESC) → back to server list
					continue serverList;
				}
			}
		},
	});

	pi.registerCommand("mcp-reload", {
		description: "Reload MCP config and runtime",
		handler: async (_args, ctx) => {
			if (ctx.hasUI) ctx.ui.notify("Reloading runtime to apply MCP changes...", "info");
			await ctx.reload();
		},
	});
}
