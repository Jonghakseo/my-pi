/**
 * Pure data manipulation utilities.
 * No side effects, no pi SDK dependencies.
 */

/**
 * Count occurrences of each key in an array.
 *
 * Source: memory-layer/storage.ts
 */
export function countByKey(keys: string[]): Map<string, number> {
	const map = new Map<string, number>();
	for (const key of keys) {
		map.set(key, (map.get(key) ?? 0) + 1);
	}
	return map;
}

/**
 * Compare two string arrays for element-wise equality.
 *
 * Source: todos.ts
 */
export function sameStringArray(a: string[], b: string[]): boolean {
	if (a.length !== b.length) return false;
	for (let i = 0; i < a.length; i += 1) {
		if (a[i] !== b[i]) return false;
	}
	return true;
}

/**
 * Normalize an array of option values: deduplicate, trim, skip empties.
 *
 * Source: former ask-user-question extension
 */
export function normalizeOptions(raw: unknown): string[] {
	if (!Array.isArray(raw)) return [];
	const dedup = new Set<string>();
	for (const item of raw) {
		if (typeof item !== "string") continue;
		const normalized = item.trim();
		if (!normalized) continue;
		dedup.add(normalized);
	}
	return Array.from(dedup);
}

/**
 * Parse a comma-separated candidate list from an optional string,
 * falling back to a provided default list. Deduplicates values.
 *
 * Source: former voice input extension
 */
export function parseCandidateList(raw: string | undefined, fallback: string[]): string[] {
	const fromEnv = (raw ?? "")
		.split(",")
		.map((value) => value.trim())
		.filter((value) => value.length > 0);
	const values = fromEnv.length > 0 ? fromEnv : fallback;
	return Array.from(new Set(values));
}

/**
 * Return unique items from an array, keeping the first occurrence based on
 * a key function. Generic version of uniqueAgentsByName.
 *
 * Source: subagent/runner.ts (generalized)
 */
export function uniqueByKey<T>(items: T[], keyFn: (item: T) => string): T[] {
	const map = new Map<string, T>();
	for (const item of items) {
		const key = keyFn(item);
		if (!map.has(key)) map.set(key, item);
	}
	return Array.from(map.values());
}
