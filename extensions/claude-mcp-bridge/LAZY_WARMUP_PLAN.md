# Claude MCP Bridge Lazy Warmup 구현 계획

> 목표: **세션 시작을 지연시키지 않으면서**, `mcp_<server>_<tool>` 직접 도구 surface는 유지하고, 서버 연결은 **백그라운드에서 최대한 빠르게** warmup한다.
>
> 핵심 원칙:
> 1. 시작 시점에는 **캐시된 tool metadata로만 등록**한다.
> 2. 서버 연결은 **비동기 warmup**으로 수행한다.
> 3. 실제 실행 시에는 기존 `ensureConnected()` 경로로 **on-demand 연결**을 보장한다.
> 4. 세션 중 새 도구/스키마 변경은 **캐시만 갱신**하고, 반영은 다음 `/reload`에서 한다.

---

## 레퍼런스

### 공식 문서
- MCP Lifecycle — initialization은 연결 후 첫 상호작용이어야 하며, 그 후 operation 단계에서 `tools/list`, `tools/call` 등을 수행한다.
  - https://modelcontextprotocol.io/specification/latest/basic/lifecycle
- MCP TypeScript SDK — `Client`는 `listTools`, `callTool`, `listResources`, `readResource` 등의 helper를 제공한다.
  - https://ts.sdk.modelcontextprotocol.io/

### 현재 구현
- 엔트리포인트: `extensions/claude-mcp-bridge/index.ts`
- 현재 startup 경로:
  - `loadConfig()`
  - `manager.replaceServers(...)`
  - `manager.connectAll()`
  - `registerDiscoveredTools()`
- 현재 장점:
  - `McpConnection.connect()`는 concurrent connect를 dedupe함 (`connectingPromise`)
  - `ensureConnected()`가 on-demand reconnect를 이미 지원함

---

## 현재 문제

현재 구현은 extension load 시점에 **모든 MCP 서버에 eager connect**한다.

이 방식의 단점:
- 세션 시작이 MCP 서버 상태/속도에 영향을 받음
- 서버 수가 많을수록 startup 비용이 커짐
- 느리거나 불안정한 서버가 전체 시작 경험을 악화시킴

하지만 direct tool UX (`mcp_<server>_<tool>`)는 유지하고 싶다. 이 UX를 유지하려면 startup 시점에 최소한 **tool 이름 + description + input schema**는 확보되어 있어야 한다.

따라서 해법은:
- **live discovery 결과를 캐시**하고
- 다음 세션에서는 **캐시로 먼저 tool 등록**하고
- 연결은 별도로 **background warmup**하는 것이다.

---

## 목표 / 비목표

## 목표
- 세션 시작 경로에서 `await manager.connectAll()` 제거
- 캐시된 metadata가 있으면 direct MCP tools를 즉시 등록
- warmup은 background에서 bounded concurrency로 수행
- tool 실행 시 서버가 아직 미연결이어도 정상 동작 (`ensureConnected()` 경유)
- warmup 결과로 cache 최신화
- 새 tool / schema drift 감지 시 사용자에게 `/reload` 필요를 알림

## 비목표
- 이번 단계에서 전체 `claude-mcp-bridge`를 대규모 모듈 분해하지 않음
- 세션 도중 새 direct tool을 즉시 agent tool registry에 반영하려고 시도하지 않음
- resource/listResources/readResource 지원 확장은 이번 범위에 포함하지 않음
- consent/auth 모델 재설계는 이번 범위에 포함하지 않음

---

## 설계 요약

### 시작 시점
1. config load
2. tool visibility settings load
3. metadata cache load
4. cache 기준으로 direct MCP tools 등록
5. shared warmup/UI state 초기화
6. **await 없이** background warmup kickoff

### UI context handshake
현재 구현의 footer/status 갱신과 notify는 `ExtensionContext`가 필요하므로, module load 시점에는 직접 호출하지 않는다. 대신:

- startup에서는 warmup/state store만 초기화한다
- 첫 `session_start`에서 UI-capable `ctx`를 캡처하고 현재 상태를 한 번 반영한다
- 이후 warmup 완료/오류/drift 이벤트는 캡처된 `ctx`가 있을 때만 `setStatus`/`notify`를 호출한다
- `ctx`가 아직 없으면 이벤트는 state에만 기록되고, 다음 `session_start` 또는 status 명령에서 반영한다

