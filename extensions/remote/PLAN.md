# pi-remote-external 구현 계획

> Tailscale 네트워크를 통해 외부에서 pi 세션에 웹 브라우저로 접속할 수 있는 pi 익스텐션.
> 모든 코드는 `extensions/remote/` 안에 자체 완결.

## 레퍼런스

- 기존 구현: https://github.com/ruanqisevik/pi-mono-extensions/tree/main/packages/remote
- 로컬 클론: `/tmp/pi-github-repos/ruanqisevik/pi-mono-extensions@main/packages/remote/`

---

## 아키텍처

레퍼런스 `pi-remote`와 동일하게 **extension 프로세스**와 **launcher/remote 런타임 프로세스**를 분리한다.
`/remote` 실행 시 현재 pi 프로세스는 종료되므로, PTY·서버·WS 브릿지는 extension이 아니라 별도 launcher가 소유해야 한다.

```
현재 pi 세션
  │
  │ /remote
  ▼
┌──────────────────────────────┐
│ extensions/remote/index.ts   │  ← 명령 등록, 세션 파일 확보, shutdown 트리거, widget 표시
└──────────────┬───────────────┘
               │ session_shutdown 이후 별도 프로세스 실행
               ▼
┌──────────────────────────────┐
│ extensions/remote/dist/cli.js │  ← 빌드된 launcher 실행 파일
└──────────────┬───────────────┘
               ▼
┌─────────────────────────────────────────────────────┐
│ extensions/remote/src/index.ts (startRemote)       │
│  ┌───────────────────────────────────────────────┐  │
│  │ HTTP/HTTPS 서버                               │  │
│  │ - LAN: HTTP (0.0.0.0)                         │  │
│  │ - Tailscale: HTTPS (0.0.0.0, tailscale cert)  │  │
│  │ - Funnel: HTTP (127.0.0.1), TLS는 Tailscale   │  │
│  ├───────────────────────────────────────────────┤  │
│  │ Auth Layer                                    │  │
│  │ - LAN: 랜덤 토큰                              │  │
│  │ - Tailscale/Funnel: PIN → JWT                 │  │
│  ├───────────────────────────────────────────────┤  │
│  │ WebSocket Bridge                              │  │
│  │ - resume + heartbeat                          │  │
│  ├───────────────────────────────────────────────┤  │
│  │ Session Manager                               │  │
│  │ - 링버퍼 + offset delta sync                  │  │
│  ├───────────────────────────────────────────────┤  │
│  │ PTY (pi CLI)                                  │  │
│  │ - local terminal attach 유지                  │  │
│  └───────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────┘
               │
               ▼
브라우저 (tailnet / funnel / LAN)
```

---

## 명령어

```
/remote          → Tailscale preflight 성공 시: HTTPS + PIN 인증 (외부 접속)
                 → 실패 시: HTTP + 토큰 (LAN 전용 fallback)
/remote --funnel → Funnel preflight 성공 시: 공개 URL + PIN 인증
                 → 실패 시: 이유를 widget에 표시하고 LAN fallback
/remote --lan    → Tailscale 상태와 무관하게 강제 LAN 모드
```

모드 결정 로직:

```typescript
if (options.forceLan) return "lan";

const ts = await getTailscaleInfo();
if (!ts.installed) return fallbackLan("Tailscale not installed");
if (!ts.running) return fallbackLan("Tailscale stopped");
if (!ts.certDomains.length) return fallbackLan("Tailscale cert domain unavailable");

const hostname = ts.certDomains[0];
const cert = await ensureCert(hostname).catch(() => null);
if (!cert) return fallbackLan("Tailscale cert preflight failed");

if (options.funnel) {
  if (!ts.funnelAvailable) return fallbackLan("Tailscale Funnel unavailable");
  return "funnel";
}

return "tailscale";
```

상태 매트릭스:

