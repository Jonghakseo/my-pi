---
name: pi-auto-update
description: "Pi 버전 및 SDK 의존성 업데이트, 공식 CHANGELOG 기반 호환성 분석, 저장소별 Pi 의존성 소유자 탐색, 업스트림 기능으로 대체·삭제·단순화 가능한 코드 검토, 검증과 시각화에 사용한다."
disable-model-invocation: false
---

# pi-auto-update

`$ARGUMENTS`가 없으면 **현재 레포 기준 Pi 업데이트 작업**으로 간주한다.

목표는 아래 8단계를 순서대로 수행하는 것이다.

1. `pi -v`로 현재 설치 버전과 설치 가능한 최신 버전 확인
2. 공식 CHANGELOG에서 현재 버전과 적용 버전 사이 변경 확인
3. 저장소의 Pi 의존성 소유자, extension source, repo-local upgrade 문서 발견
4. CHANGELOG를 코드 사용처에 매핑하고 대체·삭제·단순화 가능한 구현 검토
5. 발견한 owner manifest의 Pi 관련 의존성을 같은 릴리즈 계열로 업데이트
6. 필요한 호환 수정과 근거가 충분한 코드 개선 적용
7. repo-native 검증 절차로 typecheck, test, build, smoke 확인
8. 업데이트 및 코드 개선 내역 시각화와 최종 보고

---

## 핵심 원칙

- `extensions/`는 우선 확인 대상이지 필수 구조가 아니다. 존재하지 않으면 실제 Pi dependency owner를 발견한다.
- 저장소의 `AGENTS.md`, runbook, coupling/upgrade 문서, package scripts가 이 스킬의 generic 명령보다 우선한다.
- CHANGELOG는 버전 호환성 확인뿐 아니라 기존 workaround, compatibility shim, 중복 구현을 줄일 기회로도 검토한다.
- 코드 삭제나 대체는 upstream public contract, 현재 지원 버전 범위, 모든 사용처, 회귀 테스트가 확인된 경우에만 적용한다.
- 줄 수 감소 자체를 목표로 삼지 않는다. 동작 보존과 유지보수 비용 감소가 증명되는 변경만 적용한다.
- dependency bump, 필수 호환 수정, 선택적 코드 개선을 최종 보고에서 분리한다.
- 범위 밖 cleanup을 섞지 않는다.

---

## 출력 원칙

**최종 보고는 반드시 한글로 작성한다.** 섹션 제목, 설명, 조치 내용, 후속 항목, 시각화의 라벨과 문장까지 모두 한글로 쓴다. 버전 문자열, 파일 경로, 패키지명, 명령어, CHANGELOG 원문 인용, 타입·API 이름 같은 고유 식별자는 원문 그대로 둔다.

항상 아래 순서로 보고한다.

1. **버전** - 현재 버전 / 최신 버전 / 저장소 적용 버전 / 업데이트 필요 여부
2. **변경 내역** - 이번 업데이트에서 영향 있는 공식 항목 3~10개
3. **저장소 탐색** - 발견한 Pi dependency owner, extension source, workspace, repo-local upgrade 문서
4. **영향 범위** - 영향받는 파일, 패키지, API, 기능
5. **의존성 업데이트** - 어떤 manifest와 lockfile을 어떻게 바꿨는지
6. **코드 개선 검토** - 유지 / 필수 수정 / 단순화 / 대체 / 삭제 후보와 근거
7. **코드 수정** - 실제 대응한 파일과 이유
8. **검증** - 실행한 typecheck, test, build, smoke 결과
9. **시각화** - 버전 변화, CHANGELOG 영향, 변경 파일, 코드 개선, 검증 결과
10. **후속 확인** - 보류한 개선 후보와 수동 확인 사항

공식 근거가 있으면 반드시 링크를 포함한다.

---

## Step 1. 버전 확인

반드시 먼저 실행한다.

```bash
pi -v
```

출력이 현재 버전과 최신 버전을 모두 명확히 제공하지 않으면 아래로 보조 확인한다.

```bash
npm view @earendil-works/pi-coding-agent version
```

