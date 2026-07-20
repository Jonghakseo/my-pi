---
name: usage-analytics
description: "서브에이전트·스킬 사용 통계와 미사용 항목을 분석해 인사이트를 도출할 때 사용한다."
disable-model-invocation: false
---

# usage-analytics

`$ARGUMENTS` 요청에 따라 서브에이전트·스킬 사용 데이터를 분석하고 인사이트를 도출한다.

## 데이터 소스

로그 파일: `~/.pi/agent/state/usage-analytics.jsonl`

각 줄은 JSON 객체이며 4가지 타입이 있다:

```jsonc
// 서브에이전트 시작 (run/batch/chain은 agent명 포함, continue는 "_continue" 플레이스홀더)
// 집계: subagent_end가 우선이며, end가 없는 legacy/incomplete batch/chain start만 total fallback으로 사용
{ "type": "subagent_start", "ts": "ISO8601", "epoch": 1234567890, "agent": "worker", "mode": "run" }

// 서브에이전트 완료 (집계의 단일 소스)
{ "type": "subagent_end", "ts": "ISO8601", "epoch": 1234567890, "agent": "worker", "runId": 42, "status": "error", "elapsedMs": 45000, "model": "openai-codex/gpt-5.3-codex-spark", "errorClass": "context_overflow", "peakContextTokens": 127196, "lastToolName": "read", "lastToolOutputChars": 9032 }

// 명시적 스킬 호출: `/skill:name`이 확장된 사용자 `<skill>` 메시지가 확정될 때 기록
{ "type": "skill_invoked", "ts": "ISO8601", "epoch": 1234567890, "skill": "picky-cli", "path": "/path/to/SKILL.md" }

// SKILL.md 읽기: 에이전트가 read 도구로 직접 열었을 때 기록하며, 같은 스킬의 10초 내 중복 read는 제외
{ "type": "skill_read", "ts": "ISO8601", "epoch": 1234567890, "skill": "systematic-debugging", "path": "/path/to/SKILL.md" }
```

## 실행 절차

### Step 1: 기간 결정

`$ARGUMENTS`에서 분석 기간을 파악한다. 명시되지 않으면 **최근 7일**을 기본값으로 사용한다.

| 사용자 표현 | 기간 |
|------------|------|
| "최근 일주일", "이번 주" | 최근 7일 |
| "최근 한 달", "이번 달" | 최근 30일 |
| "전체", "처음부터" | 로그 전체 |
| "오늘" | 오늘 하루 |
| 구체적 날짜 범위 | 해당 범위 |

### Step 2: 데이터 로드

```bash
cat ~/.pi/agent/state/usage-analytics.jsonl
```

파일이 없거나 비어있으면 **"아직 수집된 사용 데이터가 없습니다."** 로 종료한다.

### Step 3: 분석 항목 산출

로그 데이터를 파싱해서 아래 항목을 계산한다. 사용자 요청이 특정 항목에 한정되면 해당 항목만 계산해도 된다.

#### 3-A. 서브에이전트 분석

| 지표 | 계산 방법 |
|------|----------|
| **호출 빈도** | `subagent_end` 이벤트 수를 우선 집계하고, 매칭되는 end가 없는 legacy/incomplete batch/chain의 `subagent_start` 이벤트 수만 fallback으로 더함 |
| **성공/실패 건수** | `subagent_end`의 `status` 필드로 집계 |
| **에러율** | `error / (done + error) * 100` |
| **평균 소요시간** | `subagent_end`의 `elapsedMs` 평균 |
| **최장/최단 소요시간** | `elapsedMs`의 max / min |
| **사용 모델 분포** | `model` 필드별 건수 |
| **호출 모드 분포** | `mode` 필드별 건수 (run/continue/batch/chain) |
| **실패 원인 분포** | `errorClass`별 건수 (`context_overflow`, `overloaded`, `rate_limit`, `tool_error`, `aborted`, `process_error`, `unknown`) |
| **실패 시 컨텍스트·도구** | `peakContextTokens`, `lastToolName`, `lastToolOutputChars`로 실패 직전 상태 분석 |
| **일별 추이** | 날짜별 호출 건수 변화 |

#### 3-B. 스킬 분석

`skill_invoked`와 `skill_read`는 의미가 다르므로 합산하지 않고 반드시 분리한다.

