import { clip, nonEmptyLines } from "../core/content.ts";
import { type DenoiseRules, builtinRules } from "../core/rules.ts";
import { collapseSkillLines } from "../core/skill-collapse.ts";
import type { NormalizedBlock } from "../types.ts";

const SCOPE_CHANGE_RE =
	/\b(instead|actually|change of plan|forget that|new task|switch to|now I want|pivot|let'?s do|stop .* and)\b/i;

// 한국어 스크프 변경 신호. \b가 한글에서 동작하지 않아 부분 일치를 허용한다.
// 오탐은 사용자 발화을 [Scope change]에 추가할 뿐이라 피해가 작다.
const SCOPE_CHANGE_RE_KO =
	/(대신|아니[,.! ]|계획(?:이)? ?바뀌|계획 변경|방향 ?전환|방향을 바꿔|그만(?:두고|하고)|무시(?:하고|해도)|잊고|새(?:로운)? ?(?:작업|태스크|요구사항)|바꿔서|옮겨서|전환해서|다시 ?생각해보니|생각해보니|이제(?:는|부터는))/;

const NOISE_SHORT_RE = /^(ok|yes|no|sure|yeah|yep|go|hi|hey|thx|thanks|ok\b.*|y|n|k)\s*[.!?]*$/i;

// 한국어 단답/인사 노이즈 (ㅇㅇ, 넵, 응, 오케이 등).
const NOISE_SHORT_RE_KO =
	/^(ㅇㅇ|ㅇㅋ|ㅋㅋ|ㄱㄱ|넵|네네|네|응|어|오케이|오케|좋아|좋은데|그래|그래요|고마워|감사(?:합니다|해요|해)|안녕|하이|ㅎㅇ)\s*[.~!?]*$/;

// Signals that the rest of the user message is a command template (e.g. /issues),
// in which case we should stop collecting goals at the signal line.
const TEMPLATE_SIGNAL_RE = /^\s*(For each\b|Do NOT implement\b|Analyze and propose\b|If Task\/context\b|Output:\s*$)/i;

// 한국어 커맨드 템플릿 신호 ("각 이슈에 대해...", "구현하지 말고 분석만...", "출력:" 등).
const TEMPLATE_SIGNAL_RE_KO = /^\s*(각\s+\S+\s+에?대해|구현하지\s*마|분석.{0,20}제안|출력\s*[:：]\s*$)/;

const truncateAtTemplate = (lines: string[]): string[] => {
	const idx = lines.findIndex((l) => TEMPLATE_SIGNAL_RE.test(l) || TEMPLATE_SIGNAL_RE_KO.test(l));
	return idx >= 0 ? lines.slice(0, idx) : lines;
};

const stripLeadingBullet = (line: string): string => line.replace(/^\s*(?:[-*+]|\d+\.)\s+/, "").trim();

const MAX_GOAL_CHARS = 200;

// URL/파일 경로 토큰. 이스케이프 공백(스크린샷\ 2026…)도 경로의 일부로 벗긴다.
const REF_TOKEN_RE = /^(?:https?:\/\/|file:|\/)(?:[^\s\\]|\\ )+/u;

const hasHangul = (text: string): boolean => /[\uAC00-\uD7A3]/.test(text);

/**
 * 목표 후보 판정. 구조적 검사(길이, 단답, 제어문 코드)는 내장, 제외 패턴은
 * rules.goalExclusions로 주입된다. URL/경로로 시작하는 줄은 참조를 벗긴 본문이
 * 실제 지시(10자 이상)면 목표로 인정한다 — 원본은 이런 줄을 통초로 버려서
 * [Session Goal]이 아예 비는 원인이었다.
 */
const isSubstantiveGoal = (text: string, rules: DenoiseRules): boolean => {
	const t = text.trim();
	if (t.length <= 5) return false;
	if (t.length > MAX_GOAL_CHARS) return false;
	if (NOISE_SHORT_RE.test(t) || NOISE_SHORT_RE_KO.test(t)) return false;
	// 붙여넣은 제어문 코드 줄 걸러내기. 선언문과 달리 제어문(if/for/return)은 원본이
	// 놓쳤다. 한글이 없고 코드 구두점(;,{,=>)이 있는 줄만 거른다 — "return 값이
	// 비어서 나와요" 같은 한국어 지시는 보호된다.
	if (/^\s*(?:if|for|while|switch|return)\b/i.test(t) && !hasHangul(t) && /(?:[;{}]$|=>|\)\s*\{)/.test(t)) return false;
	const excluded = (s: string): boolean => rules.goalExclusions.some((re) => re.test(s));
	if (excluded(t) || REF_TOKEN_RE.test(t)) {
		// URL/경로 시작 줄: 참조만 걷어낸 본문이 지시문이면 받는다. 경로 단독(파일 드롭 등)은
		// 본문이 없으므로 제외된다.
		const stripped = t.replace(REF_TOKEN_RE, "").trim();
		if (stripped.length < 10 || excluded(stripped)) return false;
	}
	return true;
};

// Test scope-change / task intent only on the leading portion of a user block
// so that pasted outputs below the actual instruction do not trigger matches.
const LEADING_CHARS = 200;

export const extractGoals = (blocks: NormalizedBlock[], rules: DenoiseRules = builtinRules()): string[] => {
	const goals: string[] = [];
	let latestScopeChange: string[] | null = null;

	for (const b of blocks) {
		if (b.kind !== "user") continue;
		const rawLines = nonEmptyLines(b.text);
		const truncated = truncateAtTemplate(rawLines);
		// 불릿을 먼저 벗겨야 “- /var/...” 같은 경로/코드 줄이 필터를 통과하는 문제를 막는다.
		// 실제 50세션 샘플링에서 발견: 필터가 불릿 앞에서 돌면 제외 대상이 역으로 통과됐다.
		const lines = collapseSkillLines(truncated)
			.map(stripLeadingBullet)
			.filter((l) => isSubstantiveGoal(l, rules))
			.filter((l) => l.length > 5);
		if (lines.length === 0) continue;

		if (goals.length === 0) {
			goals.push(...lines.slice(0, 6));
			continue;
		}

		const leading = b.text.slice(0, LEADING_CHARS);
		// 한국어는 글자당 정보량이 영어보다 높아 동일 임계치면 짧은 실제 작업 지시가 걸러진다
		// (15자 영어 ≈ 8자 한국어). 후속 작업 인지 판단에만 적용한다.
		if (SCOPE_CHANGE_RE.test(leading) || SCOPE_CHANGE_RE_KO.test(leading)) {
			latestScopeChange = lines.slice(0, 3).map((l) => clip(l, MAX_GOAL_CHARS));
		} else if (rules.taskVerbs.some((re) => re.test(leading)) && lines[0].length > (hasHangul(lines[0]) ? 8 : 15)) {
			latestScopeChange = lines.slice(0, 2).map((l) => clip(l, MAX_GOAL_CHARS));
		}
	}

	// Only emit the [Scope change] marker when we actually captured bullets.
	if (latestScopeChange && latestScopeChange.length > 0) {
		goals.push("[Scope change]", ...latestScopeChange);
	}

	return goals;
};
