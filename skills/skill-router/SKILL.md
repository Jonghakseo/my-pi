---
name: skill-router
description: 어떤 스킬을 써야 할지 모를 때, 작업 시작 전 스킬 선택이 필요할 때, "뭐부터 해야 하지?" 상황에서 사용.
argument-hint: "어떤 스킬 쓸까 | 이 상황에 뭐가 좋을까 | 스킬 추천해줘"
disable-model-invocation: false
---

# skill-router

사용자의 현재 상황을 파악하고 가장 적합한 스킬을 추천한다.

## 라우팅 테이블

### 무엇을 하려는가?

| 상황 | 추천 스킬 | 한줄 설명 |
|------|----------|----------|
| 새 기능/큰 변경을 시작하려 한다 | **design-first** | 코드 전에 설계를 확정한다 |
| 구조화된 계획이 이미 있다 | **pipeline-execute** | worker→verifier→reviewer 자동 파이프라인 |
| 버그/테스트 실패를 만났다 | **systematic-debugging** | 수정 전에 근본원인부터 찾는다 |
| 구현이 끝나고 검증이 필요하다 | **verification-gate** | 증거 없이 "됐다"고 말하지 않는다 |
| 변경사항의 품질을 점검하고 싶다 | **stress-interview** | verifier+reviewer+challenger 병렬 압박 검토 |
| 품질 점검 후 자동으로 수정까지 하고 싶다 | **self-healing** | stress-interview → worker 수정 2사이클 |
| 코드 가독성만 개선하고 싶다 | **simplify** | 동작 변경 없이 simplifier가 다듬는다 |
| 새 스킬을 만들거나 기존 스킬을 고치고 싶다 | **writing-skills** | 스킬 자체를 TDD로 작성한다 |
| 코드를 출시하고 싶다 (PR 생성) | **ship** | 테스트→리뷰→커밋 정리→PR 자동화 |
| 웹 앱을 QA 하고 싶다 | **qa** | 브라우저 에이전트 기반 탐색→테스트→수정→재검증 |
| 보안 취약점을 점검하고 싶다 | **security-review** | security-auditor로 diff 기반 보안 검토 |
| 다이어그램/아키텍처를 그리고 싶다 | **tlboard** | tldraw 캔버스에 시각화 |
| 문서를 예쁜 HTML로 만들고 싶다 | **to-html** | 활자본 스타일 단일 HTML 생성 |
| 에이전트/스킬 사용 현황을 분석하고 싶다 | **usage-analytics** | 로그 기반 사용 통계 분석 및 인사이트 도출 |

### 의사결정 흐름

```
"무엇을 하려는가?"
│
├─ 만들거나 바꾸려 한다
│   ├─ 설계/계획이 없다 ──────→ design-first
│   ├─ 계획이 있다 ────────────→ pipeline-execute
│   └─ 스킬을 만든다 ──────────→ writing-skills
│
├─ 고치려 한다
│   ├─ 원인을 모른다 ──────────→ systematic-debugging
│   └─ 가독성만 개선 ──────────→ simplify
│
├─ 검증하려 한다
│   ├─ "진짜 되나?" 확인 ──────→ verification-gate
│   ├─ 다각도 압박 검토 ───────→ stress-interview
│   └─ 검토 + 자동 수정 ──────→ self-healing
│
├─ 출시하려 한다 ──────────────→ ship
│
├─ 웹 앱을 테스트하려 한다 ────→ qa
│
├─ 보안을 점검하려 한다 ────────→ security-review
│
├─ 시각화하려 한다 ────────────→ tlboard
│
├─ 사용 현황을 분석하려 한다 ──→ usage-analytics
│
└─ 문서화하려 한다 ────────────→ to-html
```

### 흔한 워크플로 조합

**기능 개발 풀 사이클:**
```
design-first → pipeline-execute → stress-interview → qa → ship
```

**버그 수정:**
```
systematic-debugging → verification-gate
```

**빠른 품질 개선:**
```
simplify → verification-gate
```

**PR 전 최종 점검:**
```
stress-interview (--2pass) → verification-gate
```

**자동 안정화:**
```
self-healing → verification-gate
```

## 사용법

이 스킬은 직접 실행하는 것이 아니라, **상황을 설명하면 적합한 스킬을 안내**한다.

예시:
- "테스트가 자꾸 실패해" → `systematic-debugging` 추천
- "이 기능 구현하고 싶어" → `design-first` 추천
- "방금 만든 코드 괜찮은지 봐줘" → `stress-interview` 추천
- "커밋해도 될까?" → `verification-gate` 추천
- "PR 만들어줘" / "출시해줘" → `ship` 추천
- "이 페이지 테스트해줘" / "QA 해줘" → `qa` 추천
