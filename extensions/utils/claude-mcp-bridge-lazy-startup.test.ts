import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const originalCwd = process.cwd();
const originalHome = process.env.HOME;
const originalUserProfile = process.env.USERPROFILE;
const tempDirs: string[] = [];

afterEach(() => {
	process.chdir(originalCwd);
	if (originalHome === undefined) Reflect.deleteProperty(process.env, "HOME");
	else process.env.HOME = originalHome;
	if (originalUserProfile === undefined) Reflect.deleteProperty(process.env, "USERPROFILE");
	else process.env.USERPROFILE = originalUserProfile;
	for (const dir of tempDirs.splice(0)) {
		fs.rmSync(dir, { recursive: true, force: true });
	}
	vi.resetModules();
	vi.clearAllMocks();
	vi.unmock("@modelcontextprotocol/sdk/client/index.js");
	vi.unmock("@modelcontextprotocol/sdk/client/stdio.js");
	vi.unmock("@modelcontextprotocol/sdk/client/sse.js");
	vi.unmock("@modelcontextprotocol/sdk/client/streamableHttp.js");
});

function makeTempDir(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-mcp-lazy-"));
	tempDirs.push(dir);
	return dir;
}

function writeJson(filePath: string, value: unknown): void {
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf-8");
}

type RegisteredTool = {
	name: string;
	execute?: (
		toolCallId: string,
		params: Record<string, unknown>,
		signal?: AbortSignal,
		onUpdate?: unknown,
		ctx?: unknown,
	) => Promise<{ details?: Record<string, unknown> }>;
};

function createPi() {
	const tools: RegisteredTool[] = [];
	return {
		api: {
			on: vi.fn(),
			registerTool: vi.fn((definition: RegisteredTool) => {
				tools.push(definition);
			}),
			registerCommand: vi.fn(),
			getActiveTools: vi.fn(() => []),
			setActiveTools: vi.fn(),
		},
		tools,
	};
}

describe("claude MCP lazy startup", () => {
	it("registers cached tools without waiting for connect", async () => {
		const homeDir = makeTempDir();
		const cwd = makeTempDir();
		process.env.HOME = homeDir;
		process.env.USERPROFILE = homeDir;
		process.chdir(cwd);

		const configPath = path.join(cwd, ".mcp.json");
		writeJson(configPath, {
			mcpServers: {
				jira: {
					command: "node",
					args: ["server.js"],
				},
			},
		});

		vi.doMock("../claude-mcp-bridge/metadata-cache.js", async () => {
			const actual = await import("../claude-mcp-bridge/metadata-cache.ts");
			return {
				...actual,
				loadMetadataCache: vi.fn(() => ({ version: 1, profiles: {} })),
				getMetadataProfile: vi.fn(() => ({
					configHash: "cfg",
					servers: {
						jira: {
							savedAt: Date.now(),
							serverHash: "hash",
							tools: [
								{
									name: "search",
									description: "Search issues",
									inputSchema: { type: "object", properties: {} },
								},
							],
						},
					},
				})),
				resolveStartupCache: vi.fn(() => ({
					usableEntries: {
						jira: {
							serverName: "jira",
							compatibility: "hit",
							entry: {
								savedAt: Date.now(),
								serverHash: "hash",
								tools: [
									{
										name: "search",
										description: "Search issues",
										inputSchema: { type: "object", properties: {} },
									},
								],
							},
						},
					},
					classifications: { jira: "hit" },
				})),
				writeMetadataProfileAtomic: vi.fn(),
			};
		});

		let resolveConnect: (() => void) | undefined;
		const connectPromise = new Promise<void>((resolve) => {
			resolveConnect = resolve;
		});

		const connectMock = vi.fn(() => connectPromise);
		const listToolsMock = vi.fn(async () => ({ tools: [] }));
		const callToolMock = vi.fn();
		const closeMock = vi.fn(async () => undefined);

		vi.doMock("@modelcontextprotocol/sdk/client/index.js", () => ({
			Client: class {
				onclose?: () => void;
				onerror?: (error: Error) => void;
				connect = connectMock;
				listTools = listToolsMock;
				callTool = callToolMock;
				close = closeMock;
			},
		}));
		vi.doMock("@modelcontextprotocol/sdk/client/stdio.js", () => ({
			StdioClientTransport: class {
				async close() {}
			},
		}));
		vi.doMock("@modelcontextprotocol/sdk/client/sse.js", () => ({
			SSEClientTransport: class {
				async close() {}
			},
		}));
		vi.doMock("@modelcontextprotocol/sdk/client/streamableHttp.js", () => ({
			StreamableHTTPClientTransport: class {
				async close() {}
			},
		}));

		const mod = await import("../claude-mcp-bridge/index.ts");
		const pi = createPi();

		await expect(
			Promise.race([
				mod.default(pi.api as never),
				new Promise((_, reject) => setTimeout(() => reject(new Error("startup blocked")), 100)),
			]),
		).resolves.toBeUndefined();

		expect(pi.tools.map((tool) => tool.name)).toContain("mcp_jira_search");

		resolveConnect?.();
		await Promise.resolve();
	});
});
