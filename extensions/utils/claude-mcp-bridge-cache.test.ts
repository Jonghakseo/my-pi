import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
	type CacheableServerConfig,
	createConfigScopeKey,
	emptyMetadataCache,
	hashCacheableServer,
	loadMetadataCache,
	METADATA_CACHE_TTL_MS,
	resolveStartupCache,
	writeMetadataProfileAtomic,
} from "../claude-mcp-bridge/metadata-cache.ts";

function makeTempDir(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), "pi-mcp-cache-"));
}

function makeServer(name: string): CacheableServerConfig {
	return {
		name,
		type: "stdio",
		enabled: true,
		command: "node",
		args: ["server.js"],
		env: {},
	};
}

const tempDirs: string[] = [];

afterEach(() => {
	for (const dir of tempDirs.splice(0)) {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

describe("claude MCP metadata cache", () => {
	it("falls back to empty cache for invalid files", () => {
		const dir = makeTempDir();
		tempDirs.push(dir);
		const filePath = path.join(dir, "cache.json");
		fs.writeFileSync(filePath, "{not-json", "utf-8");

		expect(loadMetadataCache(filePath)).toEqual(emptyMetadataCache());
	});

	it("distinguishes hit, ttl stale, and incompatible entries", () => {
		const jira = makeServer("jira");
		const slack = makeServer("slack");
		const now = 1_700_000_000_000;
		const jiraHash = hashCacheableServer(jira);
		const slackHash = hashCacheableServer(slack);

		const resolution = resolveStartupCache({
			profile: {
				configHash: "cfg",
				servers: {
					jira: {
						savedAt: now,
						serverHash: jiraHash,
						tools: [{ name: "search", inputSchema: {} }],
					},
					slack: {
						savedAt: now - METADATA_CACHE_TTL_MS - 1,
						serverHash: slackHash,
						tools: [{ name: "post", inputSchema: {} }],
					},
				},
			},
			serverHashes: {
				jira: jiraHash,
				slack: slackHash,
				figma: "different-hash",
			},
			now,
		});

		expect(resolution.classifications).toEqual({
			jira: "hit",
			slack: "ttl_stale",
			figma: "missing",
		});
		expect(Object.keys(resolution.usableEntries)).toEqual(["jira", "slack"]);

		const incompatible = resolveStartupCache({
			profile: {
				configHash: "cfg",
				servers: {
					jira: {
						savedAt: now,
						serverHash: "old-hash",
						tools: [{ name: "search", inputSchema: {} }],
					},
				},
			},
			serverHashes: { jira: jiraHash },
			now,
		});

		expect(incompatible.classifications.jira).toBe("incompatible");
		expect(incompatible.usableEntries.jira).toBeUndefined();
	});

	it("writes one scope bucket without deleting others", () => {
		const dir = makeTempDir();
		tempDirs.push(dir);
		const filePath = path.join(dir, "cache.json");
		const jira = makeServer("jira");
		const scopeA = createConfigScopeKey({ sourcePaths: ["/tmp/a/.mcp.json"], servers: [jira] });
		const scopeB = createConfigScopeKey({ sourcePaths: ["/tmp/b/.mcp.json"], servers: [jira] });

		writeMetadataProfileAtomic({
			filePath,
			scopeKey: scopeA,
			profile: {
				configHash: "a",
				servers: {
					jira: { savedAt: 1, serverHash: hashCacheableServer(jira), tools: [{ name: "search", inputSchema: {} }] },
				},
			},
		});
		writeMetadataProfileAtomic({
			filePath,
			scopeKey: scopeB,
			profile: {
				configHash: "b",
				servers: {
					jira: { savedAt: 2, serverHash: hashCacheableServer(jira), tools: [{ name: "post", inputSchema: {} }] },
				},
			},
		});

		const loaded = loadMetadataCache(filePath);
		expect(Object.keys(loaded.profiles).sort()).toEqual([scopeA, scopeB].sort());
		expect(loaded.profiles[scopeA]?.servers.jira?.tools[0]?.name).toBe("search");
		expect(loaded.profiles[scopeB]?.servers.jira?.tools[0]?.name).toBe("post");
	});
});
