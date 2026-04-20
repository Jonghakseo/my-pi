/** biome-ignore-all lint/style/noNonNullAssertion: vendored hashline compatibility logic preserves upstream matching semantics. */
import { replaceText } from "./hashline-edit-diff.ts";

export type LegacyTopLevelReplace = {
	oldText: string;
	newText: string;
	strategy: "legacy-top-level-replace";
};

export function extractLegacyTopLevelReplace(request: Record<string, unknown>): LegacyTopLevelReplace | null {
	if (Array.isArray(request.edits) && request.edits.length > 0) {
		return null;
	}

	const hasCamel = "oldText" in request || "newText" in request;
	const hasSnake = "old_text" in request || "new_text" in request;
	if (hasCamel && hasSnake) {
		return null;
	}

	if (typeof request.oldText === "string" && typeof request.newText === "string") {
		return {
			oldText: request.oldText,
			newText: request.newText,
			strategy: "legacy-top-level-replace",
		};
	}

	if (typeof request.old_text === "string" && typeof request.new_text === "string") {
		return {
			oldText: request.old_text,
			newText: request.new_text,
			strategy: "legacy-top-level-replace",
		};
	}

	return null;
}

export function applyExactUniqueLegacyReplace(
	content: string,
	oldText: string,
	newText: string,
): {
	content: string;
	matchCount: 1;
	usedFuzzyMatch: boolean;
} {
	if (oldText.length === 0) {
		throw new Error("Legacy compatibility replace requires non-empty oldText.");
	}

	const matches: number[] = [];
	let from = 0;
	while (from <= content.length - oldText.length) {
		const index = content.indexOf(oldText, from);
		if (index === -1) {
			break;
		}
		matches.push(index);
		from = index + 1; // Advance by 1 to detect all potential matches, including overlapping ones
	}

	// Check for overlapping matches: if any two matches are less than oldText.length apart,
	// they overlap and should be treated as ambiguous
	for (let i = 1; i < matches.length; i++) {
		if (matches[i]! - matches[i - 1]! < oldText.length) {
			throw new Error("Legacy compatibility replace found overlapping matches; re-read and use hashline edits.");
		}
	}

	if (matches.length > 1) {
		throw new Error("Legacy compatibility replace found multiple exact matches; re-read and use hashline edits.");
	}

	if (matches.length === 1) {
		const index = matches[0]!;
		return {
			content: content.slice(0, index) + newText + content.slice(index + oldText.length),
			matchCount: 1,
			usedFuzzyMatch: false,
		};
	}

	// Count fuzzy matches without mutating content, then replace only if unique.
	const fuzzyCount = replaceText(content, oldText, oldText, { all: true }).count;
	if (fuzzyCount === 0) {
		throw new Error("Legacy compatibility replace found no exact or fuzzy match in the current file.");
	}

	if (fuzzyCount > 1) {
		throw new Error("Legacy compatibility replace found multiple fuzzy matches; re-read and use hashline edits.");
	}

	const fuzzyReplaced = replaceText(content, oldText, newText, { all: false });
	return {
		content: fuzzyReplaced.content,
		matchCount: 1,
		usedFuzzyMatch: true,
	};
}
