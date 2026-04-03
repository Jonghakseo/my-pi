# Extension 강화 전략: Superpowers 분석 기반

> **기준일**: 2025-03-07  
> **분석 대상**: [obra/superpowers](https://github.com/obra/superpowers) vs 현재 Pi Agent 시스템

---

## 1. 현황 비교 매트릭스

### Superpowers (13 skills)
| Skill | 역할 | 핵심 가치 |
|-------|------|-----------|
| brainstorming | 구현 전 소크라틱 설계 정제 | "코드 전에 설계, 설계 전에 질문" |
| writing-plans | 2-5분 단위 bite-sized 태스크 생성 | 실행 가능한 계획 = 코드까지 포함 |
| subagent-driven-development (SDD) | 태스크별 서브에이전트 + 2단계 리뷰 | spec 적합 → 코드 품질 순서 |
| executing-plans | 배치 실행 + 체크포인트 | 아키텍트 리뷰 게이트 |
| test-driven-development | RED-GREEN-REFACTOR 강제 | "실패를 안 봤으면 테스트가 아니다" |
| systematic-debugging | 4단계 근본원인 추적 | "수정 전에 원인 규명" |
| verification-before-completion | 증거 없이 완료 주장 금지 | "should ≠ evidence" |
| dispatching-parallel-agents | 독립 문제 병렬 해결 | 시간 절약 |
| using-git-worktrees | 격리된 작업 공간 | 안전한 실험 |
| finishing-a-development-branch | 머지/PR 워크플로 | 구조화된 종료 |
| requesting-code-review | 리뷰 요청 체크리스트 | 품질 게이트 |
| receiving-code-review | 리뷰 피드백 대응 | 건설적 수용 |
| writing-skills | 스킬 자체를 TDD로 작성 | 메타-프로세스 품질 |

### 현재 Pi Agent
| 카테고리 | 보유 자산 | 개수 |
|----------|----------|------|
| Skills | self-healing, stress-interview, code-polishing, to-html | 4 |
| Agents | worker, reviewer, verifier, planner, challenger, simplifier, finder, searcher, browser, code-cleaner, security-auditor | 11 |
| Extensions | memory-layer, subagent/, system-mode, claude-mcp-bridge, diff-overlay, 등 | 29+ |

---

## 2. Gap 분석

### 🔴 Critical Gap — 워크플로 스킬 부재

현재 시스템은 **도구(agents, extensions)는 풍부하지만 워크플로(skills)가 빈약**하다.

```
Superpowers 방식:  brainstorm → plan → worktree → SDD/execute → review → finish
Pi Agent 현재:     (즉시 구현) ────────────────────────────────────────────→ (완료 주장)
```

| Gap | 영향도 | 우리가 이미 가진 것 |
|-----|--------|-------------------|
| **설계 전 질문 프로세스** 없음 | 🔴 High | planner 에이전트 존재하나 스킬로 강제되지 않음 |
| **구조화된 계획 작성** 없음 | 🔴 High | planner가 할 수 있으나 bite-sized 포맷 미정의 |
| **SDD 오케스트레이션** 없음 | 🔴 High | worker + reviewer + verifier 있으나 파이프라인 미정의 |
| **TDD 강제** 없음 | 🟡 Med | worker에 간접적 품질 기대치만 존재 |
| **체계적 디버깅** 없음 | 🟡 Med | stress-interview가 부분 커버 |
| **완료 검증 강제** 없음 | 🟡 Med | verifier 에이전트가 존재하나 자동 게이트 아님 |
| **Git worktree 자동화** 없음 | 🟢 Low | bash로 가능, 스킬화 우선순위 낮음 |
| **브랜치 종료 워크플로** 없음 | 🟢 Low | gh CLI 사용 가능 |

### 🟢 우리만의 강점 — Superpowers에 없는 것

| 강점 | 설명 |
|------|------|
| **Memory Layer** | 프로젝트/사용자 장기 기억 → 컨텍스트 누적 학습 |
| **11개 전문 에이전트** | Superpowers는 "subagent"만 사용, 우리는 역할별 전문가 |
| **MCP Bridge** | Jira, Slack, Figma, DB 등 외부 시스템 통합 |
| **Self-Healing** | stress-interview → worker 수정 자동 루프 (Superpowers에 없음) |
| **System Mode** | 운영 모드 전환 |
| **Extension 아키텍처** | 단독 파일 + 모듈형 확장 → 유연한 조합 |

---

## 3. 전략 방향: "도구 위에 워크플로를 얹는다"

Superpowers의 핵심 교훈:

> **"에이전트에게 도구를 주는 것만으로는 부족하다. 도구를 언제, 어떤 순서로, 어떤 조건에서 쓸지 정의하는 것이 핵심이다."**

우리 전략은 **Superpowers의 워크플로 패턴을 Pi의 에이전트·확장 아키텍처에 맞게 재해석**하는 것이다.

### 3.1 채택할 패턴 (Adopt)

| Superpowers 패턴 | Pi 적용 방식 |
|------------------|-------------|
| **2단계 리뷰** (spec → quality) | stress-interview를 2-pass로 확장: `verifier` → `reviewer` |
| **Bite-sized 계획** | planner 에이전트의 출력 포맷을 표준화 (2-5분 단위 태스크) |
| **Iron Law: 증거 없이 완료 금지** | verification-gate 스킬 신설 |
| **디버깅 4단계** | systematic-debugging 스킬 신설 |
| **스킬 자체의 TDD** | writing-skills 스킬 도입으로 스킬 품질 관리 |

### 3.2 변형할 패턴 (Adapt)

| Superpowers 패턴 | Pi 변형 |
|------------------|--------|
| **SDD (단일 implementer)** | 우리는 이미 전문 에이전트 11개 → **역할별 디스패치 파이프라인**으로 진화 |
| **brainstorming** | planner 에이전트 + 대화형 설계 스킬로 통합 |
| **Git worktree** | Pi의 bash + 확장으로 충분, 별도 스킬 불필요 |

### 3.3 무시할 패턴 (Skip)

| 패턴 | 이유 |
|------|------|
| `finishing-a-development-branch` | gh CLI + 기존 워크플로로 충분 |
| `receiving-code-review` | reviewer/challenger가 이미 양방향 |
| `using-superpowers` 메타 스킬 | Pi의 skill discovery가 이미 자동 |

---

## 4. 구체적 실행 계획

### Phase 1: 핵심 워크플로 스킬 3종 (High Impact)

#### 🆕 Skill: `design-first`
> Superpowers `brainstorming` + `writing-plans`의 통합 변형

```
트리거: 새 기능 구현, 큰 변경 요청 시
흐름:
  1. planner 에이전트로 컨텍스트 파악 + 질문
  2. 2-3 접근법 제시 → 사용자 선택
  3. 승인된 설계를 bite-sized 계획으로 변환
  4. 계획 파일 저장 → 실행 스킬로 핸드오프
```

**Superpowers와의 차이**: planner 에이전트가 코드베이스를 직접 탐색하므로 더 정확한 계획 가능.

#### 🆕 Skill: `pipeline-execute`
> Superpowers `SDD`의 Pi 버전 — 역할별 에이전트 파이프라인

```
트리거: 구조화된 계획이 있을 때
흐름:
  태스크마다:
    1. worker: 구현 + 셀프리뷰
    2. verifier: 테스트/빌드/타입체크 증거 수집
    3. reviewer: correctness + 코드 품질
    4. 실패 시 → worker에게 수정 지시 → 2-3 재시도
    5. 통과 시 → 다음 태스크
```

**Superpowers와의 차이**: 
- Superpowers는 implementer 1개 + reviewer 2개(spec/quality)
- 우리는 worker + verifier + reviewer 3개 전문 에이전트 → 더 깊은 검증

#### 🆕 Skill: `verification-gate`
> Superpowers `verification-before-completion`의 Pi 버전

```
트리거: 완료를 주장하기 직전
규칙:
  - "should", "probably" 사용 금지
  - 모든 완료 주장에 실행 증거 필수
  - verifier 에이전트 자동 호출
  - 증거 없으면 완료 불가
```

### Phase 2: 기존 스킬 강화 (Medium Impact)

#### 🔄 `stress-interview` 강화
현재: verifier + reviewer + challenger 병렬 → 종합 보고  
추가:
- **2-pass 리뷰 모드**: Superpowers의 spec-compliance → code-quality 순서 도입
- **구조화된 심각도 분류**: Must-fix / Should-fix / Won't-fix

#### 🔄 `self-healing` 강화
현재: stress-interview → worker 2사이클  
추가:
- **TDD 강제**: worker 수정 시 실패 테스트 먼저 작성
- **검증 게이트**: 각 사이클 종료 시 verifier 증거 필수

### Phase 3: 디버깅 & 메타 스킬 (Lower Priority)

#### 🆕 Skill: `systematic-debugging`
> Superpowers 4단계 디버깅의 Pi 버전

```
흐름:
  Phase 1: 근본원인 조사 (수정 금지)
  Phase 2: 패턴 분석 (작동하는 코드와 비교)
  Phase 3: 가설 + 최소 테스트
  Phase 4: TDD로 수정 (실패 테스트 먼저)
  
  3회 수정 실패 시 → 아키텍처 재검토 에스컬레이션
```

#### 🆕 Skill: `writing-skills`
> 스킬을 TDD로 작성하는 메타 스킬

```
RED:   서브에이전트로 압력 시나리오 테스트 (스킬 없이)
GREEN: 실패 패턴을 해결하는 최소 스킬 작성
REFACTOR: 합리화 빈틈 메우기
```

---

## 5. 아키텍처 통합 전략

### 스킬과 에이전트의 관계 재정의

```
┌─────────────────────────────────────────────────┐
│                  Skills (워크플로)                 │
│  design-first → pipeline-execute → verification  │
│       ↓              ↓                ↓          │
│  ┌─────────┐  ┌──────────────┐  ┌──────────┐    │
│  │ planner │  │worker→verif→ │  │ verifier │    │
│  │         │  │   reviewer   │  │          │    │
│  └─────────┘  └──────────────┘  └──────────┘    │
│                  Agents (도구)                     │
├─────────────────────────────────────────────────┤
│               Extensions (인프라)                  │
│  memory-layer | subagent/ | MCP | overlays       │
└─────────────────────────────────────────────────┘
```

### Superpowers의 핵심 교훈 3가지

1. **Iron Law 패턴**: 절대 규칙을 정하고, 위반 시 합리화 테이블로 모든 핑계를 차단
2. **CSO (Claude Search Optimization)**: description은 "Use when..." 트리거만, 워크플로 요약 금지
3. **스킬 vs 에이전트 구분**: 스킬은 "언제, 어떤 순서로" → 에이전트는 "구체적으로 어떻게"

---

## 6. 우선순위 로드맵

| 순서 | 스킬 | 예상 효과 | 난이도 |
|------|------|----------|--------|
| **1** | `verification-gate` | 완료 품질 즉시 향상 | ⭐ 낮음 |
| **2** | `pipeline-execute` | 대규모 태스크 자동화 | ⭐⭐⭐ 높음 |
| **3** | `design-first` | 구현 전 설계 품질 향상 | ⭐⭐ 중간 |
| **4** | `stress-interview` 2-pass | 리뷰 깊이 향상 | ⭐ 낮음 |
| **5** | `systematic-debugging` | 디버깅 효율 향상 | ⭐⭐ 중간 |
| **6** | `writing-skills` | 스킬 자체 품질 관리 | ⭐⭐ 중간 |

---

## 7. 결론

**Superpowers의 핵심 통찰**:  
> 도구의 수가 아니라, 도구를 엮는 워크플로의 체계가 결과를 결정한다.

**우리의 전략**:  
> 이미 보유한 11개 전문 에이전트 + 29개 확장을 **워크플로 스킬로 연결**하여,  
> Superpowers의 "계획 → 실행 → 검증" 파이프라인을 **더 깊고 전문화된 형태**로 구현한다.

**차별화 포인트**:
1. Superpowers = 범용 subagent 1개로 모든 걸 함 → **우리 = 역할별 전문 에이전트**
2. Superpowers = 세션 내 컨텍스트만 → **우리 = Memory Layer로 누적 학습**
3. Superpowers = 코딩 에이전트 전용 → **우리 = MCP로 Jira/Slack/DB 통합 워크플로**
