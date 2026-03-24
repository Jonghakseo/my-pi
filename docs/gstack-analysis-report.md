# gstack 심층 분석 보고서: pi-agent 적용/보완 계획

> **작성일**: 2026-03-22  
> **분석 대상**: [garrytan/gstack](https://github.com/garrytan/gstack) v0.9.9.0  
> **적용 대상**: pi-agent (my-pi) — 멀티 에이전트 오케스트레이션 플랫폼  
> **목적**: gstack에서 배울 수 있는 패턴/워크플로우를 식별하고, pi-agent에 현실적으로 적용 가능한 계획을 수립

---

## 목차

1. [Executive Summary](#1-executive-summary)
2. [gstack 아키텍처 분석](#2-gstack-아키텍처-분석)
3. [기능별 상세 비교 매트릭스](#3-기능별-상세-비교-매트릭스)
4. [핵심 인사이트: gstack이 증명한 것](#4-핵심-인사이트-gstack이-증명한-것)
5. [적용/보완 항목 상세 (우선순위별)](#5-적용보완-항목-상세-우선순위별)
6. [구현 로드맵](#6-구현-로드맵)
7. [리스크 분석 및 대응](#7-리스크-분석-및-대응)
8. [결론](#8-결론)

---

## 1. Executive Summary

### gstack이란?

Y Combinator CEO Garry Tan이 만든 오픈소스 "소프트웨어 팩토리". Claude Code를 CEO 리뷰어, 엔지니어링 매니저, QA 리드, 릴리즈 엔지니어 등 **18개 전문가 역할**로 확장하는 25개의 SKILL.md 파일과, Playwright 기반 **영속 브라우저 데몬**으로 구성된다.

### 핵심 발견

| 차원            | gstack 강점                         | pi-agent 강점                                       |
| ------------- | --------------------------------- | ------------------------------------------------- |
| **워크플로우 자동화** | ship→deploy→monitor 파이프라인         | design→implement→verify 파이프라인                     |
| **실행 기반**     | 영속 브라우저 데몬 (~100ms/명령)            | 멀티 모델 에이전트 오케스트레이션                                |
| **도구 통합**     | CLI 바이너리 (Bun 컴파일)                | MCP 브릿지 (30+ 도구)                                  |
| **안전 장치**     | Hook 기반 강제 (careful/freeze/guard) | 확장 기반 보호 (damage-control, dynamic-agents)         |
| **코드 품질**     | Fix-First 리뷰, 구조화된 체크리스트          | stress-interview, self-healing, verification-gate |

### 결론

gstack과 pi-agent는 **상호 보완적**이다. gstack은 "제품 발견→출시→운영" 파이프라인에서 강하고, pi-agent는 "설계→구현→검증" 파이프라인에서 강하다. **가장 큰 빈 자리는 출시/운영 워크플로우**이며, 이를 pi-agent의 기존 인프라(에이전트 오케스트레이션, MCP, 확장 시스템) 위에 구축하면 상당한 시너지가 가능하다.

---

## 2. gstack 아키텍처 분석

### 2.1 전체 구조

```
사용자 → Claude Code → SKILL.md 발견 → 스킬 실행
                                      │
                    ┌─────────────────┤
                    │                 │
              워크플로우 스킬      브라우저 CLI
              (Markdown 기반)     (Bun 컴파일 바이너리)
                    │                 │
                    │           ┌─────┴─────┐
                    │           │ CLI       │
                    │           │ → HTTP    │
                    │           │ → Server  │
                    │           │ → CDP     │
                    │           │ → Chromium│
                    │           └───────────┘
                    │
              ┌─────┴──────────────┐
              │ /office-hours      │ 제품 발견
              │ /plan-*-review     │ 리뷰 게이트
              │ /review            │ PR 리뷰
              │ /ship              │ 출시
              │ /land-and-deploy   │ 배포
              │ /canary            │ 모니터링
              │ /retro             │ 회고
              └────────────────────┘
```

### 2.2 핵심 설계 결정

| 결정                        | 이유                         | pi-agent과의 차이                |
| ------------------------- | -------------------------- | ---------------------------- |
| **HTTP 기반 브라우저** (MCP 아님) | 토큰 절약, curl 디버깅 용이         | pi는 MCP 기반 통합 선호             |
| **Bun 컴파일 바이너리**          | 런타임 의존성 제거                 | pi는 Node.js + TypeScript     |
| **SKILL.md 템플릿 시스템**      | 코드↔문서 동기화                  | pi는 수동 관리 (스킬 수가 적음)         |
| **단일 모델 (Claude)**        | Claude Code 네이티브           | pi는 멀티 모델 (Claude + GPT-5.4) |
| **Hook 기반 안전장치**          | 세션 범위 강제                   | pi는 확장 기반 보호                 |
| **없는 것: 에이전트 오케스트레이션**    | Claude Code의 Agent tool 의존 | pi는 subagent 시스템이 핵심         |

### 2.3 ETHOS — 빌더 철학

gstack의 두 가지 핵심 원칙:

**1. Boil the Lake (호수를 끓여라)**

> AI 시대에 완전한 구현의 한계 비용은 거의 0이다. 90% 해결로 끝내지 말고, 항상 100%를 추구하라.

- "호수" = 보일 수 있는 것 (100% 테스트 커버리지, 전체 기능 구현)
- "바다" = 보일 수 없는 것 (전체 시스템 재작성, 다분기 마이그레이션)
- 호수는 끓이고, 바다는 범위 밖으로 표시

**2. Search Before Building (빌드 전에 검색하라)**

- Layer 1: 검증된 패턴 (in-distribution)
- Layer 2: 새로운 트렌드 (검색 결과 — 비판적으로 평가)
- Layer 3: 1원칙 추론 (가장 가치 있음)
- "유레카 모먼트": Layer 3이 Layer 1/2의 가정이 틀렸음을 발견한 순간

---

## 3. 기능별 상세 비교 매트릭스

### 3.1 제품 라이프사이클 커버리지

```
                gstack                         pi-agent
                ──────                         ────────
발견     ██████████ /office-hours              ░░░░░░░░░░ (없음)
기획     ██████████ /plan-*-review             ████████░░ design-first
설계     ██████████ /design-consultation       ██░░░░░░░░ (코드 아키텍처만)
구현     ████░░░░░░ (Claude Code 의존)         ██████████ pipeline-execute + 에이전트
리뷰     ██████████ /review (체크리스트)        ████████░░ reviewer + stress-interview
테스트   ██████████ /qa (브라우저 QA)           ██████░░░░ browser 에이전트 (수동)
출시     ██████████ /ship                      ░░░░░░░░░░ (없음)
배포     ██████████ /land-and-deploy           ░░░░░░░░░░ (없음)
모니터   ██████████ /canary + /benchmark       ░░░░░░░░░░ (없음)
회고     ██████████ /retro                     ████░░░░░░ daily-analysis (기초)
안전     ████████░░ careful/freeze/guard       ██████░░░░ damage-control + dynamic-agents
도구     ████░░░░░░ browse CLI                 ██████████ MCP + 25+ 확장
```

### 3.2 상세 비교 (기능별)

#### A. 코드 리뷰

| 항목             | gstack `/review`             | pi-agent `reviewer` |
| -------------- | ---------------------------- | ------------------- |
| 구조화된 체크리스트     | ✅ 8개 카테고리 (SQL, Race, LLM 등) | ❌ 일반적 리뷰 프롬프트       |
| 2-pass 리뷰      | ✅ Critical → Informational   | ❌ 단일 패스             |
| Fix-First 접근   | ✅ AUTO-FIX + ASK 분류          | ❌ 문제 보고만            |
| Scope Drift 감지 | ✅ 의도 vs 실제 diff 비교           | ❌ 없음                |
| 외부 서비스 연동      | ✅ Greptile 분류/이력             | ❌ 없음                |
| TODOS 교차 참조    | ✅ 완료 항목 자동 감지                | ❌ 없음                |
| 문서 신선도 체크      | ✅ diff vs .md 파일 비교          | ❌ 없음                |

#### B. 출시 파이프라인

| 항목              | gstack `/ship`            | pi-agent |
| --------------- | ------------------------- | -------- |
| 자동 테스트 실행       | ✅ 프레임워크 감지                | ❌ 수동     |
| 테스트 커버리지 감사     | ✅ ASCII 다이어그램 + 자동 생성     | ❌ 없음     |
| Pre-landing 리뷰  | ✅ 체크리스트 기반                | ❌ 없음     |
| 버전 관리           | ✅ 4-digit 자동 범프           | ❌ 없음     |
| CHANGELOG 자동 생성 | ✅ diff 기반                 | ❌ 없음     |
| Bisectable 커밋   | ✅ 논리적 분할                  | ❌ 없음     |
| PR 자동 생성        | ✅ gh CLI                  | ❌ 수동     |
| 문서 자동 동기화       | ✅ /document-release 자동 호출 | ❌ 없음     |

#### C. 안전 장치

| 항목             | gstack                     | pi-agent                              | 강제력          |
| -------------- | -------------------------- | ------------------------------------- | ------------ |
| rm -rf 보호      | `/careful` (hook → ask)    | `damage-control-rmrf.ts` (확장 → block) | 양쪽 강제        |
| 편집 범위 잠금       | `/freeze` (hook → deny)    | `dynamic-agents-md.ts` (에이전트별)        | gstack이 더 세밀 |
| 디버깅 scope lock | `/investigate` (자동 freeze) | `systematic-debugging` (없음)           | gstack이 우위   |
| 파괴적 SQL 보호     | `/careful` (패턴 매치)         | 없음                                    | gstack이 우위   |

---

## 4. 핵심 인사이트: gstack이 증명한 것

### 인사이트 1: "워크플로우 > 도구"

gstack의 가장 큰 가치는 개별 도구가 아니라 **워크플로우 자동화**다. `/ship`은 단순한 `git push`가 아니라 8단계 프로세스(테스트→리뷰→버전→CHANGELOG→커밋분할→PR→문서동기화)를 자동화한다. 이 워크플로우 하나가 매 배포마다 30-60분을 절약한다.

**pi-agent에 부재**: 우리는 개별 에이전트(reviewer, verifier)는 강하지만, 이들을 엮는 **운영 워크플로우**가 없다.

### 인사이트 2: "Fix-First — 발견만 하지 않고 즉시 수정"

gstack의 `/review`는 문제를 발견하면 바로 두 가지로 분류한다:

- **AUTO-FIX**: 기계적으로 수정 가능 → 즉시 수정
- **ASK**: 판단이 필요 → 사용자에게 질문

이 접근은 리뷰가 "읽기 전용 보고서"로 끝나는 것을 방지한다.

**pi-agent 적용**: reviewer 에이전트에 Fix-First 분류를 추가하고, stress-interview 결과에도 같은 패턴 적용.

### 인사이트 3: "물리적 범위 제어"

gstack의 `/freeze`는 특정 디렉토리 외부의 편집을 **물리적으로 차단**한다. 이는 "조심하세요"라는 권고보다 훨씬 효과적이다. 특히 디버깅 중 "여기 있는 김에" 리팩터링을 방지한다.

**pi-agent 적용**: dynamic-agents-md.ts 패턴을 활용한 범용 freeze 메커니즘. 단, SKILL.md만으로는 불충분하고 extension 수준의 강제가 필요하다는 점 주의.

### 인사이트 4: "자가 개선 메커니즘"

gstack의 기여자 모드는 도구가 스스로를 개선하는 메커니즘을 내장한다. 워크플로우 종료 시 경험을 0-10으로 평가하고, 10이 아니면 필드 리포트를 자동 작성한다.

**pi-agent 적용**: memory-layer에 "experience-report" 카테고리 추가 가능.

### 인사이트 5: "완전성의 경제학"

AI 시대에 "90% 구현"과 "100% 구현"의 비용 차이는 무시할 수 있다. gstack의 "Boil the Lake" 원칙은 이를 체계화한다.

**주의**: challenger가 지적한 대로, 이 원칙이 기존의 "범위 통제" 철학과 충돌할 수 있다. YAGNI와 Boil the Lake 사이의 균형이 필요하다.

---

## 5. 적용/보완 항목 상세 (우선순위별)

> ⚠️ **Challenger 피드백 반영**: 초기 분석에서 "쉬운 것 먼저"로 기울어진 우선순위를, "가장 큰 빈 자리를 채우는 것 먼저"로 재조정했다. 또한 구현 난이도를 상향 조정한 항목이 있다.

### Phase 0: 실행 기반 확인 (Day 1-2)

Phase 0는 구현에 앞서 기반이 준비되었는지 확인하는 사전 작업이다.

#### 0-1. Hook/Guard 강제 지점 확인

**목적**: `/freeze` 같은 안전장치를 "권고"가 아닌 "강제"로 구현할 수 있는 지점 파악

**확인 사항**:

- `dynamic-agents-md.ts`의 편집 제한 메커니즘이 범용화 가능한가?
- subagent에 편집 범위 제한을 전파할 수 있는가?
- 메인 에이전트 + subagent 모두에 적용되는 강제 메커니즘이 있는가?

**예상 결과**: 확장(extension) 수준에서 구현해야 할 기능 vs SKILL.md로 충분한 기능 구분

#### 0-2. 레포 변형 흡수 능력 확인

**목적**: `/ship`이 다양한 프로젝트에서 작동하려면 테스트 명령, 버전 전략, CI/CD 구성을 감지해야 함

**확인 사항**:

- 주로 사용하는 프로젝트들의 테스트 명령어, 버전 관리 방식, CI/CD 설정
- `package.json`, `Makefile`, `docker-compose.yml` 등에서 정보 추출 가능 여부
- gh CLI 설치/인증 상태

**예상 결과**: `/ship` 스킬이 지원해야 할 프로젝트 유형 목록

---

### Phase 1: 핵심 운영 워크플로우 (Week 1-2)

> **원칙**: "가장 큰 빈 자리를 채우는 것 먼저." 리뷰 체크리스트 같은 점진적 개선보다, 매일 수동으로 하는 출시 작업 자동화가 더 큰 임팩트.

#### 1-1. `/ship` 워크플로우 스킬 ⭐ TOP PRIORITY

**현실성**: ★★★★☆ | **난이도**: L (large) | **기대효과**: ★★★★★

**왜 최우선인가**: 매 배포마다 수동으로 수행하는 작업(테스트→리뷰→커밋→PR)이 가장 큰 반복 비용. gstack 비교에서 가장 큰 격차.

**구현 범위** (challenger 피드백 반영 — 난이도 상향):

```
skills/ship/SKILL.md

Step 1: Pre-flight
  - 현재 브랜치 확인 (main/master이면 abort)
  - 변경사항 확인 (git diff --stat)

Step 2: 테스트 실행
  - 프로젝트별 테스트 명령 감지:
    • package.json scripts.test → npm test / pnpm test / bun test
    • Makefile test target → make test
    • 감지 실패 시 → AskUserQuestion
  - 테스트 실패 시 → STOP

Step 3: stress-interview 호출 (기존 스킬 재활용!)
  - 기존 verifier + reviewer + challenger 병렬 검증
  - Fix-First 분류: AUTO-FIX 즉시 적용, ASK는 사용자 판단
  - 수정 발생 시 → 테스트 재실행

Step 4: 커밋 정리
  - 논리적 단위로 분할 (bisectable)
  - 각 커밋이 독립적으로 유효해야 함
  - 커밋 메시지: conventional commits 형식

Step 5: PR 생성
  - gh pr create --base <base> --title "<type>: <summary>"
  - PR body: 변경 요약, 테스트 결과, 리뷰 결과
  - gh CLI 미설치 시 → 설치 안내 후 STOP
```

**주요 구현 과제**:

1. **테스트 명령 감지**: 프로젝트마다 다름 → 패턴 매칭 + 캐싱 필요
2. **stress-interview 연동**: 기존 스킬 호출 메커니즘 확인
3. **커밋 분할 로직**: 파일 의존성 분석 필요
4. **gh CLI 의존성**: 설치/인증 확인

**MVP 접근** (전체 구현 전 검증):

- 먼저 **테스트→PR 생성**만 구현 (Step 1, 2, 5)
- stress-interview 연동은 두 번째 이터레이션
- 커밋 분할은 세 번째 이터레이션

**구현 파일**:

```
skills/ship/SKILL.md         — 메인 워크플로우 정의
```

#### 1-2. 리뷰 체크리스트 + Fix-First 시스템

**현실성**: ★★★★★ | **난이도**: S (small) | **기대효과**: ★★★★☆

**왜 중요한가**: 현재 reviewer 에이전트는 일반적 프롬프트로 동작. 구조화된 체크리스트가 있으면 리뷰 일관성과 커버리지가 극적으로 향상됨.

**구현 상세**:

```
agents/reviewer.md 수정 — 체크리스트 섹션 추가:

## 리뷰 체크리스트 (2-Pass)

### Pass 1: Critical (반드시 확인)
- [ ] SQL 주입 위험: 사용자 입력이 쿼리에 직접 삽입되는가?
- [ ] 인증/인가 누락: 보호되어야 할 엔드포인트가 노출되는가?
- [ ] 레이스 컨디션: 동시 접근 시 데이터 무결성이 보장되는가?
- [ ] LLM 출력 신뢰 경계: AI 생성 출력이 검증 없이 사용되는가?
- [ ] 비밀값 노출: API 키, 토큰 등이 코드에 하드코딩되는가?

### Pass 2: Informational (품질 향상)
- [ ] Dead code: 사용되지 않는 함수/변수가 추가되는가?
- [ ] Magic numbers: 설명 없는 숫자/문자열이 있는가?
- [ ] 테스트 갭: 새 코드 경로에 테스트가 있는가?
- [ ] 성능: N+1 쿼리, 불필요한 렌더링이 있는가?
- [ ] 접근성: aria 속성, 키보드 내비게이션이 고려되었는가?

## Fix-First 분류
- AUTO-FIX: dead code 제거, 명확한 버그 수정, 타입 오류
- ASK: 아키텍처 변경, 비즈니스 로직 수정, 보안 관련

## 보고 형식
"Pre-Landing Review: N issues (X critical, Y informational)"
```

#### 1-3. Scope Drift Detection

**현실성**: ★★★★★ | **난이도**: S (small) | **기대효과**: ★★★☆☆

**구현 상세**:

```
stress-interview SKILL.md에 추가:

## Scope Check (stress-interview 시작 시)
1. git log 커밋 메시지에서 "의도" 추출
2. git diff --stat에서 "실제 변경" 추출
3. 비교:
   - 의도에 없는 파일 변경 → SCOPE CREEP 경고
   - 의도에 있지만 변경 없는 항목 → MISSING 경고
4. 결과를 stress-interview 보고서에 포함
```

---

### Phase 2: 안전 장치 강화 (Week 2-3)

#### 2-1. Freeze (편집 범위 잠금)

**현실성**: ★★★★☆ | **난이도**: M (medium) | **기대효과**: ★★★★☆

> ⚠️ **Challenger 주의**: SKILL.md만으로는 강제 불가. extension 수준 구현 필요.

**구현 접근법 (2단계)**:

**단계 1: SKILL.md 기반 (soft enforcement)**

```
skills/freeze/SKILL.md

1. 사용자에게 잠금 디렉토리 질문
2. 상태 파일에 저장: ~/.pi/state/freeze-dir.txt
3. 이후 모든 편집 요청 시 경고 (강제는 아님)
```

**단계 2: Extension 기반 (hard enforcement)**

```
extensions/freeze-guard.ts

- Edit/Write 도구 호출 전 인터셉트
- freeze-dir.txt와 대상 파일 경로 비교
- 범위 밖이면 차단 + 사용자 알림
- subagent에도 전파: 에이전트 프롬프트에 제한 조건 주입
```

**단계 1을 먼저 구현하고, 실사용에서 우회가 문제되면 단계 2로 발전.**

#### 2-2. systematic-debugging + Scope Lock 통합

**현실성**: ★★★★★ | **난이도**: S (small) | **기대효과**: ★★★☆☆

```
skills/systematic-debugging/SKILL.md 수정:

## Phase 1 이후: Scope Lock
1. 근본원인이 특정 디렉토리에 있다고 판단되면
2. 해당 디렉토리를 freeze 대상으로 자동 설정
3. "디버깅 중 [dir/]만 편집 가능합니다" 알림
4. Phase 4 (구현) 완료 후 자동 해제
```

---

### Phase 3: 운영 관찰 및 개선 (Week 3-4)

#### 3-1. Document Release 스킬

**현실성**: ★★★☆☆ | **난이도**: L (large) | **기대효과**: ★★★★☆

> ⚠️ **Challenger 주의**: "코드 변경 → 문서 영향 판단"은 semantic mapping이 필요. 전체 자동화보다 **특정 문서 타입 1-2개 대상 파일럿**이 현실적.

**MVP 접근**:

```
skills/document-release/SKILL.md

## MVP 범위 (README.md + CHANGELOG.md만)
1. git diff로 변경된 기능 식별
2. README.md 읽기 → 변경된 기능이 설명된 부분 찾기
3. 불일치 발견 시:
   a. 자동 수정 시도 (간단한 경우)
   b. 수정 제안 + 사용자 확인 (복잡한 경우)
4. CHANGELOG.md는 커밋 히스토리에서 자동 생성

## 향후 확장
- ARCHITECTURE.md, CONTRIBUTING.md 등 추가
- 코드 주석 ↔ 문서 교차 검증
```

#### 3-2. Retro (회고) 스킬

**현실성**: ★★★★★ | **난이도**: M (medium) | **기대효과**: ★★★☆☆

```
skills/retro/SKILL.md

## 메트릭 수집
1. git log 분석 (커밋 수, LOC, 타입 분포)
2. 세션 감지 (45분 갭 기준)
3. 포커스 점수 (가장 많이 변경된 디렉토리 비율)
4. 스트릭 추적 (연속 커밋 일수)

## 보고서 형식
- Tweetable summary (1줄)
- 메트릭 테이블
- 시간 패턴 분석
- Ship of the Week
- 3가지 개선 제안
- JSON 스냅샷 저장 (.context/retros/)
```

#### 3-3. ETHOS 문서화 — 완전성 + 검색 원칙

**현실성**: ★★★★★ | **난이도**: S (small) | **기대효과**: ★★★☆☆

```
docs/ETHOS.md 생성

## Boil the Lake (완전성 원칙)
- 적용: 테스트 커버리지, 에러 처리, 문서화, 엣지 케이스
- 균형: YAGNI와 충돌 시 → "지금 필요한 것의 100%"를 추구
  (불필요한 기능을 100% 구현하라는 것이 아님)
- 노력 추정 시 항상 "인간 팀" vs "AI 지원" 양 축 표시

## Search Before Building (검색 원칙)
- Layer 1/2/3 프레임워크
- 유레카 모먼트 인식 및 기록

## 범위 통제와의 균형
- "범위 밖 파일 revert 금지" 규칙은 유지
- "호수"(보일 수 있는 범위) 내에서만 완전성 추구
- 새 기능 추가가 아닌, 현재 작업의 완전한 마무리에 집중
```

#### 3-4. 프로액티브 스킬 라우팅

**현실성**: ★★★★★ | **난이도**: S (small) | **기대효과**: ★★☆☆☆

```
시스템 프롬프트 / skill-router 수정:

## 상황별 자동 제안 규칙
- 사용자가 에러를 보고 → "systematic-debugging 스킬을 써볼까요?"
- PR/커밋 전 → "stress-interview로 점검할까요?"
- 새 기능 시작 → "design-first로 설계부터 할까요?"
- 디버깅 3회 실패 → systematic-debugging의 아키텍처 재검토 제안

## 끄기 가능
- 사용자가 거부하면 세션 동안 제안 중단
- memory에 "proactive_suggestions: false" 저장
```

---

### Phase 4: 고급 기능 (Week 4+, 선택적)

#### 4-1. QA 워크플로우 스킬

**난이도**: L | **기대효과**: ★★★★☆

```
skills/qa/SKILL.md

## browser 에이전트 연동
1. 대상 URL 입력
2. browser 에이전트로 스냅샷 + 인터랙티브 요소 탐색
3. 주요 플로우 테스트 (로그인, 폼 제출 등)
4. 콘솔 에러 수집
5. 건강 점수 평가
6. 이슈 발견 시 → worker에게 수정 위임
7. 수정 후 → 브라우저 재검증
```

#### 4-2. 기여자/자가개선 모드

**난이도**: M | **기대효과**: ★★★☆☆

```
확장 또는 스킬 실행 후 후크:

1. 스킬 완료 시 → 경험 평가 (0-10)
2. 10이 아니면 → 필드 리포트 자동 생성
3. ~/.pi/agent/contributor-logs/{slug}.md 저장
4. memory-layer에 "최근 불만족 항목" 기록
5. 다음 세션에서 참조 → 개선 우선순위 결정
```

#### 4-3. Land-and-Deploy 스킬

**난이도**: L | **기대효과**: ★★★★☆

```
skills/land-and-deploy/SKILL.md

1. PR 머지 (gh pr merge)
2. CI 상태 모니터링 (gh pr checks --watch)
3. 배포 워크플로우 감지 (GitHub Actions)
4. 배포 완료 확인
5. 기본 카나리 체크 (browser 에이전트)
6. 배포 리포트 생성
```

#### 4-4. Benchmark 스킬

**난이도**: M | **기대효과**: ★★★☆☆

```
skills/benchmark/SKILL.md

1. browser 에이전트로 대상 URL 접근
2. performance.getEntries() 수집
3. Core Web Vitals 측정
4. 베이스라인 대비 비교
5. 회귀 감지 및 보고
```

---

## 6. 구현 로드맵

### 타임라인 요약

```
Week 0 (Day 1-2)     Phase 0: 실행 기반 확인
                      ├── hook/guard 강제 지점 확인
                      └── 레포 변형 흡수 능력 확인

Week 1-2              Phase 1: 핵심 운영 워크플로우
                      ├── /ship MVP (테스트→PR)  ⭐ 최우선
                      ├── 리뷰 체크리스트 + Fix-First
                      └── Scope Drift Detection

Week 2-3              Phase 2: 안전 장치 강화
                      ├── Freeze (soft → hard)
                      └── Debugging + Scope Lock 통합

Week 3-4              Phase 3: 운영 관찰
                      ├── Document Release (MVP)
                      ├── Retro 스킬
                      ├── ETHOS 문서화
                      └── 프로액티브 스킬 라우팅

Week 4+               Phase 4: 고급 기능 (선택적)
                      ├── QA 워크플로우
                      ├── Land-and-Deploy
                      ├── Benchmark
                      └── 자가개선 모드
```

### 의존성 그래프

```
Phase 0 ──→ Phase 1 ──→ Phase 2
  │           │            │
  │           │            └──→ Phase 3 ──→ Phase 4
  │           │                   │
  │           └──→ /ship MVP      │
  │                  │            │
  └──→ freeze 강제 확인          │
         │                       │
         └──→ freeze 스킬 ──→ debug+freeze 통합
```

### 노력 추정 (AI 기준)

| 항목                        | 인간 팀    | AI 지원        | 압축률      |
| ------------------------- | ------- | ------------ | -------- |
| Phase 0: 기반 확인            | 2일      | 2-3시간        | ~7x      |
| Phase 1: /ship MVP        | 1주      | 3-5시간        | ~10x     |
| Phase 1: 체크리스트            | 2일      | 1-2시간        | ~10x     |
| Phase 2: Freeze           | 3일      | 2-3시간        | ~10x     |
| Phase 3: Document Release | 1주      | 4-6시간        | ~8x      |
| Phase 3: Retro            | 3일      | 2-3시간        | ~10x     |
| Phase 4: QA               | 1주      | 4-6시간        | ~8x      |
| **전체**                    | **~6주** | **~20-30시간** | **~10x** |

---

## 7. 리스크 분석 및 대응

### 리스크 1: "/ship 범용성 부족" (High)

**설명**: /ship이 특정 프로젝트에서만 작동하고, 다른 프로젝트에서 실패하면 신뢰도가 무너짐.

**대응**:

- Phase 0에서 주요 프로젝트 표본 조사
- MVP는 최소 기능만 (테스트→PR)
- 프로젝트별 설정을 memory에 캐싱
- 실패 시 graceful fallback (수동 안내)

### 리스크 2: "Freeze 우회 가능" (Medium)

**설명**: SKILL.md 기반 freeze는 subagent가 우회할 수 있음.

**대응**:

- 단계 1 (soft) 먼저 배포하여 수요 확인
- 우회가 문제되면 단계 2 (extension) 구현
- dynamic-agents-md.ts 기반 구현 검토

### 리스크 3: "Boil the Lake vs 범위 통제 충돌" (Medium)

**설명**: 완전성 원칙이 "범위 밖 파일 revert 금지" 규칙과 충돌할 수 있음.

**대응**:

- ETHOS.md에 명확한 경계 정의: "현재 작업의 100%"이지 "모든 것의 100%"가 아님
- YAGNI 원칙은 유지 — 불필요한 기능은 만들지 않음
- "호수"(현재 작업 범위)와 "바다"(시스템 전체) 구분

### 리스크 4: "Document Release 정확도 부족" (Medium)

**설명**: 코드 변경 → 문서 영향 판단이 부정확하면 잘못된 문서 수정을 생성.

**대응**:

- MVP는 README.md + CHANGELOG.md만 대상
- 자동 수정보다 "수정 제안" 위주
- 사용자 확인 후 적용

### 리스크 5: "스킬 과잉 — 사용되지 않는 스킬 누적" (Low)

**설명**: 많은 스킬을 추가했지만 실제로 사용되지 않으면 유지 비용만 증가.

**대응**:

- 각 Phase 완료 후 사용 빈도 측정
- 사용되지 않는 스킬은 archive
- Phase 4는 선택적 — 수요가 확인된 것만 구현

---

## 8. 결론

### 즉시 실행 가능한 Top 5

1. **`/ship` 워크플로우 스킬** — 매일 30분+ 절약, 가장 큰 빈 자리
2. **리뷰 체크리스트 + Fix-First** — reviewer 에이전트 즉시 강화
3. **Scope Drift Detection** — stress-interview에 간단히 통합
4. **Freeze (soft)** — systematic-debugging과 연동
5. **ETHOS 문서화** — 팀 원칙 명문화

### 장기적 방향

gstack의 "워크플로우 자동화" 사고방식을 pi-agent의 "에이전트 오케스트레이션" 기반 위에 구축하면, **두 시스템의 장점을 모두 갖는 독자적인 시스템**이 된다:

- gstack의 **워크플로우 구조** (ship, deploy, qa, retro)
- pi-agent의 **실행 엔진** (멀티 모델 에이전트, subagent, MCP)
- pi-agent의 **안전 장치** (확장 기반 강제 + 스킬 기반 가이드)
- gstack의 **자가 개선** (기여자 모드, 텔레메트리)

이것이 1인 개발자가 20인 팀의 프로세스를 갖추는 방법이다.

---

*이 보고서의 각 항목은 의사결정 후 바로 구현에 착수할 수 있는 수준으로 작성되었다. Phase 0→1→2→3 순서를 따르되, 각 Phase 내 항목은 독립적으로 실행 가능하다.*
