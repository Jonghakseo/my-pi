# 멀티 세션 구현 계획

> 하나의 remote URL에서 여러 pi 세션을 관리하는 기능.
> 웹 UI에서 텔레그램 채팅방처럼 세션 목록 + 터미널 전환.

## 레퍼런스

- 현재 구현: `extensions/remote/` (단일 세션)
- 기존 PLAN: `extensions/remote/PLAN.md`

---

## 현재 구조 vs 목표

```text
현재:  1 remote URL = 1 PTY = 1 pi 세션 (여러 브라우저가 같은 PTY 공유)

목표:  1 remote URL = N개 PTY = N개 pi 세션
       데스크탑: 사이드바(세션 목록) + 터미널
       모바일: 세션 목록 → 터미널 (depth 네비게이션)
```

---

## 아키텍처 변경

### Before (단일 세션)

```text
launcher
  └── HTTP/WS Server
       └── PTY (1개) ← 모든 WS 클라이언트가 공유
```

### After (멀티 세션)

```text
launcher
  └── HTTP/WS Server
       └── SessionManager
            ├── Session "my-proj"  → PTY + OutputBuffer + ViewerState
            ├── Session "api-fix"  → PTY + OutputBuffer + ViewerState
            └── Session "review"   → PTY + OutputBuffer + ViewerState
```

- 기존 `pty.ts`의 모듈-레벨 싱글톤 상태를 **Session 클래스**로 캡슐화
- `ws.ts`의 전역 뷰어 상태(`activeWs`, `clientSizes`, `mobileClients`)도 **Session별 viewer state**로 분리
- WS 메시지에 `sessionId` 필드 추가
- 서버가 여러 PTY를 동시 관리

---

## 서버 변경

### 1. `src/session-manager.ts` (신규)

세션 생명주기를 관리하는 중앙 모듈.

```typescript
interface SessionInfo {
  id: string;
  name: string;             // 수동 설정 또는 클라이언트 xterm title 감지 결과
  state: "running" | "exited";
  exitCode: number | null;
  createdAt: number;
  attachLocal: boolean;
  lastActivity: number;     // 마지막 PTY 출력 timestamp (사이드바 상태 표시용)
}

interface ClientSize {
  cols: number;
  rows: number;
}

class Session {
  readonly id: string;
  readonly cwd: string;
  readonly outputBuffer: OutputBuffer;
  private pty: IPty | null;
  private dataListeners: PtyDataListener[];
  private exitListeners: PtyExitListener[];
  private viewers: Set<WebSocket>;
  private pendingViewers: Set<WebSocket>;
  private activeViewer: WebSocket | null;
  private viewerSizes: Map<WebSocket, ClientSize>;
  private mobileViewers: Set<WebSocket>;
  private stdinDataListener: ((data: Buffer) => void) | null;

  constructor(id: string, options: CreateSessionOptions) { ... }

  write(data: string, viewer: WebSocket): void { ... }
  attachViewer(ws: WebSocket): void { ... }
  activateViewer(ws: WebSocket): void { ... }
  resize(ws: WebSocket, cols: number, rows: number, mobile?: boolean): void { ... }
  detachViewer(ws: WebSocket): void { ... }
  kill(): void { ... }
  getState(): SessionInfo { ... }
  onData(cb: PtyDataListener): () => void { ... }
  onExit(cb: PtyExitListener): () => void { ... }
}

class SessionManager {
  private sessions = new Map<string, Session>();

  /** 새 세션 생성. pi를 PTY 안에서 spawn (`PI_REMOTE_SESSION_ID=session.id` 자동 주입 포함) */
  create(options: CreateSessionOptions): Session { ... }

  /** 세션 조회 */
  get(id: string): Session | undefined { ... }

  /** 세션 종료 */
  kill(id: string): void { ... }

  /** 전체 세션 목록 */
  list(): SessionInfo[] { ... }

  /** 전체 running 세션 수 */
  runningCount(): number { ... }

  /** 모든 세션 종료 (cleanup) */
  killAll(): void { ... }

}
```

**세션 ID**: `crypto.randomUUID().slice(0, 8)` (짧은 랜덤 ID)