> 과거 패키지 네임스페이스 `@mariozechner/*`는 더 이상 사용하지 않는다. 현재 공식 패키지는 모두 `@earendil-works/*` 네임스페이스다.

저장소의 Pi SDK 버전은 Step 3에서 발견한 모든 owner manifest를 기준으로 별도 기록한다. 전역 Pi CLI 버전과 저장소 SDK 버전을 같은 값이라고 가정하지 않는다.

---

## Step 2. 공식 CHANGELOG 확인

우선 아래 공식 문서를 확인한다.

- `https://github.com/earendil-works/pi/blob/main/packages/coding-agent/CHANGELOG.md`

> 예전 위치(`badlogic/pi-mono`, `earendil-works/pi-mono`)는 모두 `earendil-works/pi`로 이전되었다.

가능하면 문서 fetch 도구를 사용하고, 실패하면 웹 검색, 브라우저, CLI 순으로 확인한다.

### 확인 범위

- 현재 전역 Pi 버전과 최신 버전 사이 릴리즈
- 저장소 SDK 버전과 적용 버전 사이 릴리즈
- extension API 변경
- command, skill, prompt, theme 변경
- 타입, import 경로, tool schema, event shape 변경
- TUI, SDK, RPC, provider, model runtime 동작 변경
- deprecated, removed, renamed 항목
- upstream에서 새로 제공하는 public API나 built-in 기능
- 버그 수정으로 더 이상 필요 없을 수 있는 local workaround

### 요약 형식

```md
- vX.Y.Z - {공식 변경 요약}
  - 영향 후보: {우리 코드의 API/기능/파일}
  - 대응: {없음 / 버전만 / 필수 수정 / 개선 검토}
```

CHANGELOG 제목만 보고 결론 내리지 않는다. 대체나 삭제를 검토할 때는 연결된 공식 문서, public type/export, PR 설명 중 가능한 근거를 추가 확인한다.

---

## Step 3. Pi 의존성 소유자와 repo-native 절차 발견

### 3-1. 프로젝트 규칙과 upgrade 문서 확인

파일을 수정하기 전에 현재 cwd에서 git root까지 적용되는 `AGENTS.md`를 읽는다. 이후 `runbook/`, `docs/`, package 문서에서 Pi upgrade 절차를 좁게 검색한다.

검색 키워드 예시:

```text
pi upgrade
pi bump
pi coupling
pi contract
upgrade checklist
@earendil-works/pi-coding-agent
```

발견한 repo-local checklist가 있으면 다음 단계의 install, test, build, smoke 명령에 우선 적용한다.

### 3-2. 모든 dependency owner manifest 발견

`node_modules`, `.git`, build/dist 산출물을 제외하고 모든 `package.json`을 찾는다.

```bash
find . \
  \( -path '*/node_modules' -o -path '*/.git' -o -path '*/build' -o -path '*/dist' \) -prune \
  -o -name package.json -type f -print
```

발견한 manifest에서 아래 패키지를 모두 검색한다.

- `@earendil-works/pi-coding-agent`
- `@earendil-works/pi-agent-core`
- `@earendil-works/pi-ai`
- `@earendil-works/pi-tui`

함께 확인할 위치:

- `dependencies`
- `devDependencies`
- `peerDependencies`
- `optionalDependencies`
- workspace catalog 또는 override/resolution 설정
- 루트와 하위 package의 manifest

과거 `@mariozechner/pi-*`가 남아 있으면 namespace migration 대상으로 분류한다.

### 3-3. Workspace와 package manager 결정

각 owner manifest에 대해 아래를 확인한다.

- 가장 가까운 `packageManager` 선언
- `pnpm-lock.yaml`, `package-lock.json`, `yarn.lock`, `bun.lock`, `bun.lockb`
- workspace root와 importer 위치
- 기존 install/update script

install cwd는 감지된 workspace root와 package manager를 기준으로 정한다. 존재하지 않는 `cd extensions` 같은 경로를 실행하지 않는다.

### 3-4. Manifest 없는 extension source 포함

`extensions/`, `pi-extensions/`, `.pi/extensions/`처럼 자체 `package.json`이 없는 extension source도 코드 영향 범위에 포함한다.