### background warmup
- 각 서버에 대해 `connect()` 수행
- `connect()` 내부에서 이미 `refreshTools()`가 실행되므로, warmup은 추가 `listTools()`를 호출하지 않고 `conn.tools`를 snapshot한다
- 병렬수 제한(권장: 3~4)
- 성공 시:
  - connection state 갱신
  - live metadata로 cache 갱신
  - drift 여부 기록
- 실패 시:
  - 상태만 갱신
  - startup은 그대로 유지

### tool 실행 시
- 해당 서버가 이미 연결됨 → 즉시 실행
- 해당 서버가 warmup 중 → 그 connect promise에 합류
- 아직 미연결 → `ensureConnected()`로 연결 후 실행

### 세션 중 drift 처리
- 새 tool 추가 / description 변경 / schema 변경을 감지하면:
  - cache 저장
  - 현재 세션 registry는 유지
  - UI-capable `ctx`가 있으면 `ctx.ui.notify("MCP metadata updated. Run /reload to expose new or changed tools.")`
  - `ctx`가 없으면 drift flag만 기록하고 이후 `session_start` 또는 `/mcp-status`에서 안내한다

이유:
현재 구현 코멘트상 direct tool 등록은 extension load 시점에 이뤄져야 tool registry에 안정적으로 반영된다. 따라서 세션 도중 registry를 바꾸는 대신, **다음 `/reload` 반영**을 기준으로 한다.

### 공용 tool catalog
현재 구현의 `getAllTools()`는 connected 서버의 도구만 반환하므로, cache 기반 startup registration에는 그대로 사용할 수 없다. 따라서 이번 변경에서는 `getAllTools()`의 contract를 직접 바꾸기보다, 아래 정보를 합친 **공용 tool catalog**를 별도로 둔다.

- live discovered tools (`conn.tools`)
- cache metadata tools
- disabled tool visibility settings

이 catalog를 registration, `/mcp-status`, disabled-tool pruning, disabled-count 계산의 공통 source of truth로 사용한다.

---

## 데이터 모델

### 캐시 파일
경로:
- `~/.pi/agent/claude-mcp-bridge-cache.json`

캐시는 글로벌 파일 1개를 쓰되, **현재 로드된 config 범위별 bucket**으로 namespacing한다. bucket key(`configScopeKey`)는 현재 `loadConfig(cwd)`가 선택한 source path 집합과 서버 정의 집합을 기준으로 계산한다.

예상 구조:

```json
{
  "version": 1,
  "profiles": {
    "<configScopeKey>": {
      "configHash": "...",
      "servers": {
        "jira": {
          "savedAt": 1770000000000,
          "serverHash": "...",
          "tools": [
            {
              "name": "search",
              "description": "Search issues",
              "inputSchema": { "type": "object", "properties": {} }
            }
          ]
        }
      }
    }
  }
}
```

### 해시 전략
- `configHash`: 전체 config 기준
- `serverHash`: 서버별 config 기준
- 해시는 **persisted MCP config를 env-expanded 한 결과**를 기준으로 계산한다
  - 포함 예: `enabled`, `command`/`url`, `args`, `cwd`, config 파일에 명시된 `env`, `headers`에 대해 `${VAR}` 치환까지 반영한 값
  - 제외 예: stdio normalize 단계에서 추가로 합쳐지는 전체 `process.env`, transient/debug 성격 필드
- 이유: 현재 구현은 stdio normalize 단계에서 `process.env` 전체를 합치므로, 그 결과 객체를 그대로 hash input으로 쓰면 launch마다 cache invalidation이 과도해질 수 있다. 반대로 env-expanded persisted fields를 전혀 반영하지 않으면 endpoint/auth context 변경을 놓칠 수 있다.

### TTL / 호환성 규칙
- 초기 권장 TTL: **7일**
- startup registration에 사용하는 cache entry는 아래를 모두 만족해야 한다
  - 현재 로드된 config 범위의 `configScopeKey` bucket에 속함
  - 현재 config에 동일 서버명이 존재함
  - 현재 서버 정의와 `serverHash`가 일치함
- 분류:
  - `TTL stale`: `serverHash`는 같지만 `savedAt`만 오래됨 → startup registration 허용
  - `hash mismatch`: 현재 서버 정의와 다름 → startup registration 불가 (cache miss로 취급)
  - `server removed/renamed/disabled`: startup registration 불가
- 허용된 TTL stale entry는 UI에 `cached` 상태를 표시하고 warmup에서 최대한 빨리 갱신한다

---

## 주요 설계 결정

### 1. startup register는 cache 기반 only
직접 도구 등록은 startup latency에서 분리해야 하므로, 등록 단계는 네트워크/프로세스 spawn에 의존하지 않는다.