**세션 이름**: pi의 session name(`/name`) 또는 purpose(`/purpose`)를 OSC 0 title 변경에서 감지하여 자동 표시.
- `SessionManager.create()`는 세션을 spawn할 때 생성 대상 env에 `PI_REMOTE_SESSION_ID=session.id`를 자동 주입한다
- **active session**은 클라이언트 xterm.js `terminal.onTitleChange(title => ...)`로 title 변경을 감지하고 `session_title { sessionId, title }`를 서버로 보낸다
- **inactive session**은 서버가 `Session.onData`에서 OSC 0 시퀀스를 **비파괴적으로 관찰**해 이름 변경을 best-effort로 감지한다
- 서버 관찰 범위는 `\x1b]0;(.*?)(\x07|\x1b\\)`이며, 완전한 시퀀스만 매칭한다. chunk split으로 잘린 미완성 시퀀스는 무시하고 다음 chunk와 이어 붙여 재조립하지 않는다
- 클라이언트/서버 어느 경로로 감지되든 최종적으로 서버가 `SessionInfo.name`을 갱신하고 `session_updated`를 전체 authenticated WS에 broadcast한다
- 이유: active session은 xterm이 OSC 0 / BEL / ST 변형과 chunk split을 자체 처리해 정확도가 높고, inactive session은 raw data를 클라이언트에 보내지 않으므로 서버의 최소 관찰이 필요하다
- fallback: title 감지 실패 시 `session-1`, `session-2`, ... 순번
- 웹 UI에서 수동 이름 변경은 지원하지 않음 (이름은 pi의 session name/purpose에서 자동 감지)

**생성 시 spawn 옵션**:

```typescript
interface CreateSessionOptions {
  name?: string;
  piPath: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  cols?: number;
  rows?: number;
  attachLocal?: boolean;
}
```

세부 규칙:
- `attachLocal: true` 세션은 동시에 최대 1개만 허용
- `Session.kill()` 시 `detachLocalStdin()`까지 포함해서 로컬 stdin 리스너 정리
- `killAll()`은 `attachLocal: false` 세션들을 먼저 종료하고, `attachLocal: true` 초기 세션을 마지막에 종료
- 초기 세션은 TTL과 원격 kill에 대해서는 다른 세션과 동일하게 취급한다. 단, attachLocal로 인한 로컬 터미널 연결과 `killAll()` 종료 순서는 여전히 특수하다

### 2. `src/pty.ts` 변경

현재 모듈-레벨 싱글톤(`let ptyProcess`, `let dataListeners`, `let exitListeners`, `let stdinDataListener`, `let outputBuffer`)을 **Session 클래스 내부**로 이동.

변경 전:

```typescript
let ptyProcess: IPty | null = null;
let lastExitCode: number | null = null;
let outputBuffer = new OutputBuffer();
let dataListeners: PtyDataListener[] = [];
let exitListeners: PtyExitListener[] = [];
let stdinDataListener: ((data: Buffer) => void) | null = null;
```

변경 후:
- `pty.ts`는 순수 유틸 함수만 남김 (`fixSpawnHelperPermissions` 등)
- PTY 인스턴스 + OutputBuffer + 리스너 + local stdin attachment는 `Session` 클래스가 소유
- 기존 `spawnInPty()`, `writeToPty()`, `resizePty()`, `killPty()` 등은 `Session` 메서드로 이동
- `lastExitCode`도 Session별 상태로 분리
- `OutputBuffer`는 `getFrom(offset)` 외에 `getLastN(maxBytes)`를 제공해 세션 전환용 200KB replay를 효율적으로 잘라낸다

### 3. `src/ws.ts` 변경 — 프로토콜 확장

**기존 메시지에 `sessionId` 추가:**

| 방향 | 타입 | 변경 |
|------|------|------|
| C→S | `input { data, sessionId }` | sessionId 추가 |
| C→S | `resize { cols, rows, sessionId }` | sessionId 추가 |
| C→S | `resume { lastOffset, sessionId }` | sessionId 추가 |
| S→C | `data { data, offset, sessionId, resumeId }` | sessionId + resumeId 추가 |
| S→C | `exit { exitCode, sessionId }` | sessionId 추가 |
| S→C | `state { running, exitCode, sessionId }` | sessionId 추가 |
| S→C | `reset { sessionId, resumeId }` | sessionId + resumeId 추가 |

**신규 메시지:**

| 방향 | 타입 | 설명 |
|------|------|------|
| C→S | `session_create { name?, cols?, rows?, fromSessionId? }` | 새 세션 생성 요청 |
| C→S | `session_kill { sessionId }` | 세션 종료 요청 |
| C→S | `session_title { sessionId, title }` | xterm title 변경 감지 → 세션 이름 갱신 |
| C→S | `session_list` | 세션 목록 요청 |
| S→C | `session_created { session: SessionInfo }` | 세션 생성 완료 |
| S→C | `session_killed { sessionId }` | 세션 종료 완료 |
| S→C | `session_list { sessions: SessionInfo[] }` | 세션 목록 응답 |
| S→C | `session_updated { session: SessionInfo }` | 세션 상태/이름 변경 브로드캐스트 |
| S→C | `session_removed { sessionId }` | TTL 만료로 자동 제거됨 |
| S→C | `replay_complete { sessionId, resumeId }` | 해당 WS의 resume replay 전송 완료 |
| S→C | `session_error { sessionId?, reason }` | 잘못된 세션 접근 또는 제한 초과 |

