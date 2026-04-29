---
name: auto-update
description: pi 릴리즈 업데이트 시 현재 버전/최신 버전 확인, CHANGELOG 검토, extensions 영향 분석, extensions 내 pi 관련 의존성 업데이트, 호환성 대응, 업데이트 내역 시각화까지 순서대로 수행하는 워크플로우.
argument-hint: "pi 업데이트해줘 | 이번 릴리즈 반영하자 | /auto-update"
disable-model-invocation: false
---

# auto-update

`$ARGUMENTS`가 없으면 **현재 레포 기준 pi 업데이트 작업**으로 간주한다.

목표는 아래 6단계를 **순서대로** 수행하는 것이다.

1. `pi -v` 로 현재 설치 버전과 설치 가능한 최신 버전 확인
2. 공식 CHANGELOG에서 업데이트 내역 확인
3. `extensions/`에서 영향받는 코드와 의존성 위치 확인
4. `extensions/` 내부의 pi 관련 의존성 업데이트
5. 필요한 대응 코드 수정 및 검증
6. 업데이트 내역을 시각화하고 최종 보고

---

## 출력 원칙

항상 아래 순서로 보고한다.

1. **Version** — 현재 버전 / 최신 버전 / 업데이트 필요 여부
2. **Changelog** — 이번 업데이트에서 특히 영향 있는 항목 3~10개
3. **Impact scan** — 영향받는 `extensions/` 파일, 패키지, 기능
4. **Dependency updates** — 어떤 `package.json`을 어떻게 바꿨는지
5. **Code changes** — 실제 대응한 파일과 이유
6. **Validation** — typecheck/test 결과
7. **Visualization** — 버전 변화, CHANGELOG 영향, 변경 파일, 검증 결과를 한눈에 볼 수 있는 시각화
8. **Follow-ups** — 남은 수동 확인 사항

공식 근거가 있으면 반드시 링크를 포함한다.

---

## Step 1. 버전 확인

반드시 먼저 실행:

```bash
pi -v
```

여기서 현재 설치 버전과 최신 버전을 읽는다.

### 보조 확인

`pi -v` 출력이 불명확하면 아래로 보조 확인한다.

```bash
npm view @mariozechner/pi-coding-agent version
```

필요하면 현재 repo에서 사용 중인 pi 관련 버전도 함께 확인한다.

우선 확인 대상:
- `extensions/package.json`
- `extensions/**/package.json`
- 루트 `package.json`의 `peerDependencies`
- `settings.json`의 `lastChangelogVersion`

---

## Step 2. CHANGELOG 확인

우선 이 공식 문서를 확인한다:

- `https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/CHANGELOG.md`

가능하면 문서 fetch 도구를 사용해 읽고, 실패 시 웹 검색/브라우저/CLI로 본다.

### CHANGELOG 읽는 방법

다음을 추린다:
- 현재 버전과 최신 버전 사이의 모든 릴리즈
- extension API 변경점
- command / skill / prompt / theme 관련 변경점
- 타입 변경, import 경로 변경, tool schema 변경
- TUI/SDK 동작 변경
- deprecated / removed 항목

### 요약 방식

각 항목을 아래 형식으로 정리한다:

```md
- vX.Y.Z — {변경 요약}
  - 영향: {우리 repo에서 영향받는 extension/기능}
  - 대응 필요: yes/no
```

---

## Step 3. `extensions/` 영향 범위 스캔

### 3-1. 의존성 위치 찾기

`extensions/` 아래에서 pi 관련 의존성이 선언된 파일을 모두 찾는다.

찾아야 하는 패턴:
- `@mariozechner/pi-coding-agent`
- `@mariozechner/pi-agent-core`
- `@mariozechner/pi-ai`
- `@mariozechner/pi-tui`

특히 확인 대상:
- `extensions/package.json`
- `extensions/remote/package.json`
- 그 외 `extensions/**/package.json`

### 3-2. 코드 사용처 찾기

`extensions/` 내부에서 아래를 검색해 영향 가능성이 큰 코드를 모은다.

- `import type { ExtensionAPI`
- `pi.registerCommand(`
- `pi.registerTool(`
- `pi.on(`
- `@mariozechner/pi-coding-agent`
- `@mariozechner/pi-tui`
- `@mariozechner/pi-ai`

변경 가능성이 큰 영역:
- slash command 등록 코드
- input/event hook 코드
- tool schema/execute 시그니처
- TUI 컴포넌트 사용 코드
- model/provider 관련 코드
- skill/prompt/template 관련 동작

### 3-3. CHANGELOG 매핑

CHANGELOG의 각 의미 있는 항목에 대해 아래를 만든다.

```md
- 변경점: {공식 changelog 내용}
- 우리 코드 영향: {파일 경로들}
- 조치: {무시 / 버전만 업데이트 / 코드 수정 필요}
```

---

## Step 4. 의존성 업데이트

### 4-1. 업데이트 원칙