저장소 전체에서 아래를 검색하되 generated/vendor 디렉터리는 제외한다.

- `import type { ExtensionAPI`
- `pi.registerCommand(`
- `pi.registerTool(`
- `pi.registerProvider(`
- `pi.registerFlag(`
- `pi.on(`
- `pi.sendMessage(`
- `pi.sendUserMessage(`
- `@earendil-works/pi-coding-agent`
- `@earendil-works/pi-tui`
- `@earendil-works/pi-ai`

`extensions/`가 없다는 이유로 영향 분석을 종료하지 않는다. 실제 owner manifest와 source usage를 최종 보고의 저장소 탐색 섹션에 기록한다.

---

## Step 4. CHANGELOG 영향과 코드 개선 기회 매핑

CHANGELOG의 각 의미 있는 항목을 실제 코드와 연결한다.

```md
- 변경점: {공식 changelog/API 내용}
- 현재 구현: {파일, symbol, local behavior}
- 분류: {유지 / 버전만 / 필수 수정 / 단순화 후보 / 대체 후보 / 삭제 후보 / 수동 확인}
- 근거: {공식 문서, public type/export, 현재 지원 버전, 테스트}
- 조치: {이번에 적용 / 보류 / 영향 없음}
```

### 4-1. 필수 호환성 확인

- 타입 이름과 시그니처 변경
- deprecated 또는 removed API
- import/export 경로 변경
- command, prompt, skill 처리 순서 변경
- event payload와 tool result shape 변경
- provider/model runtime 계약 변경
- TUI component 계약 변경

### 4-2. 코드 감소와 대체 가능성 확인

아래 구현을 우선 검토한다.

- upstream 버그 수정 때문에 더 이상 필요 없을 수 있는 workaround
- 새 public API가 대체할 수 있는 private/deep import 또는 structural cast
- built-in 기능이 대체할 수 있는 local helper나 duplicate adapter
- 버전 feature detection, capability sniff, fallback branch
- `compat`, `workaround`, `temporary`, `remove when`, `TODO` 주석이 붙은 코드
- upstream type/export가 대신할 수 있는 local interface/type alias
- 제거된 구버전 지원만을 위한 dependency, config, test fixture
- 동일 event/schema를 중복 정규화하는 코드

### 4-3. 개선 적용 게이트

다음을 모두 만족할 때만 단순화, 대체, 삭제를 이번 업데이트에 포함한다.

1. 공식 문서나 설치된 public type/export가 대체 계약을 증명한다.
2. 저장소의 최소 지원 Pi 버전과 `peerDependencies`가 기존 fallback 제거를 허용한다.
3. 관련 사용처를 모두 찾았다.
4. 삭제 전 동작을 보호하는 characterization 또는 contract test가 있다. 없으면 먼저 추가한다.
5. 사용자 노출 동작과 protocol contract가 유지된다.
6. repo-local upgrade 문서나 architecture rule과 충돌하지 않는다.

하나라도 불명확하면 코드를 지우지 말고 `보류한 개선 후보`로 보고한다.

### 4-4. 검토 원칙

- 코드가 많다는 이유만으로 삭제하지 않는다.
- 최신 버전만 보고 이전 지원 범위를 암묵적으로 좁히지 않는다.
- upstream changelog 근거 없는 추측성 refactor를 하지 않는다.
- compatibility fix와 optional cleanup을 같은 이유로 묶지 않는다.
- 개선 기회가 없으면 `검토 결과 없음`이라고 명시한다.

---

## Step 5. 의존성 업데이트

### 5-1. 업데이트 원칙

- Step 3에서 발견한 모든 direct Pi package를 같은 릴리즈 계열로 맞춘다.
- manifest가 여러 개면 owner별 version policy와 workspace catalog를 확인한다.
- `latest`를 쓰는 곳이 있더라도 확인한 최신 버전으로 명시적으로 맞추는 것을 우선 검토한다.
- `peerDependencies`는 실제 호환성 정책이 바뀌지 않으면 함부로 좁히지 않는다.
- generated package copy나 packaged artifact의 manifest를 source of truth로 수정하지 않는다.
- 범위 밖 dependency는 함께 올리지 않는다.

### 5-2. 설치

