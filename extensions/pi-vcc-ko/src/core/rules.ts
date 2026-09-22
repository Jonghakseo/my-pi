/**
 * Injected denoising rules.
 *
 * Noise filtering logic (harness notices, target exclusions, obstacle exclusions, work verbs,
 * preference patterns) is separated into rule sets instead of hardcoded regexes in each module.
 * The built-in rule set acts as the default, and users can add rules in the `rules` field of
 * pi-vcc-ko-config.json to inject them from the point of use. Entire built-in groups can also be
 * disabled via `disableBuiltinRules`.
 *
 * Rules are always written as regex source strings and are compiled with the 'i' flag.
 * Invalid patterns are excluded from the rule set and reported through the errors array.
 */

export interface RuleSpec {
	/** User-role blocks to drop entirely (harness notices/protocol descriptions) */
	agentNotices?: string[];
	/** Patterns to exclude from target candidate lines */
	goalExclusions?: string[];
	/** Patterns to exclude from obstacle candidate lines */
	blockerExclusions?: string[];
	/** Additional work verbs (used for follow-up instruction detection in scope change tracking) */
	taskVerbs?: string[];
	/** Preference patterns to add */
	preferencePatterns?: string[];
}

export interface DenoiseRules {
	agentNotices: RegExp[];
	goalExclusions: RegExp[];
	blockerExclusions: RegExp[];
	taskVerbs: RegExp[];
	preferencePatterns: RegExp[];
}

// ── Built-in rule set (default values) ──

/** Block-level drop: harness-injected notices. Itself a general rule — no specific tool names used. */
export const BUILTIN_AGENT_NOTICE_RES: RegExp[] = [
	// 업스트림 고정 노이즈 문자열
	/Continue from where you left off\./i,
	/No response requested\./i,
	/IMPORTANT: TodoWrite was not called yet\./i,
	// 일반 하네스 공지: 자선언, 부트스트랩/자동 생성 표기, 후속 메시지 구조 설명
	/\bnot (?:sent|written) by (?:the )?user\b/i,
	/\bone-time (?:bootstrap |automated )?notice\b/i,
	/\bautomated (?:bootstrap |notice|system message)\b/i,
	/\bSubsequent\b[^\n]{0,100}\bwill (?:only |not )?(?:carry|include|contain|be)\b/i,
	/\bCaveat: The messages below\b/i,
];