### 2. warmup은 fire-and-forget + bounded concurrency
무제한 병렬 connect는 오히려 CPU / 프로세스 spawn / 네트워크 병목을 만든다. 권장 병렬수는 3~4.

### 3. warmup 실패는 비치명적
warmup은 UX 최적화 계층이다. 실패해도 세션 시작과 tool 실행 가능성은 유지되어야 한다.

### 3-1. 마지막 정상 cache는 discovery 실패로 덮어쓰지 않는다
현재 `connect()` 내부의 `refreshTools()`는 discovery 실패 시 `conn.tools = []`로 떨어질 수 있으므로, warmup은 `connected + tools snapshot`만으로 cache overwrite를 결정하지 않는다. 이번 계획에서는 아래처럼 구분한다.

- `connect failed` → cache 유지, error state 기록
- `connect succeeded + tools discovery verified` → cache 갱신 가능
- `connect succeeded but tools discovery failed/ambiguous` → **기존 마지막 정상 cache 유지**, warning state만 기록

즉, 빈 tool list가 실제 서버의 정상 응답인지, discovery 실패의 부산물인지 구분하기 전에는 cache를 빈 배열로 덮어쓰지 않는다.

### 4. direct tool surface 유지
proxy-only 구조로 바꾸지 않는다. 캐시가 존재하는 한 기존 `mcp_<server>_<tool>` UX를 유지한다.

### 5. runtime drift는 next reload 반영
세션 중 새 direct tool 즉시 등록은 시도하지 않는다. 현재 세션에서는 캐시 기반 registry를 유지하고, warmup은 다음 세션 품질을 높이는 역할에 집중한다.

### 6. warmup 결과 반영에는 generation guard가 필요
fire-and-forget warmup은 `/reload`나 session shutdown과 경합할 수 있으므로, 시작 시 generation을 캡처하고 완료 시점에 동일 generation일 때만 state/cache/notify를 반영한다.

또한 generation이 바뀐 뒤 늦게 끝난 warmup은 결과를 적용하지 않을 뿐 아니라, 완료 직후 stale connection reference가 남아 있으면 best-effort `disconnect()`로 정리한다. `connect()` 자체를 취소하지는 못하더라도, old generation이 새 runtime을 오염시키지 않는 것이 목표다.

---

## 상태 모델

현재 코드의 low-level `ServerStatus` type은 `connecting | connected | disconnected | error`이므로, 이번 변경에서는 이를 바로 대체하지 않고 **UI/registry용 파생 상태**를 별도로 둔다.

각 서버의 파생 상태 예:

- `cached_only` — cache metadata만 있고 아직 live connect 없음
- `warming` — background warmup 진행 중
- `connected` — live connected
- `error` — warmup/connect 실패
- `disabled` — **tool visibility 기준으로** 비활성

주의: config-level `enabled: false` 서버는 현재 구현에서 `normalizeServer()` 단계에서 제외되므로, 파생 상태 `disabled`는 주로 tool visibility 관점의 상태를 의미한다.

footer는 기존 `MCP connected/total` 형식을 유지하되, `/mcp-status` summary에는 `cached` / `warming` 표시를 추가하는 방향을 권장한다.

예시:
- `jira = warming (cached 12 tools)`
- `slack = connected (18 tools)`
- `figma = error (cached)`

---

## 파일 변경 계획

## 수정
- `extensions/claude-mcp-bridge/index.ts`
  - eager startup 제거
  - cache load/save 통합
  - background warmup kickoff
  - warmup 상태/알림 처리
  - cached metadata 기반 tool registration

## 생성
- `extensions/claude-mcp-bridge/metadata-cache.ts`
  - cache schema
  - load/save/validate/hash compare helpers
- `extensions/claude-mcp-bridge/warmup.ts`
  - bounded concurrency scheduler
  - per-server warmup orchestration
  - drift detection helper

## 테스트
- `extensions/utils/claude-mcp-bridge-cache.test.ts`
- `extensions/utils/claude-mcp-bridge-warmup.test.ts`
- `extensions/utils/claude-mcp-bridge-lazy-startup.test.ts`

> 메모: 이번 단계에서는 overlay UI 전체를 분리하지 않는다. 테스트 가능한 순수 로직만 helper module로 추출한다.

---

## 단계별 작업 계획

## Task 1: metadata cache 도입

**파일**
- 생성: `extensions/claude-mcp-bridge/metadata-cache.ts`
- 테스트: `extensions/utils/claude-mcp-bridge-cache.test.ts`