`session_create`의 `cols`/`rows`는 optional이며, 값이 없으면 서버는 80×24(또는 구현 시 합의한 기본 크기)로 PTY를 시작한 뒤 첫 `resize`로 정확한 크기를 맞춘다. `fromSessionId`가 있으면 `SessionManager.get(fromSessionId)?.cwd ?? launcher cwd`로 새 세션의 `cwd`를 결정한다.

**연결 lifecycle 변경:**

```text
1. WS 연결 + 인증 (기존과 동일)
2. 서버 → session_list { sessions }
3. 클라이언트가 세션 선택 → resume { lastOffset, sessionId }
4. 서버: 해당 WS의 진행 중 replay가 있으면 per-WS `replayAborted` 플래그를 세워 즉시 abort하고, `ClientState.activeSessionId`가 있으면 이전 Session에서 `detachViewer(ws)`
5. 서버: 새 resume 처리용 `resumeId`를 발급하고 `ClientState.activeSessionId = sessionId`로 갱신
6. 서버: 새 Session에는 우선 pending 상태로 연결하고 `state { running, exitCode, sessionId }` 전송
7. 세션 전환이면 `reset { sessionId, resumeId }` → `getLastN(200KB)` 기반 replay chunks → `replay_complete { sessionId, resumeId }`
8. reconnect면 saved lastOffset 기준 `getFrom()` delta replay → `replay_complete { sessionId, resumeId }`
9. replay가 정상 종료된 경우에만 Session.activateViewer(ws)로 live data 수신 시작
10. 또는 `session_create { name?, cols?, rows?, fromSessionId? }` → `session_created` → `resume`
11. 이후 input/data/resize는 `ClientState.activeSessionId` 기준으로 라우팅
```

**클라이언트별 active session:**
- 각 WS 클라이언트는 하나의 active session을 가지며, `ClientState.activeSessionId: string | null`로 추적한다
- `resume { sessionId }` 수신 시: 이전 `activeSessionId`의 Session에서 `detachViewer(ws)` → 새 `activeSessionId` 저장 → 새 Session에 pending attach
- `input`은 `ClientState.activeSessionId`로 Session을 조회한 뒤 `Session.write(data, ws)`로 전달한다
- WS close 시에도 `activeSessionId`의 Session에서 `detachViewer(ws)`를 호출한다
- `resume` 직후 해당 세션의 `state`를 다시 내려 보내 exited 세션 전환 시에도 exit 배너를 정상 표시한다
- **세션 전환**(다른 `sessionId`)은 항상 `lastOffset: 0`으로 처리하고, xterm reset 뒤 `OutputBuffer.getLastN(200KB)` 기반 capped replay를 받는다
- **reconnect**(같은 `sessionId`로 WS 재연결)는 세션별 `lastOffset`을 복원해 `OutputBuffer.getFrom()` 기반 delta replay를 받는다
- 빠른 A→B→A 전환을 위해 서버는 WS별 진행 중 replay를 새 `resume` 수신 즉시 abort하며, replay 루프는 각 chunk 전송 전 per-WS abort 상태를 확인한다. abort된 replay에는 `replay_complete`를 보내지 않는다
- 서버는 resume마다 증가하는 `resumeId`를 부여하고, 클라이언트는 현재 활성 `resumeId`와 일치하는 `reset`/`data`/`replay_complete`만 렌더링한다

**broadcast scope 규칙:**
- **PTY data broadcast**: `Session.viewers`에만 전송한다. 즉 현재 그 세션을 active로 보고 있고 replay가 끝난 authenticated WS만 대상이다
- **Lifecycle broadcast** (`session_created`, `session_killed`, `session_removed`, `session_updated`): 어떤 세션을 보고 있든 **모든 authenticated WS 연결**에 전송한다
- 이유: 터미널 raw data는 active session viewer에게만 보내야 대역폭 낭비와 민감 정보 노출을 줄일 수 있고, 비활성 세션 상태 표시는 `lastActivity` + `session_updated`만으로 충분하다

**viewer / resize ownership:**
- `Session.viewers`는 **data broadcast + resize ownership + input routing** 전용이다
- replay 완료 전 WS는 `pendingViewers` 또는 동등한 대기 상태로만 관리하고 `Session.viewers`에는 넣지 않는다
- `Session.write(data, viewer)`는 입력한 viewer를 `activeViewer`로 갱신하고, 필요하면 해당 viewer의 마지막 크기(모바일이면 mobile 우선)를 PTY에 즉시 적용한다
- `resize` 메시지의 `sessionId` 기준으로 해당 세션의 `Session.resize()`만 호출하며, viewer ownership 판단은 모두 Session 내부에서 처리한다

