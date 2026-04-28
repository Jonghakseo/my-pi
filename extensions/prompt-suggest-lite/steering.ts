import type { SteeringClassification } from "./shared.ts";

export type SteeringClassificationResult = {
	classification: SteeringClassification;
	similarity: number;
};

function normalizeText(value: string): string {
	return value.toLowerCase().replace(/\s+/g, " ").replace(/[“”]/g, '"').replace(/[‘’]/g, "'").trim();
}

function tokenSet(value: string): Set<string> {
	return new Set(value.split(/[^\p{L}\p{N}]+/u).filter(Boolean));
}

function jaccard(a: Set<string>, b: Set<string>): number {
	if (a.size === 0 && b.size === 0) return 1;
	let intersection = 0;
	for (const value of a) if (b.has(value)) intersection += 1;
	const union = new Set([...a, ...b]).size;
	return union === 0 ? 0 : intersection / union;
}

function lcsLength(a: string, b: string): number {
	const rows = a.length + 1;
	const cols = b.length + 1;
	const dp = Array.from({ length: rows }, () => new Array<number>(cols).fill(0));
	for (let i = 1; i < rows; i += 1) {
		for (let j = 1; j < cols; j += 1) {
			if (a[i - 1] === b[j - 1]) dp[i][j] = dp[i - 1][j - 1] + 1;
			else dp[i][j] = Math.max(dp[i - 1]?.[j] ?? 0, dp[i]?.[j - 1] ?? 0);
		}
	}
	return dp[a.length]?.[b.length] ?? 0;
}

function sequenceSimilarity(a: string, b: string): number {
	if (!a && !b) return 1;
	const lcs = lcsLength(a, b);
	return (2 * lcs) / Math.max(1, a.length + b.length);
}

export function classifySteering(suggestedPrompt: string, actualUserPrompt: string): SteeringClassificationResult {
	const suggested = normalizeText(suggestedPrompt);
	const actual = normalizeText(actualUserPrompt);
	if (suggested === actual) {
		return {
			classification: "accepted_exact",
			similarity: 1,
		};
	}

	const similarity = (jaccard(tokenSet(suggested), tokenSet(actual)) + sequenceSimilarity(suggested, actual)) / 2;
	return {
		classification: similarity >= 0.82 ? "accepted_edited" : "changed_course",
		similarity,
	};
}