**구현 내용**
- cache type 정의
- cache file 경로 상수 정의
- load / save / validate
- config/server hash helper
- `configScopeKey` bucket 설계
- cache hit / TTL stale / incompatible / invalid 판정

**완료 기준**
- 유효한 cache는 tool metadata를 복원한다
- 손상된 cache는 조용히 무시하고 empty 처리한다
- `serverHash` mismatch는 startup registration 불가(`incompatible`)로 판정된다

---

## Task 2: startup 경로를 non-blocking으로 전환

**파일**
- 수정: `extensions/claude-mcp-bridge/index.ts`
- 테스트: `extensions/utils/claude-mcp-bridge-lazy-startup.test.ts`

**구현 내용**
- 기존 `loadAndConnect()`를 startup blocking 경로에서 제거하고 다음 두 단계로 분리
  - `loadAndRegisterFromCache()`
  - `startBackgroundWarmup()`
- extension load 시점에는:
  - config load
  - manager.replaceServers(...)
  - cache load
  - cached tools register
  - warmup kickoff
- `await manager.connectAll()` 제거
- `/reload` 이후에도 동일한 non-blocking startup 경로가 다시 실행되도록 정리

**완료 기준**
- startup path가 live connect completion을 기다리지 않는다
- cache가 있으면 direct tools가 즉시 등록된다
- cache가 없더라도 extension load 자체는 빠르게 끝난다

---

## Task 3: background warmup scheduler 구현

**파일**
- 생성: `extensions/claude-mcp-bridge/warmup.ts`
- 수정: `extensions/claude-mcp-bridge/index.ts`
- 테스트: `extensions/utils/claude-mcp-bridge-warmup.test.ts`

**구현 내용**
- bounded concurrency runner (`maxConcurrency = 3` 기본값)
- per-server warmup:
  - `await conn.connect()`
  - `conn.status === "connected"`이면 `conn.tools` snapshot과 discovery 성공 여부를 함께 평가
  - `conn.status !== "connected"`이면 `conn.error`를 기록하고 종료
  - discovery 실패/모호 상태에서는 기존 cache를 유지하고 warning만 기록
- 실패 시 error state 기록
- 진행 중 중복 warmup 방지
- 시작 generation을 캡처하고 완료 시 동일 generation일 때만 state/cache/notify 반영
- old generation warmup이 늦게 끝나면 best-effort disconnect 수행
- cache 저장은 per-task 저장이 아니라 **warmup round 종료 시 1회 flush**를 기본 전략으로 한다
- flush 시에는 최신 파일을 다시 읽어 다른 scope bucket은 보존하고, 현재 `configScopeKey` bucket만 교체한 뒤 temp-file + rename으로 atomic write 한다

**완료 기준**
- warmup은 fire-and-forget로 시작된다
- 같은 서버에 대해 connect 중복 spawn이 없다
- 일부 서버 실패가 전체 warmup을 중단시키지 않는다

---

## Task 4: cached metadata 기반 registration 보강

**파일**
- 수정: `extensions/claude-mcp-bridge/index.ts`

**구현 내용**
- live/cached/disabled 상태를 합친 **shared tool catalog** helper를 도입
- `registerDiscoveredTools()`는 이 catalog를 입력으로 받아 direct tool registration을 수행하도록 변경
- `/mcp-status`, `notifyStatusSummary()`, Tools overlay, disabled-count 계산, `removeDisabledToolsFromActiveSet()`도 같은 catalog를 사용하도록 정리
- disabled tool filtering은 동일하게 유지
- tool 이름 생성 규칙 `mcp_<server>_<tool>` 유지
- cached metadata로 등록된 도구는 details/diagnostics에 `cachedSchema: true` 정도의 내부 표식 추가 고려

**완료 기준**
- live connect 전에도 cached tools가 direct tool로 노출된다
- 기존 tool visibility 설정과 충돌하지 않는다

---

## Task 5: execute 경로 hardening

**파일**
- 수정: `extensions/claude-mcp-bridge/index.ts`

**구현 내용**
- tool execute 시점에 해당 서버가 미연결이면 `ensureConnected()` 경유
- warmup과 foreground execute가 동시에 와도 동일 connect promise를 공유
- live connect 후 `conn.tools`에서 해당 tool 존재를 먼저 확인하고, 없으면 MCP SDK 호출 전에 명확한 에러를 반환
  - 예: `MCP tool no longer exists on server. Run /reload to refresh tool registry.`
- SDK가 server-side validation 에러를 반환하는 경우에는 기존 MCP error 포맷을 유지한다