**`session_updated` 브로드캐스트 타이밍:**
- 세션 이름 변경 직후 (active session의 xterm title 변경 또는 inactive session의 OSC 0 관찰 결과 반영)
- 세션 종료(`onExit`) 직후
- `lastActivity` 기반 idle/busy 상태 전환 시
  - 5초 이상 출력이 없으면 idle, 출력이 발생하면 busy로 간주
  - idle 상태에서 첫 출력이 나오면 `session_updated` 1회 broadcast (idle→busy)
  - 마지막 출력 후 5초가 지나면 `session_updated` 1회 broadcast (busy→idle)
  - busy 상태에서 연속 출력되는 동안에는 추가 broadcast를 보내지 않는다
- 필요 시 attachLocal 플래그/상태 변화가 발생할 때

**자동 제거 / replay 경계 이벤트:**
- TTL 만료로 exited 세션이 제거될 때 `session_removed { sessionId }`를 브로드캐스트한다
- `session_removed`/`session_killed`를 받은 클라이언트는 현재 active session이 사라졌다면 **auto-switch 하지 않는다**
  - 데스크탑: 터미널 영역을 blank state로 전환하고 `Session ended. Select a session from the list.` 메시지를 표시한다
  - 모바일: 자동으로 세션 목록 화면으로 복귀한다
  - 이유: 다른 세션으로 자동 전환하면 이후 입력이 의도하지 않은 세션으로 전달될 위험이 있다
- 제거된 세션으로 뒤늦게 `input`이 오면 서버는 `session_error`로 응답한다
- `resume` replay(chunks 또는 delta) 전송이 모두 끝나면 해당 요청을 보낸 WS에만 `replay_complete { sessionId, resumeId }`를 응답한다

### 4. `src/server.ts` 변경 — API 확장

**신규 REST API:**

| 메서드 | 경로 | 설명 |
|--------|------|------|
| `GET` | `/api/sessions` | 세션 목록 |
| `POST` | `/api/sessions` | 새 세션 생성 (`{ name?, cols?, rows?, fromSessionId? }`) |
| `DELETE` | `/api/sessions/:id` | 세션 종료 |


보안 규칙:
- 모든 세션 관리 API에 `httpAuthMiddleware` 적용
- LAN 모드: 토큰 검증
- Tailscale/Funnel 모드: JWT 검증

> WS 메시지로도 동일 기능 제공 (REST는 보조 수단)

### 5. `src/index.ts` 변경 — launcher 오케스트레이터

- 기존: `spawnInPty()` 직접 호출 → 단일 PTY
- 변경: `SessionManager` 생성 → 초기 세션 1개 자동 spawn
- 기존 `--session` 인자는 초기 세션에 전달
- cleanup: `sessionManager.killAll()` 호출
- `attachLocal`은 초기 세션에만 적용 (launcher 터미널 = 초기 세션)
- 원격 클라이언트가 초기(attachLocal) 세션을 `session_kill { sessionId }`로 종료하면 PTY는 종료하되 세션 메타는 exited 상태로 유지하고, launcher는 `runningCount()` 기준으로만 종료 여부를 판단한다
- 초기 세션 kill 시 launcher의 로컬 stdin은 detach되며, 로컬 터미널에는 경고 메시지를 출력한다

---

## launcher 수명 규칙

현재 `src/index.ts`는 단일 PTY의 `onPtyExit`에서 cleanup + `process.exit()`를 호출한다. 멀티 세션에서는 이 정책을 아래처럼 바꾼다.

- launcher는 **명시적 shutdown 또는 `SessionManager.runningCount() === 0` 이후 30초 grace period 만료 시점**에만 exit
- 초기 세션(`attachLocal: true`)이 종료되면:
  - `runningCount() > 0`이면 launcher는 계속 실행
  - 로컬 터미널에 `Initial session exited. N remote sessions still active. Press Ctrl+C to shut down.` 출력
  - 이 시점부터 로컬 stdin attachment만 해제되고 서버/WS는 유지
- `runningCount() === 0`이 되면 즉시 종료하지 않고 30초 grace period를 시작한다
- grace period 동안 `session_create`가 오면 새 세션을 생성하고 종료 타이머를 취소한다
- grace period 만료 시 cleanup + exit
- exited 세션이 TTL 정리 대기 중이어도 launcher 수명 판단에는 영향을 주지 않음
- SIGINT/SIGTERM은 기존과 동일하게 모든 세션을 `killAll()` 한 뒤 exit
- launcher가 종료 조건을 판단할 때는 “초기 세션 종료 여부”가 아니라 “현재 running 상태 세션 수”를 기준으로 판단

---