감지한 package manager와 workspace root에서 native install/update 명령을 실행한다.

예시:

```bash
# pnpm workspace 예시
pnpm --dir <workspace-root> install

# owner package에서 명시적으로 버전을 바꾸는 예시
cd <owner-dir> && pnpm add --save-exact \
  @earendil-works/pi-ai@<version> \
  @earendil-works/pi-coding-agent@<version> \
  @earendil-works/pi-tui@<version>
```

예시는 감지 결과에 맞게 바꾼다. package manager를 임의로 교체하지 않는다.

manifest와 lockfile diff를 확인하고, Pi update 때문에 사라지거나 추가된 transitive dependency를 구분해 기록한다.

---

## Step 6. 대응 코드와 근거 있는 개선 적용

순서는 아래를 따른다.

1. 필수 compatibility fix
2. 새 타입 오류나 contract test 실패 대응
3. Step 4 게이트를 통과한 단순화, 대체, 삭제
4. 관련 테스트와 upgrade note 갱신

예시:

- renamed type/signature 대응
- deprecated public API 교체
- private/deep import를 새 public export로 교체
- upstream fix로 불필요해진 workaround와 전용 테스트 제거
- local interface를 upstream exported type으로 대체
- 중복 capability branch를 public method 한 경로로 통합
- repo-local coupling/upgrade 문서에 버전 판단 기록

### 수정 원칙

- 한 변경은 한 이유로 묶는다.
- dependency update, 필수 수정, optional improvement를 diff와 보고에서 구분한다.
- 삭제한 symbol과 대체한 upstream API를 명시한다.
- fallback 제거 시 최소 지원 버전 근거를 남긴다.
- 사용자 노출 계약을 의도 없이 바꾸지 않는다.
- 개선 후보가 안전하지 않으면 적용하지 않고 후속 확인으로 남긴다.

---

## Step 7. 검증

검증 우선순위는 다음과 같다.

1. repo-local Pi bump checklist 또는 runbook
2. 변경 전후 contract/characterization test
3. 감지한 owner package의 `typecheck`, targeted test, full test, build
4. repository 전체 build 또는 package smoke
5. 최종 diff 검사

package scripts는 먼저 확인하고 실제 존재하는 명령만 실행한다.

```bash
cd <owner-dir> && <package-manager> run typecheck
cd <owner-dir> && <package-manager> run test
cd <owner-dir> && <package-manager> run build
git diff --check
```

필요하면 아래를 추가한다.

- Pi contract test
- extension load smoke
- package/app build
- protocol fixture test
- 변경한 workaround 또는 adapter의 회귀 테스트
- `pi -v`와 설치된 SDK package version 재확인

### 검증 기준

- 새 타입 오류가 없어야 한다.
- 새 테스트 실패가 없어야 한다.
- CHANGELOG 대응 범위 밖 회귀를 만들지 않아야 한다.
- 삭제·대체한 코드의 이전 동작이 테스트로 보존되어야 한다.
- repo-local 수동 smoke가 필요하지만 앱 재시작이나 외부 쓰기가 금지되어 있으면 실행하지 않고 후속 확인에 남긴다.
- 검증하지 못한 항목이 있으면 `업데이트 완료` 대신 부분 완료로 보고한다.

---

## Step 8. 업데이트 내역 시각화

최종 응답 전, 시각화 도구를 사용할 수 있으면 반드시 `show_widget`으로 결과를 보여준다.

첫 `show_widget` 호출 전에는 내부 준비 단계로 `visualize_read_me`를 한 번 호출한다.

### 시각화에 반드시 포함할 내용

- 버전 변화: 현재 버전 → 최신/적용 버전, 업데이트 필요 여부
- CHANGELOG 핵심 항목: provider, API, runtime, security, UI 등 영향 카테고리
- 저장소 탐색: 실제 Pi owner manifest, extension source, workspace, upgrade 문서
- 영향 스캔: 영향받은 package, 기능, 코드 수정 필요 여부
- dependency update: 변경된 manifest, lockfile, Pi package version
- 코드 개선 검토: 유지, 필수 수정, 단순화, 대체, 삭제, 보류 개수와 대표 symbol
- validation: typecheck, test, build, smoke 성공·실패와 테스트 개수
- follow-up: 수동 확인과 보류한 개선 후보

