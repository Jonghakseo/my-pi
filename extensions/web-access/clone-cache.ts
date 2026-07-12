/**
 * GitHub clone cache shared between the startup path (session cleanup) and
 * the lazily-loaded github-extract module. Kept tiny so runtime.ts can clear
 * clones without importing the heavy extract module graph.
 */
import { rmSync } from "node:fs";

export interface CachedClone {
	localPath: string;
	clonePromise: Promise<string | null>;
}

export const cloneCache = new Map<string, CachedClone>();

const clearCallbacks: Array<() => void> = [];

/** Lets lazily-loaded modules reset their own caches when clones are cleared. */
export function onCloneCacheClear(callback: () => void): void {
	clearCallbacks.push(callback);
}

export function clearCloneCache(): void {
	for (const entry of cloneCache.values()) {
		try {
			rmSync(entry.localPath, { recursive: true, force: true });
		} catch {}
	}
	cloneCache.clear();
	for (const callback of clearCallbacks) callback();
}