| 상태 | 결과 |
|------|------|
| `installed=false` | `lan` |
| `installed=true`, `running=false` | `lan` + widget에 `Tailscale stopped → LAN mode` 표시 |
| `installed=true`, `running=true`, `certDomains=[]` | `lan` + widget에 이유 표시 |
| `installed=true`, `running=true`, cert preflight 성공 | `tailscale` |
| `--funnel` + 위 조건 충족 + Funnel 사용 가능 | `funnel` |
| `--funnel` 이지만 preflight 실패 | `lan` + widget에 fallback 이유 표시 |

---

## 파일 구조

```
extensions/remote/
├── index.ts              ← pi 익스텐션 진입점 (/remote 명령 등록, shutdown 트리거, widget)
├── package.json          ← 서버 런타임 의존성 (node-pty, ws, jose 등) 격리
├── tsconfig.build.json    ← launcher/runtime용 CommonJS(or NodeNext) 빌드 설정
├── src/
│   ├── cli.ts            ← launcher 소스 진입점 (빌드 후 dist/cli.js 생성)
│   ├── index.ts          ← startRemote 오케스트레이터 (서버 시작 + Funnel URL 확정 + PTY spawn)
│   ├── server.ts         ← HTTP/HTTPS 서버 + 정적 파일 서빙 + API + WS upgrade auth 관문
│   ├── tailscale.ts      ← Tailscale 상태 조회, cert preflight, Funnel 제어
│   ├── auth.ts           ← LAN 토큰 / PIN / JWT / rate limit / lockout / PIN rotation
│   ├── ws.ts             ← WebSocket 브릿지 (auth, resume, heartbeat, auth revoke close)
│   ├── pty.ts            ← PTY 관리 (node-pty spawn/resize/kill)
│   └── session.ts        ← 출력 링버퍼, offset 추적, reconnect delta
├── dist/
│   ├── cli.js            ← `tsc -p tsconfig.build.json` 산출물, launcher 실행 대상
│   └── index.js          ← 빌드된 remote 런타임 엔트리
├── web/
│   ├── index.html
│   ├── vite.config.ts    ← `outDir: "../web-dist"`
│   ├── package.json      ← xterm.js, qrcode 등 웹 의존성
│   └── src/
│       ├── main.ts       ← 앱 진입점 (auth → terminal 라우팅)
│       ├── terminal.ts   ← xterm.js 터미널 + reconnect/resume 로직
│       ├── auth.ts       ← PIN 입력 UI
│       └── pwa.ts        ← PWA manifest + service worker 등록
├── web-dist/             ← vite build 결과물
├── PLAN.md               ← 이 문서
└── README.md
```

---

## 모듈 상세 설계

### 1. `index.ts` — 익스텐션 진입점

pi ExtensionAPI를 사용해 `/remote` 명령과 widget을 등록한다.
레퍼런스의 `extension/index.ts`처럼 **pi 내부에서만 동작하는 얇은 진입점**으로 유지한다.

**역할:**
- `/remote [--funnel] [--lan]` 명령 등록
- 실행 시: 세션 파일 확보 → `pendingRemote` 상태 저장 → pi 종료 트리거
- `session_shutdown` 이벤트에서 빌드된 `dist/cli.js`를 **별도 프로세스로 실행**
- launcher 경로는 `path.join(__dirname, "dist", "cli.js")`로 해석
- `PI_REMOTE_URL`, `PI_REMOTE_MODE`, `PI_REMOTE_REASON`, `PI_REMOTE_PIN` 환경변수를 읽어 widget 표시
- widget은 URL·초기 PIN·fallback 이유와 함께, **PIN은 런타임 중 변경될 수 있음** 안내도 표시

**widget 표시 예:**
```
Tailscale: Remote: https://macbook.tail1234.ts.net:7009 | PIN: 482901
Funnel:    Remote: https://example.ts.net             | PIN: 48392017
LAN:       Remote: http://192.168.0.10:7009?token=abc123
Fallback:  Tailscale stopped → LAN mode
```