## 웹 클라이언트 변경

### 데스크탑 레이아웃

```text
┌──────────────────────────────────────────────────┐
│  π remote  🟢 Connected            [Re-auth] [Info]  │
├────────────┬─────────────────────────────────────┤
│            │                                     │
│  Sessions  │  선택된 세션의 터미널                 │
│            │                                     │
│  ● my-proj │  $ pi                               │
│  ○ api-fix │  > 분석 중...                        │
│  ✕ review  │                                     │
│            │                                     │
│            │                                     │
│  [+ New]   │                                     │
│            │                                     │
├────────────┴─────────────────────────────────────┤
│ ↑  ↓  ←  →  Enter  Tab  Esc  Ctrl+C             │
└──────────────────────────────────────────────────┘
```

- 왼쪽 사이드바: 세션 목록 (고정 너비 ~180px)
- 오른쪽: 선택된 세션의 터미널 (나머지 공간)
- 사이드바 항목: 상태 아이콘 + 세션 이름
- `[+ New]` 버튼: 세션 생성
- 세션 우클릭/롱프레스: 종료

### 모바일 레이아웃 (depth 네비게이션)

**화면 1: 세션 목록**

```text
┌──────────────────┐
│ π remote         │
│                  │
│ ● my-proj     →  │
│ ○ api-fix     →  │
│ ✕ review      →  │
│                  │
│ [+ New Session]  │
└──────────────────┘
```

**화면 2: 터미널 (← 뒤로가기)**

```text
┌──────────────────┐
│ ← my-proj   🟢   │
│                  │
│  $ pi            │
│  > 분석 중...     │
│                  │
│                  │
├──────────────────┤
│ ↑ ↓ ← → Enter   │
└──────────────────┘
```

- 세션 목록 → 세션 tap → 터미널 화면
- 터미널 상단 `←` 버튼 → 세션 목록으로 복귀
- 스와이프 우측(back gesture)도 세션 목록으로 복귀
- 터미널에서 세션 목록으로 돌아갈 때 WS 연결은 유지
- 모바일에서는 `TerminalView`를 unmount/dispose 하지 않고 **hide(display:none)** 처리
- 다시 터미널로 돌아오면 display 복원 후 모바일에서는 `mobileFixedResize()`를 호출하고, 데스크탑만 `fitAddon.fit()`을 사용
- 메모리 절약이 필요하면 장시간 비활성 상태에서만 dispose를 검토

### 파일 구조 변경

```text
web/src/
├── main.ts            ← 수정: 세션 목록 + 터미널 라우팅
├── terminal.ts        ← 수정: sessionId 기반 메시지, active session 전환
├── auth.ts            ← 변경 없음
├── pwa.ts             ← 변경 없음
├── session-list.ts    ← 신규: 세션 목록 UI 컴포넌트
└── session-types.ts   ← 신규: SessionInfo 타입 + WS 메시지 타입
```

### `web/src/session-list.ts` (신규)

```typescript
interface SessionListOptions {
  onSelect: (sessionId: string) => void;
  onCreate: () => void;
  onKill: (sessionId: string) => void;
}

class SessionListView {
  constructor(container: HTMLElement, options: SessionListOptions) { ... }

  updateSessions(sessions: SessionInfo[]): void { ... }
  setActiveSession(sessionId: string): void { ... }
  dispose(): void { ... }
}
```

### `web/src/terminal.ts` 변경

- `TerminalView`에 `activeSessionId`와 현재 전환을 식별하는 `activeResumeId` 프로퍼티 추가
- xterm.js 인스턴스는 세션마다 따로 만들지 않고 **하나를 재사용**
- `switchSession(sessionId)` 메서드: `flushWrite()`로 pending writeBuffer를 먼저 비운 뒤 터미널 리셋 → 세션별 offset을 0으로 초기화 → 해당 세션으로 `resume` 전송
- reconnect는 `Map<string, number>`에 저장된 세션별 `lastOffset`을 복원해서 같은 `sessionId`로 `resume` 전송
- `sendInput`이 `sessionId`를 포함하여 전송하되, 서버는 최종적으로 active session 기준으로 라우팅
- xterm.js `onTitleChange`를 구독해 세션 이름 변경을 감지하고 `session_title { sessionId, title }` WS 메시지를 서버로 전송 (서버가 SessionInfo.name 갱신 + session_updated broadcast)
- `data`/`reset`/`replay_complete` 메시지 수신 시 `sessionId`와 `resumeId`를 모두 확인하고 현재 active session + active resume과 일치할 때만 렌더링
- 세션별 `lastOffset` 추적 (`Map<string, number>`)
- replay burst 대응을 위해 큰 replay는 chunk 단위로 받아 순차 렌더링
- `replay_complete { sessionId, resumeId }` 수신 전까지는 현재 세션 전환 중인 replay로 간주하고, 이전 세션의 늦게 도착한 replay chunk는 무시한다

