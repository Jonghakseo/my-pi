---
name: pipeline-execute
description: 구조화된 구현 계획이 있을 때 사용. 태스크별로 worker→verifier→reviewer 파이프라인을 순차 실행.
argument-hint: "이 계획 실행해줘 | 플랜대로 구현 시작 | pipeline으로 태스크 처리"
disable-model-invocation: false
---

# pipeline-execute

구현 계획의 태스크를 **worker → verifier → reviewer** 3단계 파이프라인으로 순차 실행한다.

**핵심 원칙:** 태스크마다 전문 에이전트가 구현 → 검증 → 리뷰. 리뷰 통과 전 다음 태스크 금지.

## 언제 사용하나

```
구조화된 계획이 있는가?
  ├─ YES → 태스크가 대체로 독립적인가?
  │         ├─ YES → pipeline-execute
  │         └─ NO (강결합) → 수동 실행 또는 계획 재분할
  └─ NO → design-first 스킬로 계획부터 만든다
```

## 전체 흐름

```
계획 읽기 → 전체 태스크 추출 → TodoWrite 생성
  │
  ▼ (태스크마다 반복)
┌─────────────────────────────────┐
│  1. worker: 구현 + 셀프리뷰      │
│       ↓                         │
│  2. verifier: 테스트/빌드/증거    │
│       ↓                         │
│  3. reviewer: correctness/품질   │
│       │                         │
│    통과? ──NO──→ worker 수정     │
│       │          → 2번부터 재시도 │
│      YES                        │
│       ↓                         │
│  TodoWrite 완료 처리             │
└─────────────────────────────────┘
  │
  ▼ (전체 완료)
최종 리뷰 → 완료 보고
```

## 실행 규칙

### Step 1: 계획 읽기 + TodoWrite 생성

1. 계획 파일을 **한 번만** 읽는다
2. 모든 태스크의 전문(full text)을 추출한다
3. 각 태스크의 컨텍스트(의존성, 파일 경로, 아키텍처 위치)를 메모한다
4. TodoWrite에 전체 태스크를 등록한다

### Step 2: 태스크별 파이프라인

#### 2-1. Worker 디스패치

```
worker에게:
"Task N: [태스크명]을 구현해줘.

## 태스크 설명
[계획에서 추출한 전문 — 파일로 읽게 하지 말고 직접 전달]

## 컨텍스트
[이 태스크가 전체에서 어디에 위치하는지, 의존성, 관련 파일]

## 작업 지침
1. 태스크 명세대로 정확히 구현
2. 테스트 작성 (가능하면 TDD)
3. 구현 확인 후 커밋
4. 셀프리뷰: 완전성, 품질, YAGNI 점검
5. 결과 보고: 구현 내용, 테스트 결과, 변경 파일, 우려 사항"
```

**worker가 질문하면**: 명확하고 완전하게 답한다. 서두르지 않는다.

#### 2-2. Verifier 디스패치

```
verifier에게:
"Task N의 구현을 검증해줘.

## 검증 대상
[worker가 변경한 파일 목록]

## 필수 검증
1. 테스트 실행 — 전체 통과 확인
2. 타입체크 — 에러 없음 확인
3. 빌드 — 성공 확인
4. 변경 내용이 태스크 명세와 일치하는지 확인

증거(실행 출력)와 함께 결과를 보고해줘."
```

#### 2-3. Reviewer 디스패치

```
reviewer에게:
"Task N의 구현을 리뷰해줘.

## 리뷰 범위
[변경된 파일과 git diff 요약]

## 리뷰 기준
2-Pass 체크리스트를 적용해줘:
- Pass 1 (Critical): SQL Safety, Auth, Race Conditions, Secret Exposure, LLM Trust Boundary
- Pass 2 (Informational): Dead Code, Magic Numbers, Test Gaps, Performance, Consistency, Error Handling

각 finding에 fix_class(AUTO_FIX / ASK / INFO)를 분류해줘."
```

### Step 3: 리뷰 결과 처리

reviewer의 YAML 출력에서 `priority`와 `fix_class`를 기준으로 처리한다:

- **P0/P1 + ASK**: worker에게 수정 지시 → verifier → reviewer 재실행
- **P0/P1 + AUTO_FIX**: worker에게 즉시 수정 지시 → 빠른 검증
- **P0/P1 + INFO**: 기존 코드의 심각한 문제 — 기록하고 사용자에게 에스컬레이션 (이번 태스크에서 수정하지 않음)
- **P2/P3 + AUTO_FIX**: worker에게 즉시 수정 지시
- **P2/P3 + ASK**: 기록하고 **다음 태스크로 진행** (이 분류는 "미해결 이슈"가 아닌 "후속 작업 후보"로 취급. 금지 규칙의 "미해결 이슈"는 P0/P1만 해당)
- **P2/P3 + INFO**: 기록만 하고 진행
- **최대 3회 재시도** — 3회 실패 시 에스컬레이션

### Step 4: 전체 완료

모든 태스크 완료 후:
1. `reviewer`에게 전체 구현 최종 리뷰 요청
2. 결과 보고: 완료된 태스크, 남은 리스크, 최종 상태

## 금지 사항

**절대로:**
- 리뷰 건너뛰기 (verifier든 reviewer든)
- 미해결 이슈가 있는데 다음 태스크로 이동
- 여러 worker를 동시에 같은 코드에 디스패치 (충돌)
- worker에게 계획 파일을 직접 읽게 하기 (전문을 전달)
- verifier 전에 reviewer 실행 (순서 중요)
- "대충 괜찮아 보인다"로 리뷰 통과 처리

**worker 실패 시:**
- 새 worker에게 구체적 수정 지시
- 직접 수정하지 않는다 (컨텍스트 오염)

## stress-interview와의 관계

- `pipeline-execute`는 태스크 단위 순차 파이프라인
- `stress-interview`는 완성된 결과물에 대한 종합 압박 검토
- 권장: pipeline-execute 완료 후 → stress-interview로 최종 점검

## 장점

| vs 수동 실행 | vs 단순 위임 |
|-------------|-------------|
| 자동 품질 게이트 | 3단계 전문 검증 |
| 일관된 프로세스 | 컨텍스트 오염 없음 |
| 추적 가능한 진행 | 실패 시 자동 재시도 |

## 비용

- 태스크당 에이전트 3개 호출 (worker + verifier + reviewer)
- 재시도 시 추가 호출
- 그러나 **초기에 문제를 잡으므로 나중에 디버깅하는 것보다 저렴**