**세션 복원:**
- 기존 pi-remote과 동일하게 `ctx.sessionManager.getSessionFile()`로 세션 파일 경로 획득
- `--session <path>` 인자를 launcher가 다시 pi에 전달

### 2. `src/cli.ts` — launcher 바이너리 진입점

레퍼런스의 `src/cli.ts` 패턴을 따라 작성하되, **실행은 소스 파일이 아니라 빌드된 `dist/cli.js`** 로 한다.
Node v22.14에서는 `.ts`를 직접 `spawn`할 수 없으므로 launcher/runtime는 별도 빌드 산출물이 필요하다.

**역할:**
- `--pi-path`, `--session`, `--funnel`, `--lan`, `--` 이후 pi 인자 파싱
- `startRemote()` 호출
- fatal error 시 stderr 출력 후 비정상 종료

```typescript
// extension/index.ts
const launcherPath = path.join(__dirname, "dist", "cli.js");
spawn(process.execPath, [launcherPath, "--pi-path", piPath, "--session", sessionFile, ...args], {
  stdio: "inherit",
});
```

**빌드:**
- `src/cli.ts`, `src/index.ts`는 `tsc -p tsconfig.build.json`으로 `dist/cli.js`, `dist/index.js`로 컴파일
- extension의 `index.ts`는 pi 로딩 환경(tsx/ts-node)에서 직접 로드되므로 `.ts` 유지 가능

### 3. `src/index.ts` — remote 런타임 오케스트레이터

레퍼런스의 `startRemote()` 역할을 확장한다.

**역할:**
1. `resolveMode()` 수행 (`mode`, `reason`, `cert`, `hostname`만 결정)
2. 서버 시작 (`startServer`) → 실제 바인딩 포트 확정
3. Funnel 모드일 때만 `startFunnel(actualPort)` 호출 → 공개 URL 획득
4. WebSocket 브릿지 연결 (`setupTerminalWebSocket`)
5. 최종 URL/PIN/fallback reason으로 `PI_REMOTE_*` 환경변수 구성
6. pi를 PTY 안에서 재시작하고 로컬 터미널 attach 유지
7. SIGINT/SIGTERM/PTY exit 시 server + funnel cleanup

**경계:**
- PTY, HTTP(S), WS, cleanup의 단일 소유자
- extension은 이 런타임을 직접 소유하지 않고 launcher만 호출

### 4. `src/tailscale.ts` — Tailscale 통합

```typescript
interface TailscaleInfo {
  installed: boolean;        // tailscale CLI 존재 여부
  running: boolean;          // tailscaled 실행 중 여부
  ip: string | null;         // 100.x.x.x (Tailscale IP)
  certDomains: string[];     // HTTPS cert 발급 가능한 도메인 목록
  funnelAvailable: boolean;  // funnel 기능 사용 가능 여부
  reason?: string;           // fallback 이유 기록용
}
```

**함수:**

| 함수 | 설명 |
|------|------|
| `getTailscaleInfo()` | `tailscale status --json` 파싱 → `installed/running/certDomains/funnelAvailable` 반환 |
| `ensureCert(hostname)` | `tailscale cert <hostname>` preflight 실행 → `{ certPath, keyPath }` 반환 |
| `startFunnel(port)` | `tailscale funnel --bg http://127.0.0.1:<port>` 실행 후 `tailscale funnel status --json`에서 해당 포트의 공개 URL 반환 |
| `stopFunnel(port)` | 시작 시 사용한 포트를 기억해 `tailscale funnel <port> off` 실행 |
| `resolveMode(options)` | Tailscale 상태 + cert preflight + funnel 가능 여부를 기반으로 `lan/tailscale/funnel` 결정 (`publicUrl`은 반환하지 않음) |

**hostname 선택:**
- `Self.DNSName` 대신 `CertDomains[0]` 사용
- 이유: `DNSName`의 후행 점(`.`) 문제를 피하고, 실제 cert 발급 가능한 도메인만 사용하기 위함