### `web/src/main.ts` 변경

**데스크탑:**

```text
#app
├── #topbar
├── #content
│   ├── #sidebar (SessionListView)
│   └── #terminal-wrap (TerminalView)
└── #keybar (모바일만)
```

**모바일:**

```text
#app
├── #topbar
├── #session-list-view (전체 화면, 세션 목록일 때)
├── #terminal-view (전체 화면, 터미널일 때)
└── #keybar (터미널일 때만)
```

- `currentView: "list" | "terminal"` 상태로 화면 전환
- 세션 tap → `currentView = "terminal"` + `terminalView.switchSession(id)`
- 뒤로 → `currentView = "list"`
- active session이 `session_removed`/`session_killed`되면 `main.ts`는 **자동으로 다른 세션을 선택하지 않고** blank state로 전환한다
  - 모바일: 세션 목록 화면으로 복귀
  - 데스크탑: 터미널 영역에 `Session ended. Select a session from the list.` 안내를 표시하고, 사용자가 사이드바에서 다음 세션을 직접 선택

---

## 프로토콜 하위 호환성

**하위 호환은 유지하지 않는다.** 멀티 세션 구현 시 웹 클라이언트와 서버 프로토콜을 함께 교체한다.

- 모든 WS 메시지에 `sessionId`가 **필수** (optional 아님)
- `sessionId` 없는 메시지는 서버가 거부 (`session_error { reason: "sessionId_required" }`)
- 기존 단일 세션 웹 클라이언트(`web-dist/`)는 멀티 세션 버전으로 완전 교체
- `initialSessionId`, `getInitial()` 같은 legacy anchor 개념 불필요 — 제거
- 초기 세션은 TTL과 원격 kill에 대해서는 다른 세션과 동일하게 취급한다. 단, attachLocal로 인한 로컬 터미널 연결과 `killAll()` 종료 순서는 여전히 특수하다

---

## 리소스 관리

### PTY 프로세스 제한
- 최대 동시 세션 수는 기본 **3개**를 권장하고, 환경변수 `PI_REMOTE_MAX_SESSIONS`로 조정 가능
- 고사양 환경에서는 5개까지 허용 가능하되, 기본값을 3으로 둘지 구현 시점에 최종 결정
- 초과 시 `session_create` 거부 + `session_error` 전송

### 세션 자동 정리
- `exited` 상태 세션: 5분 후 자동 제거
- 환경변수 `PI_REMOTE_SESSION_TTL`로 조정 가능

### replay / WS 대역폭
- **세션 전환**(다른 `sessionId`)은 xterm reset 후 `lastOffset: 0` 기준으로 replay를 시작하고, `OutputBuffer.getLastN(200KB)` 결과를 chunk 단위로 분할 전송한다
- 세션 전환의 현실적인 최소안은 replay 최대 크기를 **200KB**로 제한하고, 초과 시 `reset` 후 최근 200KB만 전송한다
- **reconnect**(같은 `sessionId` 재연결)는 `OutputBuffer.getFrom(lastOffset)` 기반 delta를 그대로 사용하고, 유효한 offset이면 별도 200KB cap을 두지 않는다
- 서버는 WS별로 진행 중인 replay를 추적하고, 새 `resume`이 오면 이전 replay를 즉시 abort한다
- replay가 abort되지 않고 정상 종료된 경우에만 해당 요청을 보낸 WS에 `replay_complete { sessionId, resumeId }`를 응답해 세션 전환 경계를 명확히 한다
- 필요하면 추후 `OutputBuffer`에 “최근 N줄만 replay” 옵션을 추가 검토
- live PTY raw data는 **해당 세션을 active로 보고 있는 viewer들에게만 full-rate**로 전송한다
- 비활성 세션은 raw data를 보내지 않고, `SessionInfo.lastActivity` 기반 idle/busy 전환 때만 `session_updated` broadcast를 보내 사이드바 상태를 갱신한다
- inactive session의 이름 변경은 서버가 `Session.onData`에서 OSC 0를 비파괴적으로 관찰해 best-effort로 감지한다
- 이유: 비활성 세션 raw data fan-out은 대역폭 낭비와 민감 정보 유출 위험이 크고, 상태 표시는 `lastActivity` + 최소 title 관찰만으로 충분하다
- 서버는 모든 PTY/replay `ws.send()` 전에 `ws.bufferedAmount`를 확인한다
  - `bufferedAmount > 1MB`이면 해당 WS로의 PTY data/replay chunk 전송을 일시 중단(drop)한다
  - `bufferedAmount > 5MB`이면 해당 WS를 `close(4003, "backpressure")`로 종료한다
  - 클라이언트는 backpressure close를 받으면 재접속 후 `resume`으로 복구한다