| 지표 | 계산 방법 |
|------|----------|
| **명시적 호출 빈도** | `skill_invoked` 이벤트 수를 skill별로 집계. 실제 `/skill:name` 호출의 기본 지표로 사용 |
| **직접 읽기 빈도** | `skill_read` 이벤트 수를 skill별로 집계. 에이전트가 SKILL.md를 직접 로드한 활동으로 별도 표시 |
| **일별 추이** | 날짜별 `skill_invoked`와 `skill_read` 건수를 각각 계산 |
| **마지막 호출일** | 가장 최근 `skill_invoked`의 `ts` |
| **마지막 읽기일** | 가장 최근 `skill_read`의 `ts` |

> `skill_invoked`는 이벤트 도입 이후부터 forward-only로 기록된다. 과거 데이터는 백필되지 않았으므로, 도입 전 기간의 호출 0회를 미사용 근거로 해석하지 않는다.

### Step 4: 인사이트 도출

산출된 수치를 바탕으로 아래 관점에서 인사이트를 도출한다.

#### 서브에이전트 인사이트

- **과다 사용**: 전체 호출의 40% 이상을 차지하는 에이전트 → 세분화(역할 분리) 검토 필요
- **미사용/저사용**: 분석 기간 내 0회 또는 1회만 호출된 에이전트 → 불필요 여부 검토
- **높은 에러율**: 에러율 20% 이상인 에이전트 → 프롬프트/설정 개선 필요
- **비효율**: 평균 소요시간이 다른 에이전트 대비 2배 이상인 에이전트 → 태스크 범위 축소 검토
- **continue 비율**: continue 모드 비율이 높으면 → 한 번에 완료하지 못하는 태스크가 많다는 신호
- **컨텍스트 초과**: `errorClass=context_overflow`이고 `peakContextTokens`가 모델 한도에 근접하면 → 태스크 분할·탐색 출력 제한·guard 조정 검토
- **도구 출력 과다**: 실패 직전 `lastToolOutputChars`가 크면 → 검색 limit·read range·대상 경로 축소 검토

#### 스킬 인사이트

- **미사용**: 계측 적용 기간 내 `skill_invoked`와 `skill_read`가 모두 0회인 스킬 → 삭제 또는 통합 검토
- **명시적 과다 호출**: 전체 `skill_invoked`의 50% 이상을 차지 → 해당 스킬의 명시적 호출 패턴 검토
- **과다 읽기**: 전체 `skill_read`의 50% 이상을 차지 → 반복 로드 또는 지나치게 넓은 트리거 검토
- **최근 미사용**: 마지막 호출과 마지막 읽기가 모두 30일 이상 전 → 여전히 필요한지 재평가

### Step 5: 보고서 출력

아래 형식으로 보고서를 작성한다.

```
## 📊 사용 통계 분석 (기간: YYYY-MM-DD ~ YYYY-MM-DD)

### 🤖 서브에이전트

#### 요약
- 총 호출: N회 (성공 N회, 실패 N회)
- 활성 에이전트: N개 / 전체 N개

#### 에이전트별 상세

| 에이전트 | 호출 | 성공 | 실패 | 에러율 | 평균시간 | 비고 |
|---------|------|------|------|--------|---------|------|
| worker  | 45   | 42   | 3    | 6.7%   | 32s     |      |
| ...     |      |      |      |        |         |      |

#### 인사이트
- ...

### 📚 스킬

#### 스킬별 상세

| 스킬 | 명시적 호출 | 직접 읽기 | 마지막 호출 | 마지막 읽기 | 비고 |
|------|------------|----------|------------|------------|------|
| ...  |            |          |            |            |      |

#### 미사용 스킬
- ...

#### 인사이트
- ...

### 💡 제안
- ...
```

## 핵심 규칙

1. **데이터 기반**: 모든 판단은 로그 수치에 근거한다. 추측하지 않는다.
2. **기간 준수**: 사용자가 지정한 기간 외의 데이터는 분석에 포함하지 않는다.
3. **이벤트 의미 분리**: `skill_invoked`를 명시적 호출, `skill_read`를 직접 읽기로 표시하며 서로 합산하거나 바꿔 부르지 않는다.
4. **계측 범위 명시**: 백필되지 않은 도입 전 기간은 명시적 호출 통계의 미수집 구간으로 표시한다.
5. **미사용 탐지**: 등록된 에이전트/스킬 목록과 실제 사용을 대조한다. 등록 목록은 아래 명령으로 확인한다:
   - 에이전트: `ls ~/.pi/agent/agents/` + `ls .pi/agents/` (프로젝트별)
   - 스킬: `ls ~/.pi/agent/skills/` + `ls .pi/skills/` (프로젝트별)
6. **간결한 제안**: 인사이트마다 구체적 행동을 하나씩 제안한다.