**cert 경로:**
- `tailscale cert` 출력 경로를 tmpdir 하위로 고정 (`/tmp/pi-remote-tailscale-certs/<hostname>.crt|.key`)
- launcher 재시작마다 preflight 수행, 실패 시 LAN fallback

**에러 UX:**
- `resolveMode()`는 `{ mode, reason, cert?, hostname? }` 형태 반환
- Funnel 공개 URL은 `startServer()` 후 `startFunnel(actualPort)` 단계에서만 계산
- LAN fallback 시 `reason`을 widget과 stderr 양쪽에 남김
- crash로 Funnel 규칙이 남으면 README에 `tailscale funnel status`, `tailscale funnel <port> off` 수동 정리 절차를 안내

### 5. `src/auth.ts` — 인증

두 가지 모드를 하나의 모듈에서 처리한다.

**LAN 모드 (기존 호환):**
- `crypto.randomBytes(16).toString("hex")` → URL query param `?token=xxx`
- localhost (127.0.0.1, `::1`) 면제

**Tailscale/Funnel 모드:**
- 서버 시작 시 PIN 생성
  - Tailscale: 6자리 PIN
  - Funnel: 8자리 PIN
- PIN은 터미널 widget에만 표시
- 클라이언트가 PIN 제출 → 서버가 JWT 발급 (HS256, 24h 만료)
- JWT 시크릿: `crypto.randomBytes(32)` (메모리 only, 재시작 시 폐기)
- HTTP 요청은 `Authorization: Bearer <token>` 헤더만 허용
- WebSocket은 커스텀 헤더가 어려우므로 첫 메시지 `auth_token`으로 전달

**brute-force 방어:**
- Tailscale 모드: IP당 실패 5회 → 60초 쿨다운
- Funnel 모드: upstream이 localhost로 보일 수 있으므로 **IP별 제한 대신 전역 rate limit**(예: 분당 10회) 우선 적용
- 필요 시 Tailscale이 주입하는 `Tailscale-User-Login` 헤더 활용 가능성을 열어둠
- 전역 실패 20회 → PIN 재생성 + 모든 기존 JWT 무효화 + 활성 WS 즉시 종료
- PIN 유효기간 10분 → 만료 시 자동 재생성
- PIN rotation 시 launcher가 PTY에 경고 메시지 출력 (`⚠️ PIN rotated... New PIN: ...`)

```typescript
generatePin(mode: "tailscale" | "funnel"): string
createJwt(): string
verifyJwt(token: string): boolean
verifyPin(pin: string, remoteIp: string): { ok: true } | { ok: false; reason: string }
httpAuthMiddleware(mode, req, res): boolean
handleAuthRequest(req, res): Promise<void>
resetPinAndSessions(reason: string): { newPin: string; revoked: true }
```

**JWT 라이브러리:**
- `jose` (순수 JS, 네이티브 바인딩 없음) 사용
- node:crypto의 HMAC으로 직접 구현해도 가능 (의존성 최소화 시)

### 6. `src/pty.ts` — PTY 관리

기존 pi-remote의 `pty.ts`를 기반으로 가져온다. 변경 최소화.

**기존과 동일:**
- `node-pty`로 프로세스 spawn
- data/exit 리스너, resize/write/kill 제어
- spawn-helper 퍼미션 자동 수정
- 로컬 stdin/stdout attach 유지

**변경:**
- 출력 버퍼를 `session.ts`의 `OutputBuffer`로 위임
- offset 계산에 필요한 누적 길이 전달
- launcher/remote 런타임에서 cleanup 생명주기를 소유

### 7. `src/session.ts` — 세션 관리

PTY 출력의 링버퍼와 offset 추적을 담당한다. 재접속 시 delta sync의 핵심.