**완료 기준**
- warmup 도중 사용자가 먼저 도구를 호출해도 정상 동작
- stale cache 때문에 tool이 사라진 경우 에러가 이해 가능하다

---

## Task 6: status / notify UX 업데이트

**파일**
- 수정: `extensions/claude-mcp-bridge/index.ts`

**구현 내용**
- `/mcp-status` summary에 `cached` / `warming` 상태 반영
- Tools overlay도 live-only 목록이 아니라 shared tool catalog를 기준으로 표시
- `session_start`에서 캡처한 UI context를 사용해 footer/status를 최초 반영하고, warmup 완료 시점에 안전하게 갱신
- warmup으로 새 tool 또는 schema drift 감지 시 1회 알림
- 알림 문구 예시:
  - `MCP metadata updated. Run /reload to expose new or changed tools.`
- startup 직후 footer는 기존과 동일하게 `MCP connected/total` 유지

**완료 기준**
- 유저가 현재 상태를 혼동하지 않는다
- 자동 reload는 하지 않는다

---

## 테스트 계획

## 단위 테스트
- cache file parse / invalid fallback
- server hash mismatch 처리
- TTL stale vs incompatible cache 판정
- warmup bounded concurrency
- warmup partial failure isolation
- discovery 실패 시 last-good cache 유지
- cached metadata → tool definition 변환
- drift detection (new tool / removed tool / schema changed)
- reload/shutdown 중 old generation warmup 결과 무시 및 정리

## 통합 성격 테스트
- startup이 connect promise를 기다리지 않는지 검증
- cached tool 등록 후 실행 시 on-demand connect 되는지 검증
- warmup 완료 후 cache가 저장되는지 검증
- discovery 실패 시 cache가 빈 배열로 덮어써지지 않는지 검증
- env-expanded persisted field 변경 시 old cache가 startup registration에 쓰이지 않는지 검증
- stale tool execute 시 reload 안내 에러가 나는지 검증

## 수동 검증
`cd extensions && pnpm run test`

추가 수동 시나리오:
1. 정상 cache 존재 + 서버 느림 → session startup이 즉시 끝나는지
2. cache 없음 + 서버 느림 → startup은 빠르고 direct tools는 적거나 없는지
3. warmup 후 `/reload` 시 새 tool이 보이는지
4. disabled tools 설정이 cache/live 양쪽 모두에 동일 적용되는지

---

## 롤아웃 / 운영 전략

### 1단계
- feature flag 없이 내부 구현만 전환
- 문제가 있으면 eager connect로 쉽게 rollback 가능하도록 기존 경로 유지

### 2단계
- 실제 사용자 환경에서 startup latency 체감 확인
- 필요하면 warmup concurrency 조정

### 3단계 (선택)
- server별 `lazy/eager` 정책 추가
- 자주 쓰는 서버는 eager warmup 우선순위 부여

---

## 리스크와 대응

### 리스크 1: stale schema로 인한 잘못된 tool args
대응:
- server-side validation 에러를 그대로 surface
- drift 감지 시 `/reload` 안내
- cache TTL 및 hash validation 적용

### 리스크 2: cache 없는 첫 실행 UX 저하
대응:
- 첫 실행에는 direct tools가 덜 보일 수 있음을 허용
- `/mcp-status` 및 warmup 후 reload 안내로 보완
- 필요하면 추후 proxy fallback 검토

### 리스크 3: background warmup이 과도한 리소스를 사용
대응:
- bounded concurrency
- connect 실패 backoff 재사용 또는 최소한 즉시 재시도 금지

### 리스크 4: 세션 중 registry 불일치
대응:
- 이번 단계에서는 runtime registry mutation을 하지 않음
- next reload 반영 원칙을 명확히 유지

---

## 최종 결정

이번 구현은 **full lazy direct registration**이 아니라 다음 전략을 채택한다.

- **도구 등록:** cache 기반, startup blocking 없음
- **서버 연결:** background warmup + on-demand fallback
- **metadata 최신화:** warmup에서 수행
- **새/변경 tool 반영:** 다음 `/reload`

이 전략은 현재 `claude-mcp-bridge`의 direct tool UX를 최대한 보존하면서도, 가장 큰 문제인 startup eager connect 비용을 제거한다.

---

## 구현 승인 후 다음 단계

승인되면 아래 순서로 진행한다:
1. `metadata-cache.ts` + 테스트
2. startup non-blocking 전환
3. warmup scheduler 추가
4. execute/status hardening
5. 수동 검증 및 문서 업데이트