- `extensions/` 폴더 내부의 pi 관련 의존성은 **모두 같은 릴리즈 계열**로 맞춘다.
- 범위 밖 파일은 건드리지 않는다.
- `latest`를 쓰는 곳이 있더라도, 가능하면 이번 확인한 최신 버전으로 명시적으로 맞추는 것을 우선 검토한다.
- 루트 `package.json`의 `peerDependencies`는 실제 호환성 정책이 바뀌지 않으면 함부로 좁히지 않는다.

### 4-2. 우선 수정 대상

보통 다음을 점검/수정한다.

- `extensions/package.json`
  - `@mariozechner/pi-agent-core`
  - `@mariozechner/pi-ai`
  - `@mariozechner/pi-coding-agent`
  - `@mariozechner/pi-tui`
- `extensions/remote/package.json`
  - `@mariozechner/pi-coding-agent`
- `extensions/**/package.json` 중 pi 관련 패키지가 있는 모든 파일

### 4-3. 설치

의존성 파일 수정 후 실행:

```bash
cd extensions && pnpm install
```

락파일 변경도 함께 검토한다.

---

## Step 5. 대응 코드 수정

CHANGELOG와 영향 스캔 결과를 근거로 필요한 부분만 최소 수정한다.

예시 대응:
- 타입 이름/시그니처 변경 대응
- deprecated API 교체
- import 경로 변경 대응
- command/prompt/skill 처리 순서 변화 대응
- TUI 렌더링 계약 변화 대응
- tool result shape 변화 대응

### 수정 원칙

- CHANGELOG 근거 없는 추측성 수정 금지
- 사용자 노출 계약은 의도 없이 바꾸지 않기
- 한 변경은 한 이유로 묶기
- 가능하면 파일별로 수정 이유를 남기기 쉽게 유지

---

## Step 6. 검증

최소 검증:

```bash
cd extensions && pnpm run typecheck
```

가능하면 추가 검증:

```bash
cd extensions && pnpm run test
```

필요 시 전체 패키지 설치/로드 관점 확인:

```bash
pnpm install
pi -v
```

### 검증 기준

- 새 타입 오류가 없어야 함
- 새 테스트 실패가 없어야 함
- CHANGELOG 대응 범위 밖 회귀를 만들지 않아야 함

---

## Step 7. 업데이트 내역 시각화

최종 응답 전, 시각화 도구를 사용할 수 있으면 반드시 `show_widget`으로 업데이트 결과를 보여준다.

첫 `show_widget` 호출 전에는 내부 준비 단계로 `visualize_read_me`를 한 번 호출한다.

### 시각화에 반드시 포함할 내용

- 버전 변화: 현재 버전 → 최신/적용 버전, 업데이트 필요 여부
- CHANGELOG 핵심 항목: provider/API/runtime/security/UI 등 영향 카테고리
- Impact scan 결과: 영향받은 `extensions/` 패키지/기능과 코드 수정 필요 여부
- Dependency updates: 변경된 `package.json` / lockfile / pi 관련 패키지 버전
- Validation 상태: typecheck/test 성공·실패와 테스트 개수
- Follow-ups: 수동 확인이 필요한 항목이나 범위 밖 변경사항

### 권장 시각화 구성

- 상단 metric cards: 버전, 변경 패키지 수, 코드 수정 수, 검증 상태
- 중간 flow/diagram: Version → Changelog → Impact → Update → Validation
- 하단 detail cards: 실제 CHANGELOG 항목별 영향과 조치
- 변경 파일은 `extensions/package.json`, `extensions/pnpm-lock.yaml`처럼 명확한 경로로 표시

시각화는 보조 산출물이므로, 최종 텍스트 보고도 기존 출력 원칙 순서대로 반드시 제공한다.

---

## 체크리스트

작업 종료 전 반드시 확인:

- [ ] `pi -v` 결과를 기록했는가
- [ ] CHANGELOG에서 현재→최신 사이 릴리즈를 확인했는가
- [ ] `extensions/` 내 모든 pi 관련 `package.json`을 확인했는가
- [ ] 버전 업데이트와 코드 대응을 분리해서 설명했는가
- [ ] `extensions` 기준 `pnpm run typecheck`를 실행했는가
- [ ] 가능하면 `pnpm run test`도 실행했는가
- [ ] 업데이트 내역 시각화를 제공했는가
- [ ] 남은 수동 확인 항목을 적었는가

---

## 금지 사항

- CHANGELOG 안 읽고 버전만 올리기
- `extensions/` 영향 스캔 없이 일괄 수정하기
- 범위 외 파일까지 광범위하게 수정하기
- 검증 없이 "업데이트 완료"라고 말하기
- 시각화 도구가 사용 가능한데도 업데이트 요약 시각화를 생략하기

---

## 최종 응답 템플릿

```md
Auto-update complete.

## Version
- current: ...
- latest: ...
- update needed: yes/no

## Changelog
- v...
  - impact: ...
  - action: ...

## Impact scan
- extensions/package.json
- extensions/...

## Dependency updates
- ...

## Code changes
- ...

## Validation
- `cd extensions && pnpm run typecheck` → ...
- `cd extensions && pnpm run test` → ...

## Visualization
- widget: shown/not shown
- summary: version flow, impact categories, changed files, validation state

## Follow-ups
- ...
```