> offset 단위는 **바이트 수가 아니라 `string.length` 기준의 UTF-16 코드 유닛 수**로 통일한다.

```typescript
class OutputBuffer {
  private chunks: string[];
  private totalLength: number;
  private globalOffset: number;     // 버퍼 시작 이후 기록된 전체 string.length 누적치
  private readonly maxSize: number; // 1MB 상당의 문자열 길이 상한

  append(data: string): void;

  /** offset 이후의 데이터와 새 offset 반환. offset이 버퍼 범위 밖이면 null. */
  getFrom(offset: number): { data: string; newOffset: number } | null;

  /** 전체 버퍼 내용과 현재 offset 반환. 신규 접속 시 사용. */
  getAll(): { data: string; offset: number };

  /** 현재 global offset (마지막 기록 위치) */
  getCurrentOffset(): number;
}
```

- `append()`: PTY `onData`에서 호출. maxSize 초과 시 앞부분 잘라냄.
- `getFrom(offset)`: 클라이언트의 `lastOffset`부터 현재까지의 delta 반환.
- 클라이언트 offset이 이미 잘려나간 범위면 `null` → 클라이언트에 `reset` 신호.

### 8. `src/ws.ts` — WebSocket 브릿지

기존 pi-remote의 `ws.ts`를 기반으로 확장한다.

**기존 프로토콜 (유지):**

| 방향 | 타입 | 설명 |
|------|------|------|
| S→C | `data` | PTY 출력 |
| S→C | `exit` | 프로세스 종료 |
| S→C | `state` | PTY 상태 |
| C→S | `input` | 키보드 입력 |
| C→S | `resize` | 터미널 크기 (mobile 플래그 포함) |

**추가 프로토콜:**

| 방향 | 타입 | 설명 |
|------|------|------|
| S→C | `auth_required` | Tailscale/Funnel 모드: PIN 또는 JWT 요구 |
| S→C | `auth_ok { token }` | JWT 발급 또는 재인증 성공 |
| S→C | `auth_fail { reason }` | 인증 실패 / rate limit / lockout |
| S→C | `data { data, offset? }` | PTY 출력 + optional offset |
| S→C | `ping` | Heartbeat |
| S→C | `reset` | offset 범위 초과 시 전체 리셋 |
| C→S | `auth_pin { pin }` | PIN 인증 |
| C→S | `auth_token { token }` | JWT 재인증 |
| C→S | `pong` | Heartbeat 응답 |
| C→S | `resume { lastOffset }` | 재접속 시 delta 요청 |

**연결 lifecycle (Tailscale/Funnel 모드):**

```
1. WS 연결
2. 서버 → auth_required
3. 클라이언트 → auth_pin { pin: "482901" } 또는 auth_token { token: "jwt..." }
4. 서버 → auth_ok { token: "jwt..." } 또는 auth_fail { reason }
5. 클라이언트 → resume { lastOffset: 0 }
6. 서버 → state + data (delta 또는 full)
7. 양방향 input/data/resize 스트리밍
8. 30초마다 ping/pong
```

**연결 lifecycle (LAN 모드):**

```
1. `httpServer.on("upgrade")`에서 `?token=xxx` 검증
2. 불일치 시 `socket.destroy()`
3. 검증 통과 시 `wss.handleUpgrade()`
4. 서버 → state + data { data, offset? } (Phase 1에서는 offset 무시 가능)
5. 양방향 input/data/resize 스트리밍
```

**인증 철회 처리:**
- `resetPinAndSessions()` 호출 시 `ws.ts`가 모든 active WS를 즉시 `close(4001, "auth_revoked")`
- 또는 `authGeneration`을 증가시켜 이전 세대 토큰/연결을 모두 폐기
- 클라이언트는 close event 수신 시 PIN/JWT 재인증 플로우로 복귀

**Heartbeat:**
- 서버: 30초 간격으로 `ping` 전송
- 클라이언트: `pong` 응답
- 3회 연속 미응답 (90초) → 서버가 WS 연결 종료