### 메모리
- 세션당 `OutputBuffer` 1MB → 5세션이면 최대 5MB
- 그러나 pi child process 자체가 Node.js 런타임이므로 세션당 대략 **50–150MB RSS**를 예상
- 5세션이면 OutputBuffer 외에도 PTY child 프로세스 메모리로 **총 500MB+** 사용 가능
- 저사양 머신에서는 기본 max를 3으로 유지하는 편이 안전
- 비활성 세션의 출력은 계속 버퍼링하되, 세션 수 제한으로 총 메모리를 관리

---

## launcher attachLocal 처리

현재 launcher는 `attachLocal: true`로 초기 세션의 PTY I/O를 로컬 터미널에 연결한다.

멀티 세션에서:
- **초기 세션만** `attachLocal: true` 유지
- 추가 생성된 세션은 `attachLocal: false` (웹에서만 접근)
- 로컬 터미널에서 세션 전환은 지원하지 않음 (웹 UI 전용 기능)
- `attachLocal` 세션은 동시에 하나만 허용
- 초기 세션 종료 시 `detachLocalStdin()`만 해제하고 서버/WS는 유지 가능해야 함
- 초기(attachLocal) 세션이 kill되면 stdin detach + exited 상태. 다른 running 세션이 있으면 launcher 유지, 없으면 `runningCount() === 0` 규칙에 따라 종료

---

## 서버 합류 패턴

여러 독립 pi 세션에서 `/remote`를 실행했을 때, **하나의 remote 서버에 합류**하여 동일 URL에서 관리한다.

### 동작 흐름

```
Terminal 1: pi → /remote → port 7009 비어있음 → launcher 시작 + session 1
Terminal 2: pi → /remote → port 7009에 GET /api/info → 서버 있음 → POST /api/sessions → session 2 등록 → pi 종료
Terminal 3: pi → /remote → port 7009에 GET /api/info → 서버 있음 → POST /api/sessions → session 3 등록 → pi 종료
```

### extension `index.ts` 변경

`/remote` 실행 시:
1. 먼저 port 7009~7099에서 기존 remote 서버를 탐색 (`GET /api/info`)
2. **서버 발견 시 (합류 모드)**:
   - 현재 pi 세션 파일 경로를 `POST /api/sessions` 로 전송 (`{ sessionFile, cwd }`)
   - 서버가 새 PTY를 spawn하여 해당 세션을 이어받음
   - 현재 pi 인스턴스는 종료 (launcher 시작 불필요)
   - `ctx.ui.notify("Joined existing remote server at ...")` 표시
3. **서버 미발견 시 (기존 동작)**:
   - launcher를 새로 시작하여 첫 번째 세션으로 등록

### `POST /api/sessions` 확장

기존 body에 `sessionFile` 필드 추가:
```typescript
POST /api/sessions
{
  sessionFile?: string,   // pi --session <path>로 전달할 세션 파일 경로
  cwd?: string,           // 새 세션의 작업 디렉토리
  cols?: number,
  rows?: number,
  fromSessionId?: string,
  name?: string,
}
```

`SessionManager.create()`에 `sessionFile` → pi spawn 시 `--session <sessionFile>` 인자 전달.

### 보안
- 합류 시 기존 서버의 인증 방식을 따름 (LAN: token, Tailscale: PIN→JWT)
- extension에서 `GET /api/info`로 token/mode 확인 후, 인증 필요 시 합류 불가 → launcher 새로 시작
- 즉, LAN 모드에서만 합류 가능 (token을 알고 있으므로). Tailscale/Funnel 모드에서는 PIN 입력이 필요하므로 합류하지 않고 새 launcher 시작.
  - 추후 개선: 서버가 lockfile에 token/PIN을 저장하여 같은 머신의 다른 pi에서 자동 합류 가능

### lockfile (향후 고려)
- launcher 시작 시 `/tmp/pi-remote.lock` 에 `{ port, token, mode, pid }` 저장
- 다른 pi에서 `/remote` 시 lockfile을 먼저 확인 → 포트 탐색 없이 즉시 합류
- launcher 종료 시 lockfile 삭제
- 현재 최소 구현: lockfile 없이 포트 순차 탐색으로 서버 발견

---

## 구현 단계

### Phase 1 — SessionManager + 서버
기존 싱글톤 PTY를 SessionManager로 교체.

