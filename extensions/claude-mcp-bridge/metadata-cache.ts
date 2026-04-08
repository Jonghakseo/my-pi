import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const METADATA_CACHE_PATH = path.join(os.homedir(), ".pi", "agent", "claude-mcp-bridge-cache.json");
export const METADATA_CACHE_VERSION = 1;
export const METADATA_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1_000;

export type CachedToolMetadata = {
	name: string;
	description?: string;
	inputSchema: Record<string, unknown>;
};

export type CachedServerMetadata = {
	savedAt: number;
	serverHash: string;
	tools: CachedToolMetadata[];
};

export type MetadataCacheProfile = {
	configHash: string;
	servers: Record<string, CachedServerMetadata>;
};

export type MetadataCacheFile = {
	version: number;
	profiles: Record<string, MetadataCacheProfile>;
};

export type CacheableServerConfig =
	| {
			name: string;
			type: "stdio";
			enabled: true;
			command: string;
			args: string[];
			env: Record<string, string>;
			cwd?: string;
	  }
	| {
			name: string;
			type: "sse" | "http";
			enabled: true;
			url: string;
			headers: Record<string, string>;
	  };

export type StartupCacheCompatibility = "hit" | "ttl_stale" | "missing" | "incompatible";

export type StartupCacheEntry = {
	serverName: string;
	entry: CachedServerMetadata;
	compatibility: Extract<StartupCacheCompatibility, "hit" | "ttl_stale">;
};

export type StartupCacheResolution = {
	usableEntries: Record<string, StartupCacheEntry>;
	classifications: Record<string, StartupCacheCompatibility>;
};

function sortValue(value: unknown): unknown {
	if (Array.isArray(value)) {
		return value.map(sortValue);
	}
	if (value && typeof value === "object") {
		return Object.fromEntries(
			Object.entries(value as Record<string, unknown>)
				.sort(([a], [b]) => a.localeCompare(b))
				.map(([key, nested]) => [key, sortValue(nested)]),
		);
	}
	return value;
}

function stableStringify(value: unknown): string {
	return JSON.stringify(sortValue(value));
}

function hashValue(value: unknown): string {
	return crypto.createHash("sha256").update(stableStringify(value)).digest("hex");
}

export function hashCacheableServer(server: CacheableServerConfig): string {
	return hashValue(server);
}

export function hashCacheableConfig(servers: CacheableServerConfig[]): string {
	const sortedServers = [...servers].sort((a, b) => a.name.localeCompare(b.name));
	return hashValue(sortedServers);
}

export function createConfigScopeKey(args: { sourcePaths: string[]; servers: CacheableServerConfig[] }): string {
	const sortedSourcePaths = [...args.sourcePaths].sort((a, b) => a.localeCompare(b));
	const sortedServers = [...args.servers].map(sortValue).sort((a, b) => {
		const aName = typeof a === "object" && a && "name" in a ? String((a as { name: string }).name) : "";
		const bName = typeof b === "object" && b && "name" in b ? String((b as { name: string }).name) : "";
		return aName.localeCompare(bName);
	});
	return hashValue({ sourcePaths: sortedSourcePaths, servers: sortedServers });
}

export function emptyMetadataCache(): MetadataCacheFile {
	return { version: METADATA_CACHE_VERSION, profiles: {} };
}

export function loadMetadataCache(filePath: string = METADATA_CACHE_PATH): MetadataCacheFile {
	if (!fs.existsSync(filePath)) return emptyMetadataCache();
	try {
		const raw = JSON.parse(fs.readFileSync(filePath, "utf-8")) as Partial<MetadataCacheFile>;
		if (!raw || typeof raw !== "object") return emptyMetadataCache();
		if (raw.version !== METADATA_CACHE_VERSION) return emptyMetadataCache();
		if (!raw.profiles || typeof raw.profiles !== "object") return emptyMetadataCache();
		return { version: METADATA_CACHE_VERSION, profiles: raw.profiles as Record<string, MetadataCacheProfile> };
	} catch {
		return emptyMetadataCache();
	}
}

export function getMetadataProfile(cache: MetadataCacheFile, scopeKey: string): MetadataCacheProfile | undefined {
	return cache.profiles[scopeKey];
}

export function cloneMetadataProfile(profile?: MetadataCacheProfile): MetadataCacheProfile {
	if (!profile) {
		return { configHash: "", servers: {} };
	}
	return {
		configHash: profile.configHash,
		servers: Object.fromEntries(
			Object.entries(profile.servers).map(([serverName, entry]) => [
				serverName,
				{
					savedAt: entry.savedAt,
					serverHash: entry.serverHash,
					tools: entry.tools.map((tool) => ({
						name: tool.name,
						description: tool.description,
						inputSchema: structuredClone(tool.inputSchema),
					})),
				},
			]),
		),
	};
}

export function resolveStartupCache(args: {
	profile?: MetadataCacheProfile;
	serverHashes: Record<string, string>;
	now?: number;
	ttlMs?: number;
}): StartupCacheResolution {
	const now = args.now ?? Date.now();
	const ttlMs = args.ttlMs ?? METADATA_CACHE_TTL_MS;
	const usableEntries: Record<string, StartupCacheEntry> = {};
	const classifications: Record<string, StartupCacheCompatibility> = {};

	for (const [serverName, serverHash] of Object.entries(args.serverHashes)) {
		const entry = args.profile?.servers[serverName];
		if (!entry) {
			classifications[serverName] = "missing";
			continue;
		}
		if (entry.serverHash !== serverHash) {
			classifications[serverName] = "incompatible";
			continue;
		}
		const compatibility: StartupCacheEntry["compatibility"] = now - entry.savedAt > ttlMs ? "ttl_stale" : "hit";
		usableEntries[serverName] = { serverName, entry, compatibility };
		classifications[serverName] = compatibility;
	}

	return { usableEntries, classifications };
}

function readCacheFileText(filePath: string): string {
	if (!fs.existsSync(filePath)) return "";
	return fs.readFileSync(filePath, "utf-8");
}

export function writeMetadataProfileAtomic(args: {
	scopeKey: string;
	profile: MetadataCacheProfile;
	filePath?: string;
	maxRetries?: number;
}): void {
	const filePath = args.filePath ?? METADATA_CACHE_PATH;
	const parentDir = path.dirname(filePath);
	const maxRetries = Math.max(1, args.maxRetries ?? 3);
	fs.mkdirSync(parentDir, { recursive: true });

	for (let attempt = 0; attempt < maxRetries; attempt += 1) {
		const baselineText = readCacheFileText(filePath);
		const current = baselineText ? loadMetadataCache(filePath) : emptyMetadataCache();
		const next: MetadataCacheFile = {
			version: METADATA_CACHE_VERSION,
			profiles: {
				...current.profiles,
				[args.scopeKey]: cloneMetadataProfile(args.profile),
			},
		};

		const tempPath = `${filePath}.${process.pid}.${Date.now()}.${attempt}.tmp`;
		try {
			fs.writeFileSync(tempPath, `${JSON.stringify(next, null, 2)}\n`, "utf-8");
			const latestText = readCacheFileText(filePath);
			if (latestText !== baselineText) {
				fs.rmSync(tempPath, { force: true });
				continue;
			}
			fs.renameSync(tempPath, filePath);
			return;
		} finally {
			if (fs.existsSync(tempPath)) {
				fs.rmSync(tempPath, { force: true });
			}
		}
	}

	throw new Error(`Failed to write MCP metadata cache after ${maxRetries} attempts`);
}