**모바일 우선 리사이즈:**
- 기존 로직 유지: mobile 클라이언트의 resize가 우선 적용

### 9. `src/server.ts` — HTTP/HTTPS 서버

```typescript
type ServerMode = "lan" | "tailscale" | "funnel";

interface ServerOptions {
  mode: ServerMode;
  port?: number;                 // 기본 7009
  certPath?: string;             // tailscale 모드일 때만
  keyPath?: string;              // tailscale 모드일 때만
  hostname?: string;             // tailscale cert domain
  bindHost?: string;             // lan/tailscale: 0.0.0.0, funnel: 127.0.0.1
}

interface ServerResult {
  server: Server;                // http.Server 또는 https.Server
  url: string;                   // 접속 URL
  pin?: string;                  // tailscale/funnel 모드일 때만
  cleanup: () => Promise<void>;
}

startServer(options: ServerOptions): Promise<ServerResult>
```

**모드별 동작:**

| 모드 | 앱 서버 | TLS 종단 | 인증 | URL 형태 |
|------|---------|---------|------|----------|
| `lan` | HTTP (`0.0.0.0`) | 없음 | 랜덤 토큰 | `http://192.168.0.10:7009?token=abc` |
| `tailscale` | HTTPS (`0.0.0.0`) | 앱 + `tailscale cert` | PIN → JWT | `https://hostname:7009` |
| `funnel` | HTTP (`127.0.0.1`) | Tailscale Funnel | PIN → JWT | Tailscale이 부여한 공개 URL |

**정적 파일 서빙:**
- `web-dist/` 디렉토리를 서빙
- 경로 해석: `path.join(__dirname, "..", "web-dist")`
- SPA fallback: 없는 경로 → `index.html`

**API 엔드포인트:**
- `GET /api/info` → `{ url, mode, hasTailscale, reason, pinMayRotate }`
- `POST /api/auth` → `{ pin }` → `{ token }` 또는 `403`

**WS upgrade 인증:**
- LAN 모드: `server.ts`의 `httpServer.on("upgrade")`에서 `?token=xxx`를 검증한 뒤 `wss.handleUpgrade()` 호출
- Tailscale/Funnel 모드: upgrade 자체는 연결만 허용하고, 첫 WS 메시지 `auth_pin` 또는 `auth_token`으로 세션 인증

**포트 바인딩:**
- 기존과 동일: 7009부터 시작, 사용 중이면 7099까지 순차 시도
- LAN/Tailscale 모드: `0.0.0.0`
- Funnel 모드: `127.0.0.1` 고정

**CORS:**
- `Access-Control-Allow-Origin: *` 는 사용하지 않음
- same-origin 기반으로 동작하고, 필요 시 명시적 origin만 허용

### 10. `web/` — 웹 클라이언트

#### 10-1. `web/src/auth.ts` — PIN 입력 UI

- 6자리(Tailscale) / 8자리(Funnel) 숫자 입력 폼
- 입력 완료 → `POST /api/auth` 또는 WS `auth_pin` 메시지
- JWT 수신 → `sessionStorage` 저장
- rate limit / lockout / PIN 만료 메시지 표시
- LAN 모드에서는 스킵 (URL query token 사용)

#### 10-2. `web/src/terminal.ts` — 터미널 + 재접속

기존 xterm.js 기반. 추가:

- **resume 로직**: WS 끊김 감지 → 2초 대기 → 재접속 → `auth_token` + `resume { lastOffset }` → delta 수신
- **offset 추적**: 서버가 보내는 `data.offset` 값을 기록 (`string.length` 기준)
- **연결 상태 표시**: 상단바에 연결 상태 아이콘 (🟢 연결됨 / 🟡 재접속 중 / 🔴 끊김)
- Phase 1에서는 offset 필드를 무시해도 동작 가능, Phase 3부터 resume에 사용

