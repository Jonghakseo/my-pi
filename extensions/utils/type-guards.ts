/**
 * Type guard and safe conversion utilities.
 * Pure functions for narrowing unknown values to specific types.
 *
 * Source: github-overlay.ts
 */

/**
 * Narrow unknown to Record<string, unknown> or null.
 * Returns null for non-objects, arrays, and nullish values.
 */
export function asRecord(value: unknown): Record<string, unknown> | null {
	if (!value || typeof value !== "object" || Array.isArray(value)) return null;
	return value as Record<string, unknown>;
}

/**
 * Narrow unknown to a trimmed non-empty string or null.
 */
export function asString(value: unknown): string | null {
	if (typeof value !== "string") return null;
	const trimmed = value.trim();
	return trimmed.length ? trimmed : null;
}

/**
 * Narrow unknown to boolean or null.
 */
export function asBoolean(value: unknown): boolean | null {
	if (typeof value !== "boolean") return null;
	return value;
}

/**
 * Narrow unknown to a finite number or null.
 * Also parses numeric strings.
 */
export function asNumber(value: unknown): number | null {
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (typeof value === "string") {
		const parsed = Number(value);
		if (Number.isFinite(parsed)) return parsed;
	}
	return null;
}

/**
 * Narrow unknown to an array. Returns empty array for non-arrays.
 */
export function asArray(value: unknown): unknown[] {
	return Array.isArray(value) ? value : [];
}

/**
 * Safely parse JSON, returning null on failure.
 */
export function safeJsonParse<T>(text: string): T | null {
	try {
		return JSON.parse(text) as T;
	} catch {
		return null;
	}
}
