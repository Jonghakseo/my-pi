type JsonRecord = Record<string, unknown>;

export type AnthropicCacheTtl = "1h" | undefined;

function isRecord(value: unknown): value is JsonRecord {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Rewrites explicit Anthropic cache controls without mutating the provider payload.
 * `undefined` restores Anthropic's default 5-minute TTL by removing `ttl`.
 */
export function overrideAnthropicCacheTtl(payload: unknown, ttl: AnthropicCacheTtl): unknown {
	if (Array.isArray(payload)) {
		let changed = false;
		const next = payload.map((value) => {
			const rewritten = overrideAnthropicCacheTtl(value, ttl);
			changed ||= rewritten !== value;
			return rewritten;
		});
		return changed ? next : payload;
	}

	if (!isRecord(payload)) return payload;

	let changed = false;
	const next: JsonRecord = {};
	for (const [key, value] of Object.entries(payload)) {
		if (key === "cache_control" && isRecord(value) && value.type === "ephemeral") {
			const { ttl: _previousTtl, ...cacheControl } = value;
			next[key] = ttl ? { ...cacheControl, ttl } : cacheControl;
			changed = true;
			continue;
		}

		const rewritten = overrideAnthropicCacheTtl(value, ttl);
		next[key] = rewritten;
		changed ||= rewritten !== value;
	}

	return changed ? next : payload;
}