#### 10-3. `web/src/pwa.ts` — PWA 지원

- `manifest.json`: 앱 이름, 아이콘, `display: standalone`
- Tailscale HTTPS 또는 Funnel 공개 HTTPS에서만 동작
- 모바일에서 "홈 화면에 추가" → 네이티브 앱처럼 실행

#### 10-4. 기존 기능 유지

- 가상 키바 (모바일): 방향키, Ctrl+C, Tab, Esc, Enter
- 터치 스크롤 + 관성
- QR 코드 오버레이 (Remote link 버튼)
- 60컬럼 고정 모바일 레이아웃

---

## 의존성

**서버 (`extensions/remote/`):**

| 패키지 | 용도 | 비고 |
|--------|------|------|
| `node-pty` | PTY | 네이티브 바인딩, 원격 런타임 package에 격리 |
| `ws` | WebSocket 서버 | |
| `jose` | JWT 생성/검증 | 순수 JS, 네이티브 없음 |
| `qrcode-terminal` | 터미널 QR 코드 출력 | |

**웹 (`extensions/remote/web/`):**

| 패키지 | 용도 |
|--------|------|
| `@xterm/xterm` | 터미널 에뮬레이터 |
| `@xterm/addon-fit` | 터미널 자동 리사이즈 |
| `@xterm/addon-webgl` | GPU 가속 렌더링 |
| `qrcode` | QR 코드 캔버스 렌더링 |
| `vite` | 빌드 |

**설치/빌드 워크플로우:**
- 서버 런타임 의존성은 `extensions/remote/package.json`에 둔다.
- 설치: `cd extensions/remote && npm install`
- 런타임 빌드: `cd extensions/remote && npm run build` (`tsc -p tsconfig.build.json` → `dist/cli.js`, `dist/index.js`)
- 웹 빌드: `cd extensions/remote/web && npm run build`
- pi가 extension을 로드할 때 `extensions/remote/index.ts` 기준으로 모듈을 resolve하므로, `remote/node_modules`의 `node-pty`, `ws`, `jose`를 직접 찾을 수 있다.
- launcher는 `dist/cli.js`를 실행하므로, `/remote` 사용 전 서버 런타임 빌드가 선행되어야 한다.
- `web/vite.config.ts`는 `outDir: "../web-dist"`로 고정한다.

---

## 보안 모델

### LAN 모드
- 기존 pi-remote과 동일
- 랜덤 16바이트 토큰 (URL query param)
- localhost (`127.0.0.1`, `::1`) 면제
- 인터넷 공개 용도 아님

### Tailscale 모드

| 계층 | 방법 | 설명 |
|------|------|------|
| L1 네트워크 | Tailscale | tailnet 내부만 접근 가능 |
| L2 전송 | TLS | `tailscale cert`로 발급한 인증서 사용 |
| L3 인증 | PIN → JWT | 6자리 PIN 입력 → 24h JWT 발급 |
| L4 공격 완화 | rate limit + lockout | IP당 5회 실패 / 전역 20회 실패 시 PIN 재발급 |

### Funnel 모드
- 앱 서버는 `127.0.0.1` 에만 바인딩
- TLS는 Tailscale Funnel이 종단하고 앱은 HTTP upstream만 노출
- 공개 URL이므로 8자리 PIN + 전역 rate limit + PIN 10분 만료를 강제
- Funnel 뒤에서는 `remoteAddress`가 `127.0.0.1`로 보일 수 있어 IP별 제한은 신뢰하지 않음
- 가능하면 `Tailscale-User-Login` 헤더를 보조 신호로 활용하되, 기본 설계는 전역 제한 기준
- 전역 실패 임계 초과 시 PIN 재생성 + 기존 JWT 전부 무효화 + 활성 WS 즉시 종료

---

## 구현 단계

### Phase 1 — 기반 (LAN 모드 + launcher 경계)
기존 pi-remote 코드를 `extensions/remote/`에 포팅하되, 레퍼런스와 동일한 launcher 경계를 먼저 세운다.