### 권장 구성

- 상단 metric cards: 버전, owner 수, 변경 package 수, 코드 개선 수, 검증 상태
- 중간 flow: Version → Changelog → Discovery → Impact → Update → Improve → Validation
- 하단 detail cards: CHANGELOG별 영향, 실제 변경 파일, 코드 개선 분류, 검증 결과

시각화의 카드 제목, 라벨, 설명도 한글로 작성한다. 버전값, 파일 경로, package, API 이름만 원문을 유지한다.

시각화는 보조 산출물이다. 최종 텍스트 보고도 출력 원칙 순서대로 반드시 제공한다.

---

## 체크리스트

작업 종료 전 반드시 확인한다.

- [ ] `pi -v` 결과와 최신 release를 기록했는가
- [ ] 전역 Pi 버전과 저장소 SDK 버전을 구분했는가
- [ ] CHANGELOG에서 현재 버전과 적용 버전 사이 릴리즈를 모두 확인했는가
- [ ] `AGENTS.md`와 repo-local Pi upgrade/coupling 문서를 확인했는가
- [ ] 특정 `extensions/` 구조를 가정하지 않고 모든 Pi owner manifest를 발견했는가
- [ ] manifest 없는 extension source와 API 사용처도 확인했는가
- [ ] workspace root, package manager, source-of-truth manifest를 확인했는가
- [ ] CHANGELOG마다 코드 영향과 조치를 매핑했는가
- [ ] 대체·삭제·단순화 가능한 workaround, shim, duplicate implementation을 검토했는가
- [ ] optional improvement에 공식 근거, 버전 정책, 전체 사용처, 보호 테스트가 있는가
- [ ] dependency update와 코드 개선을 분리해서 설명했는가
- [ ] repo-native typecheck, test, build를 실행했는가
- [ ] 삭제·대체한 코드의 동작을 회귀 테스트로 검증했는가
- [ ] `git diff --check`와 최종 diff를 검토했는가
- [ ] 업데이트 내역 시각화를 제공했는가
- [ ] 보류한 개선 후보와 수동 확인 항목을 적었는가
- [ ] 최종 보고와 시각화 문구를 한글로 작성했는가

---

## 금지 사항

- CHANGELOG를 읽지 않고 버전만 올리기
- `extensions/`가 없다는 이유로 저장소 Pi 영향 분석을 생략하기
- generated artifact의 manifest를 source of truth로 수정하기
- workspace와 package manager를 확인하지 않고 install 명령을 추측하기
- repo-local upgrade checklist를 무시하고 generic test만 실행하기
- 새 upstream 기능이 있다는 이유만으로 local fallback을 즉시 삭제하기
- 현재 지원 Pi 버전 범위를 확인하지 않고 compatibility code 제거하기
- characterization/contract test 없이 workaround나 adapter 삭제하기
- 코드 줄 수 감소를 성과로 삼아 범위 밖 refactor 섞기
- 검증 없이 `업데이트 완료`라고 말하기
- 시각화 도구가 사용 가능한데도 결과 시각화를 생략하기
- 최종 보고를 영어로 작성하기

---

## 최종 응답 템플릿

```md
자동 업데이트를 완료했습니다.

## 버전
- 전역 Pi: ...
- 저장소 SDK: ...
- 최신: ...
- 업데이트 필요: 예/아니오

## 변경 내역
- vX.Y.Z - ...
  - 영향: ...
  - 조치: ...

## 저장소 탐색
- dependency owner: ...
- extension source: ...
- workspace/package manager: ...
- repo-local upgrade 문서: ...

## 영향 범위
- ...

## 의존성 업데이트
- ...

## 코드 개선 검토
- 유지: ...
- 필수 수정: ...
- 단순화/대체/삭제 적용: ...
- 보류: ...

## 코드 수정
- ...

## 검증
- `<실제 명령>` → ...

## 시각화
- 위젯: 표시함/표시하지 않음
- 요약: 버전, owner, 영향, dependency, 코드 개선, 검증 상태

## 후속 확인
- ...
```
