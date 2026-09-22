import { clip, nonEmptyLines } from "../core/content.ts";
import { type DenoiseRules, builtinRules } from "../core/rules.ts";
import { collapseSkillLines } from "../core/skill-collapse.ts";
import type { NormalizedBlock } from "../types.ts";

export const extractPreferences = (blocks: NormalizedBlock[], rules: DenoiseRules = builtinRules()): string[] => {
	const prefs: string[] = [];
	const seen = new Set<string>();

	for (const b of blocks) {
		if (b.kind !== "user") continue;

		let perBlock = 0;
		// 스킬 본문은 사용자 선호가 아니므로 접어서 제외한다 (goals와 동일 취급).
		// 한국어 패턴은 스킬 매뉴얼 문장(“반드시 먼저 실행한다” 등)과도 일치하므로
		// 접지 않으면 스킬 내용 전체가 선호로 새는 문제가 있었다.
		for (const line of collapseSkillLines(nonEmptyLines(b.text))) {
			const trimmed = line.trim();
			if (!trimmed || trimmed.length < 5) continue;
			if (trimmed.length > 200) continue;
			// Reject questions.
			if (trimmed.endsWith("?") || trimmed.includes("?...")) continue;
			if (!rules.preferencePatterns.some((p) => p.test(trimmed))) continue;

			const clipped = clip(trimmed, 200);
			const key = clipped.toLowerCase();
			if (seen.has(key)) continue;
			seen.add(key);
			prefs.push(clipped);

			// Cap per user block to avoid pasting long rule lists as many prefs.
			if (++perBlock >= 1) break;
		}
	}

	return prefs.slice(0, 10);
};

/**
 * Remove preferences that duplicate goals (case-insensitive, trimmed).
 * Called by `buildSections` so that the two sections do not overlap.
 */
export const dedupPreferencesAgainstGoals = (prefs: string[], goals: string[]): string[] => {
	const norm = (s: string) => s.trim().toLowerCase();
	const goalSet = new Set(goals.map(norm));
	return prefs.filter((p) => !goalSet.has(norm(p)));
};