- [ ] `index.ts`: `/remote` 명령 등록 + session shutdown → `dist/cli.js` 실행
- [ ] `src/cli.ts` + `tsconfig.build.json`: launcher 소스/빌드 구성
- [ ] `src/index.ts`: `startRemote()` 오케스트레이터
- [ ] `src/pty.ts`: PTY 관리 (기존 코드 기반)
- [ ] `src/session.ts`: `OutputBuffer` (`string.length` 기반 offset 포함)
- [ ] `src/auth.ts`: LAN 토큰 인증
- [ ] `src/ws.ts`: WebSocket 브릿지 (`data.offset?` optional 포함)
- [ ] `src/server.ts`: HTTP 서버 + `web-dist` 정적 파일 서빙
- [ ] `web/`: 기존 웹 UI 포팅
- [ ] 동작 검증: `/remote --lan`으로 LAN 접속 확인

### Phase 2 — Tailscale 통합
Tailscale 상태 머신 + HTTPS + PIN 인증 추가.

- [ ] `src/tailscale.ts`: `getTailscaleInfo`, `ensureCert`, `resolveMode`
- [ ] `src/auth.ts`: PIN 생성 + JWT (jose) + rate limit/lockout
- [ ] `src/server.ts`: HTTPS 서버 모드 추가
- [ ] `src/ws.ts`: `auth_required → auth_pin/auth_token → auth_ok/auth_fail`
- [ ] `index.ts`: fallback reason을 포함한 widget 표시
- [ ] `web/src/auth.ts`: PIN 입력 UI + lockout 메시지
- [ ] 동작 검증: tailnet 내부에서 HTTPS 접속 확인

### Phase 3 — 세션 복원
재접속 시 끊김 없는 출력 복원.

- [ ] `src/session.ts`: `getFrom(offset)` delta 로직
- [ ] `src/ws.ts`: `resume` 프로토콜 + heartbeat (`ping/pong`)
- [ ] `web/src/terminal.ts`: 자동 재접속 + offset resume
- [ ] 동작 검증: 네트워크를 끊었다 복원해도 출력 연속성 유지 확인

### Phase 4 — 마무리
PWA + Funnel + 품질 개선.

- [ ] `src/tailscale.ts`: Funnel 지원 (`startFunnel`, `stopFunnel(port)`, status 파싱)
- [ ] `src/server.ts`: Funnel 모드 localhost 바인딩 + 실제 포트 확정 후 URL 전달
- [ ] `web/src/pwa.ts`: PWA manifest + service worker
- [ ] 웹 UI: 연결 상태 표시, 클립보드 버튼
- [ ] README.md 작성
- [ ] 동작 검증: `/remote --funnel` 공개 URL 접속 + PIN 인증 + lockout 확인

---

## 열린 질문

1. **web-dist 빌드 시점**: git에 포함? 아니면 pi 로딩 시 on-the-fly 빌드?
   → 권장: git에 포함 (빌드 의존성 제거). `npm run build:web`으로 수동 빌드.

2. **node-pty 설치**: extensions/package.json에 추가? remote/ 자체 package.json?
   → 권장: remote/ 자체 package.json으로 격리. 네이티브 의존성이 extensions 전체를 오염시키지 않도록.

3. **런타임 빌드 자동화**: `dist/cli.js` / `dist/index.js`를 pi 로딩 시 자동 빌드할지, 개발자가 `npm run build`를 수동 실행할지?
   → 최소안: README에 수동 빌드 절차 명시. 추후 DX 개선이 필요하면 prepublish/postinstall 또는 extension 로드 전 체크를 검토.

4. **jose vs 자체 구현**: JWT가 HS256 단일 용도라면 node:crypto로 ~50줄 자체 구현 가능.
   → 의존성 최소화 선호 시 자체 구현, 아니면 jose.