- [ ] `src/session-manager.ts`: Session 클래스 + SessionManager
- [ ] `src/pty.ts`: 싱글톤 상태 제거, Session 클래스로 이동
- [ ] `src/ws.ts`: sessionId 기반 메시지 라우팅 + 세션 관리 메시지
- [ ] `src/ws.ts`: `ClientState.activeSessionId` + per-WS replay abort / `resumeId` 추적 추가
- [ ] `src/ws.ts`: viewer ownership(`viewers`, `pendingViewers`, `activeViewer`, `viewerSizes`, `mobileViewers`)을 Session 내부로 이동
- [ ] `src/ws.ts`: `resume` 시 이전 Session `detachViewer(ws)` → 새 Session pending attach → replay 완료 후 `activateViewer(ws)` 흐름 구현
- [ ] `src/server.ts`: `/api/sessions` REST API + 인증 적용
- [ ] `src/index.ts`: SessionManager 생성, 초기 세션 spawn, launcher lifetime 정책 반영
- [ ] `src/pty.ts` 또는 관련 버퍼 유틸: `OutputBuffer.getLastN(maxBytes)` 구현
- [ ] `src/index.ts` 또는 SessionManager 수명 관리: launcher 30초 grace period 구현
- [ ] `src/session-manager.ts`: `Session.cwd` 필드 저장 + `fromSessionId` → cwd 해석 로직 구현
- [ ] `src/ws.ts`: `session_title` (C→S) 핸들러 — xterm title 변경 수신 → SessionInfo.name 갱신 + `session_updated` broadcast
- [ ] sessionId 없는 메시지는 거부 (`session_error`)
- [ ] lifecycle broadcast(`session_updated`/`session_removed`/`session_killed` 등)는 전체 authenticated WS에 전송
- [ ] `session_updated`/`session_removed` broadcast와 per-WS `replay_complete` 응답을 core 프로토콜로 구현
- [ ] 동작 검증: 멀티 세션 웹 클라이언트로 세션 생성/전환/종료 확인

### Phase 2 — 웹 클라이언트 (데스크탑)
사이드바 + 터미널 split 레이아웃.

- [ ] `web/src/session-types.ts`: 공유 타입
- [ ] `web/src/session-list.ts`: 세션 목록 컴포넌트
- [ ] `web/src/terminal.ts`: sessionId 지원, switchSession vs reconnect offset 구분, `resumeId` 검증, replay/state 처리
- [ ] `web/src/terminal.ts`: 세션 전환 전 `flushWrite()` + active session removed 시 blank state 처리
- [ ] `web/src/main.ts`: 데스크탑 split 레이아웃
- [ ] 동작 검증: 세션 생성/전환/종료/이름변경

### Phase 3 — 웹 클라이언트 (모바일)
depth 네비게이션 UX.

- [ ] `web/src/main.ts`: 모바일 list↔terminal 전환
- [ ] 모바일 뒤로가기 / 스와이프 지원
- [ ] `TerminalView` hide/show lifecycle + 모바일 `mobileFixedResize()` / 데스크탑 `fitAddon.fit()` 복원
- [ ] 동작 검증: 모바일에서 세션 목록 → 터미널 → 뒤로 → 다른 세션

### Phase 4 — 품질 개선
- [ ] 세션 자동 정리 (exited 후 TTL)
- [ ] 최대 세션 수 제한 기본값 확정
- [ ] 세션 목록 정렬: 생성일 순 (createdAt ascending)
- [ ] replay 상한/청크 정책 튜닝

---

## Known Limitations

- **TUI 앱 복원**: `vim`, `less`, `top` 같은 full-screen 앱은 replay 기반 화면 복원이 best-effort다. PTY terminal state snapshot은 지원하지 않는다.
- **공유 세션 공간**: 세션 목록은 모든 인증된 클라이언트가 공유한다. 한 클라이언트의 kill은 다른 클라이언트에 즉시 반영되며, 사용자별 격리는 현재 지원하지 않는다.

---

## 결정된 질문

1. **세션별 pi 인자**: 인자 없이 기본 pi만 spawn. 추후 필요 시 웹 UI에서 인자 입력 폼 추가.

2. **세션 영속성**: 서버 재시작 시 초기 세션만 다시 생성. 기존 세션 목록은 복원하지 않음.

3. **세션 cwd**: 특정 세션 안에서 새 세션을 생성하면 해당 세션의 cwd를 상속. 세션 밖(세션 목록 등)에서 생성하면 launcher의 cwd를 사용.
   - `session_create` 메시지와 `POST /api/sessions` body에 `fromSessionId?: string` 추가
   - Session 생성 시 사용한 `cwd`를 `Session.cwd`에 저장하고, 상속 시 `SessionManager.get(fromSessionId)?.cwd ?? launcher cwd`를 사용
   - exited 세션도 TTL 만료 전까지는 메타데이터(`cwd` 포함)를 유지하므로 상속 가능하고, TTL 만료 뒤에는 launcher cwd로 fallback