/** Target line exclusions. Code/structure/document wrapper/meta instructions. */
export const BUILTIN_GOAL_EXCLUSION_RES: RegExp[] = [
	// Table/box drawing characters, code fences, backslash-n (paste artifacts)
	/^\s*[[│├└─╭╰]/,
	/^```/,
	/\\n/,
	// Code declaration statements
	/^\s*(?:=[A-Z]+\(|function |const |let |var |import |export |class )\b/i,
	// Markdown headings, numbered + bracket/capital headers (document structure)
	/^\s*#{1,6}\s/,
	/^\s*\d+[)]\s+(?:\[|[A-Z])/,
	// Model meta-instructions: output format, attachment guardrails, agent self-description
	/^\s*(?:Return|Respond|Reply)\b[^\n]{0,80}\b(?:final |clear )?(?:answer|response|output|result|summary)\b/i,
	/^\s*(?:If|When)\b[^\n]{0,100}\b(?:is|are) (?:provided|attached|available)\b/i,
	/^\s*(?:You|You're|Your) (?:are|role|task|job|must|should|will)\b/i,
	// 우선순위 규칙 문장: 대괄호 컨텍스트 태그([REQUEST] 등) 2개 이상 + 우선순위 동사.
	// 도구별 문구가 아닌 “If [TAG]… conflicts …, follow [TAG]” 형태 자체를 건다.
	/^\s*If\b[^\n]{0,120}\[[A-Z][^\]\n]{1,38}\][^\n]{0,120}\[[A-Z][^\]\n]{1,38}\][^\n]{0,120}\b(?:follow|ignore|prefer|override|wins?|take precedence)\b/i,
	// Command template signals (upstream)
	/^\s*For each\b/i,
	/\bin full\b[^\n]*\b(?:comments|issue|issues|PRs?|linked)\b/i,
];

/** Obstacle line exclusions. Excluding pasted data/statements/resolved reports. */
export const BUILTIN_BLOCKER_EXCLUSION_RES: RegExp[] = [
	// Status values inside backticks (`BLOCKED(level=-1)`)
	/`[^`]*\b(?:blocked|failed|error)\b[^`]*`/i,
	// Product names (Ad Blocker(…))
	/\b(?:block(?:ed|er|s)?|fail(?:ed|ure|s)?)\s*\(/i,
	// Mentions inside quotes ("the pilot failed")
	/["“”'][^"“”']{0,80}?\b(?:fail(?:ed|s|ure|ing)?|broken|cannot|blocked)\b[^"“”']{0,80}?["“”']/i,
	// Statistics notation “실패 0/실패 없” (success report)
	/실패\s*(?:0|없)/,
	// Resolved narrative (수정 전 실패 → 수정 후 통과)
	/(?:수정 후|재현 후|이후|다시|재시도|재실행)[^\n]{0,60}(?:통과|그린|해결|완료|pass(?:ed|ing)?|clean)/i,
	// Document rationale fragments ("Why it matters:"/"Rationale:")
	/^(?:Why\b(?: it| this)? matters?|Rationale|Reason(?:ing)?)\s*[:：]/i,
];

/** Built-in English/Korean work verbs (superset of SCOPE_CHANGE/TASK detection). */
export const BUILTIN_TASK_VERB_RES: RegExp[] = [
	/\b(?:fix|implement|add|create|build|refactor|debug|investigate|update|remove|delete|migrate|deploy|test|write|set up)\b/i,
	/(수정|고치|고쳐|구현|추가|생성|만들|개발|구축|리팩토링|리팩터링|디버깅|디버그|조사|분석|업데이트|갱신|제거|삭제|마이그레이션|배포|테스트|작성|설정|(?:찾아|확인|검토|정리|적용|세팅)(?!했)|해줘|해 줘|해주세|해 주세|주세요|달라|드려)/,
];

/** Built-in preference patterns (English/Korean). */
export const BUILTIN_PREFERENCE_RES: RegExp[] = [
	/\bprefer(?:s|red|ring)?\s+\w/i,
	/\bdon'?t want\b/i,
	/\balways (?:use|do|run|prefer|keep|make|format|write|add|set|put|prefix|start|include|append)\b/i,
	/\bnever (?:use|do|run|push|commit|write|ignore|add|set|put|remove|delete|include|deploy)\b/i,
	/\bplease (?:use|avoid|keep|make|don'?t|do not|format|write)\b/i,
	/\b(?:style|format|language|naming)\s*[:=]\s*\S/i,
	/선호(?:한다|해|해요|합니다|함|하는|하는데)/,
	/(?:하지|쓰지|사용하지|넣지|포함하지|건드리지)\s?마(?:라|세요|셈|요)?/,
	/항상\s(?:사용|실행|확인|추가|포함|적용|작성|커밋|테스트|포맷|유지|보존)/,
	/절대\s(?:사용|푸시|푸쉬|커밋|작성|무시|추가|삭제|배포|수정)(?:하지)?\s?마/,
	/(?:꼭|반드시|되도록(?:이면)?|가급적)\s(?:사용|실행|확인|추가|포함|적용|작성|지켜|피해|먼저)/,
	/(?:스타일|형식|포맷|언어|네이밍|명명)\s*[:：=]\s*\S/,
	/앞으로(?:는)?\s/,
];

export const RULE_GROUPS = [
	"agentNotices",
	"goalExclusions",
	"blockerExclusions",
	"taskVerbs",
	"preferencePatterns",
] as const;

export type RuleGroup = (typeof RULE_GROUPS)[number];

const BUILTIN_BY_GROUP: Record<RuleGroup, RegExp[]> = {
	agentNotices: BUILTIN_AGENT_NOTICE_RES,
	goalExclusions: BUILTIN_GOAL_EXCLUSION_RES,
	blockerExclusions: BUILTIN_BLOCKER_EXCLUSION_RES,
	taskVerbs: BUILTIN_TASK_VERB_RES,
	preferencePatterns: BUILTIN_PREFERENCE_RES,
};

export const compilePattern = (source: string, flags = "i"): RegExp | undefined => {
	try {
		return new RegExp(source, flags);
	} catch {
		return undefined;
	}
};

/**
 * Merge built-in rules and custom rules into a compiled rule set.
 * - Custom rules are appended after built-in rules (exclusion rules follow fail-first semantics, order doesn't matter).
 * - Groups in disableBuiltinRules start with only custom rules.
 * - Invalid patterns are excluded from the set and reported in errors.
 */
export const compileRules = (
	spec: RuleSpec = {},
	disableBuiltin: string[] = [],
): { rules: DenoiseRules; errors: string[] } => {
	const errors: string[] = [];
	const compileGroup = (group: RuleGroup, custom: string[] | undefined): RegExp[] => {
		const out: RegExp[] = disableBuiltin.includes(group) ? [] : [...BUILTIN_BY_GROUP[group]];
		for (const source of custom ?? []) {
			const re = compilePattern(source);
			if (re) out.push(re);
			else errors.push(`${group}: 정규식 컴파일 실패 — ${source}`);
		}
		return out;
	};
	return {
		rules: {
			agentNotices: compileGroup("agentNotices", spec.agentNotices),
			goalExclusions: compileGroup("goalExclusions", spec.goalExclusions),
			blockerExclusions: compileGroup("blockerExclusions", spec.blockerExclusions),
			taskVerbs: compileGroup("taskVerbs", spec.taskVerbs),
			preferencePatterns: compileGroup("preferencePatterns", spec.preferencePatterns),
		},
		errors,
	};
};

/** Built-in-only rule set. Module default values. */
export const builtinRules = (): DenoiseRules => compileRules().rules;
