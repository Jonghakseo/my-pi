# pi-vcc-ko

[sting8k/pi-vcc](https://github.com/sting8k/pi-vcc) (MIT)의 포크. 알고리즘형 대화 압축기로, LLM 호출 없이 추출·포맷만으로 브리프 트랜스크립트를 만든다. 한국어 사용자를 위한 추출 정규식 확장이 추가되어 있다.

## 원본과의 차이

### 한국어 추출 확장 (이 포크의 핵심 변경)

| 모듈 | 확장 내용 |
|------|-----------|
| `src/extract/goals.ts` | `SCOPE_CHANGE_RE_KO` (대신/계획 변경/새 작업/이제는…), `TASK_RE_KO` (수정/구현/추가/조사/찾아/확인/검토/정리…, 완료형 제외), `NOISE_SHORT_RE_KO` (응/넵/ㅇㅋ/오케이…), `TEMPLATE_SIGNAL_RE_KO` (각 ~에 대해/출력:…), 한글 포함 목표 라인의 최소 길이 완화 (15자 → 8자), URL/경로 시작 지시문 목표 인정(이스케이프 공백 경로 포함), 붙여넣은 제어문/헤딩/문서 래퍼 줄 제외, 불릿 벗기 후 필터 적용 |
| `src/extract/preferences.ts` | `PREF_PATTERNS_KO`: 선호한다/하지 마/항상 사용/절대 푸시 마/꼭 확인/스타일:/앞으로. 스킬 본문은 접어서 제외 (한국어 패턴은 스킬 매뉴얼 문장과도 일치하므로) |
| `src/core/build-sections.ts` | `BLOCKER_RE_KO` (실패/안 돼/작동 안 하/깨졌/막혔/여전히/불가능…), `SENTENCE_START_RE`가 한글 음절·굵은 시작을 인정, 혼합 문장(숫자/소문자 시작+한글)·상태 태그(`[blocked]`) 수용, 스킬 본문 접기, URL 경로·인용구·백틱 상태값·제품명·실패 0 통계·해소 서사(수정 후 통과) 제외 |
| `src/core/brief.ts` | `SELF_TALK_PREFIX_RE_KO` (음/아/어/잠깐/그런데…), 한국어 기능어 불용어 추가 |
| `src/core/search-entries.ts` | 한국어 쿼리 노이어 워드 (해줘/알려줘/찾아/관련…) 불용어 추가 |

`Intl.Segmenter`의 한국어 사전 세그멘테이션은 원본 워드 카운팅 그대로 동작함을 확인했다 ("윈도우가"가 한 덤어리로 유지), 별도 가중치는 불필요.

### 세션 서두 사용자 메시지 보존 (포크 개선)

원본은 랭킹 컷(selectRankedBriefBlocks)에서 세션 첫 사용자 메시지가 점수로 밀리면 브리프에서 사라졌고, [Session Goal] 추출마저 실패하면 (URL로 시작하는 지시문, 200자 초과 줄 등) 사용자 의도가 요약에서 통초로 유실됐다. 이 포크는 두 겹의 보호 장치를 둔다:

1. `src/extract/goals.ts` — URL/파일 경로로 시작하는 줄도 참조를 걷어낸 본문이 실제 지시(10자 이상)면 목표로 인정한다. "https://github.com/... 를 포팅해서 ..." 같은 세션 서두가 [Session Goal]에 들어간다.
2. `src/core/rank.ts` — 세션 첫 user 블록은 랭킹 점수와 무관하게 브리프에 남긴다 (문자 예산은 차감).

### pi 0.87.x 타입 대응

- `SegmentData.isWordLike` 옵셔널 처리 (`src/core/brief.ts`)
- `bashExecution` 역할은 pi-ai `Message` 유니언에 없어 `src/types.ts`의 `asBashExecution` / `isToolCallPart` 타입 가드로 접근 (`normalize.ts`, `render-entries.ts`, `search-entries.ts`, `drill-down.ts`)
- `SessionEntry` 유니언의 `firstKeptEntryId` 접근에 narrow cast (`src/hooks/before-compact.ts`)

### 식별자 분리 (원본 pi-vcc와 병행 설치 가능)

- 커맨드: `/pi-vcc-ko`, `/pi-vcc-ko-recall`
- 도구: `vcc_recall` (원본과 동일)
- 설정: `~/.pi/agent/pi-vcc-ko-config.json` (`PI_VCC_KO_CONFIG_PATH`로 경로 재정의 가능)
- 디버그 스냅숏: `/tmp/pi-vcc-ko-debug.json`
- compaction `details.compactor`: `"pi-vcc-ko"`

섹션 헤더(`[Session Goal]` 등)와 `vcc_recall` 도구 설명은 에이전트(LLM) 가독성을 위해 영어를 유지한다.

## 디노이즈 규칙 주입

노이즈 필터링 로직은 `src/core/rules.ts`의 규칙 세트로 분리되어 있다. 내장 규칙이 기본값이며, `pi-vcc-ko-config.json`의 `rules`로 사용처에서 규칙을 추가할 수 있다 (내장 규칙에 덧붙여진다). 그룹별 내장 규칙 전체는 `disableBuiltinRules`로 끌 수 있다.

**내 환경의 세션을 분석해 규칙을 작성하는 방법은 [RULES-GUIDE.md](./RULES-GUIDE.md)를 참고**한다. 분석 스크립트(`tools/analyze-sessions.mjs`)가 프로덕션과 동일한 파이프라인으로 세션을 샘플링해 어떤 규칙이 무엇을 잡았는지 보여준다.

```jsonc
{
  "rules": {
    // 사용자 역할 블록 통초 드롭 (하네스 공지/프로토콜 설명)
    "agentNotices": ["\\b테스트 봇 공지\\b"],
    // 목표 후보 라인 제외
    "goalExclusions": ["^무시하고 넘어가:"],
    // 장애물 후보 라인 제외
    "blockerExclusions": ["회사 전용 대시보드 경고"],
    // 작업 동사 추가 (스코프 변경 추적)
    "taskVerbs": ["배포준비"],
    // 선호 패턴 추가
    "preferencePatterns": ["우리 팀은\\s"]
  },
  "disableBuiltinRules": []
}
```

- 값은 정규식 소스 문자열이며 `i` 플래그로 컴파일된다. 무효 패턴은 제외되고 토스트 경고로 알려준다.
- 내장 규칙은 특정 도구명이 아닌 일반 문형으로 정의한다 (자선언 공지, 후속 메시지 구조 설명, 출력 형식 지시, 첨부 가드레일, 대괄호 컨텍스트 태그 우선순위 문장 등).
- 모듈 API도 규칙을 받는다: `filterNoise(blocks, rules)`, `extractGoals(blocks, rules)`, `extractPreferences(blocks, rules)`, `buildSections({ blocks, rules })`, `compile({ messages, rules })`. 생략 시 내장 규칙.

## 사용법

- `/pi-vcc-ko` — 즉시 압축. `keep:N` (마지막 N턴 유지)과 후속 프롬프트를 지원한다.
- `/pi-vcc-ko-recall <쿼리> [scope:all] [page:N]` — 세션 히스토리 검색.
- `vcc_recall` 도구 — 에이전트가 압축으로 사라진 컨텍스트를 복원할 때 호출.
- `overrideDefaultCompaction` 설정(기본 true) 시 `/compact`·자동 임계치 압축도 이 확장이 처리한다.

자세한 동작(스마트 keep, 토큰 캘리브레이션, 세션 전역 `#N` 인덱스 등)은 원본 README(https://github.com/sting8k/pi-vcc) 참고.

## 테스트

```bash
npx vitest run --config tooling/vitest.config.ts pi-vcc-ko
```

- 업스트림 순수 로직 테스트 포팅: `extract-goals`, `extract-preferences`, `build-sections`, `brief`, `format`, `content`, `recall-scope`, `filter-noise`, `rank` (원본 `fixtures.ts` 포함)
- 한국어 회귀 테스트: `tests/korean-extract.test.ts` (목표/스코프 변경/선호/장애물/불용어/문장 시작/URL 시작 지시문/스킬 본문 제외/코드 줄 제외)
- 실제 로컬 세션 50개 정량 검증 (독립 휴리스틱 라벨러로 TP/FN/FP 측정, Wilson 95% CI): 첫 블록 목표 32/32·FP 0, 최종 의도 추적 8/8·FP 0, 선호 2/2, 장애물 24/27·FP 3, 브리프 유의미 턴 120/120·노이즈 FP 0. 여기서 발견해 수정한 것: TASK_RE_KO 동사 누락(찾아/확인/검토/정리), 불릿-필터 순서 버그, 이스케이프 공백 경로 오탐, Picky 부트스트랩/문서 래퍼 유입, 번호 목록 핵심 제약 누락, URL 경로·인용구·백틱 상태값·해소 서사 오탐
