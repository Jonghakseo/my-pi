# cron 익스텐션 구현 계획

## 0. 참고 문서와 기준

- Pi 공식 Extensions 문서: `/usr/local/lib/node_modules/@mariozechner/pi-coding-agent/docs/extensions.md`
  - `~/.pi/agent/extensions/<name>/index.ts` 또는 `~/.pi/agent/extensions/*/index.ts`는 auto-discovery 및 `/reload` 대상이다.
  - `pi.registerTool()`로 LLM이 호출 가능한 도구를 제공할 수 있다.
  - `pi.registerCommand()`로 `/cron` 같은 슬래시 커맨드를 등록할 수 있다.
  - `ctx.ui.confirm()`으로 사용자 확인 UI를 띄울 수 있다.
  - `pi.exec()` 또는 Node subprocess로 외부 명령을 실행할 수 있다.
- Pi 공식 README: `/usr/local/lib/node_modules/@mariozechner/pi-coding-agent/README.md`
  - `pi -p` / `--print`는 헤드리스 단발 실행에 사용할 수 있다.
  - `@file.md` 형태로 파일을 프롬프트에 포함할 수 있다.
- 참고 구현: `https://github.com/espennilsen/pi/tree/main/extensions/pi-cron`
  - 배울 점: file-based job store, lock file, stale PID 처리, `fs.watch` live reload, job별 중복 실행 방지, `pi -p --no-session --no-extensions` 실행.
  - 다르게 갈 점: 우리는 Pi 세션 종료 후에도 살아있는 detached daemon과 전용 프롬프트 파일 기반 실행을 1차 목표로 한다.

## 1. 목표

`cron` 익스텐션은 사용자가 자연어로 예약을 요청하면 에이전트가 알아서 크론 작업을 등록할 수 있게 한다.

예시:

```text
이 릴리즈 체크를 매일 아침 10시에 실행하게 해줘
방금 나랑 한거 매일 아침 10시에 실행되게 해
2시간 뒤에 방금 정리한 QA 체크리스트 다시 확인해줘
다음 배포 30분 뒤에 한 번만 상태 확인해줘
매주 월요일 오전 9시에 PR 리뷰 상태 요약해줘
```

핵심은 예약 작업이 현재 세션 히스토리와 분리되어 실행된다는 점이다. 따라서 실행 시점에 필요한 맥락을 전용 Markdown 프롬프트 파일로 고정하고, daemon이 헤드리스 `pi -p @prompt.md` 실행을 수행한다.

## 2. 범위

### 2.1 1차 구현 범위

- 전역 cron daemon
  - Pi 세션과 분리된 detached Node 프로세스.
  - Pi 종료, `/reload`, 세션 전환 이후에도 계속 실행.
  - macOS `launchd` LaunchAgent로 등록해 재부팅/재로그인 후에도 자동으로 다시 실행.
- 전역 job 저장소
  - `~/.pi/agent/cron/jobs.json`
  - `~/.pi/agent/cron/prompts/<jobId>.md`
  - `~/.pi/agent/cron/daemon.pid`
  - `~/.pi/agent/cron/daemon.log`
  - `~/Library/LaunchAgents/dev.pi.cron.plist`
  - `~/.pi/agent/cron/runs/<jobId>/<timestamp>.log`
- `cron` LLM tool
  - 에이전트가 자연어 요청을 해석한 뒤 직접 job 추가/수정/목록/상태/실행 가능.
- `/cron` command
  - 사용자가 수동으로 daemon 관리 및 목록 확인 가능.
- 전용 Markdown 프롬프트 파일 생성
  - 에이전트가 현재 대화 맥락을 요약/고정해 prompt markdown을 만들고 job에 연결.
- job 실행
  - daemon이 스케줄에 맞춰 `pi -p --no-session --no-extensions @prompt.md`를 해당 job의 `cwd`에서 실행.
- 1회용 작업 지원
  - `at` / `delay` 작업과 `once: true`로 등록된 cron 작업은 실행 후 자동으로 `enabled: false` 처리한다.
  - 삭제하지 않고 남겨 두어 나중에 `/cron list --all` 또는 `cron list`로 실행 이력을 확인할 수 있게 한다.
- 삭제 보호
  - 크론잡 삭제는 반드시 사용자 confirm 필요.

### 2.2 1차 제외 범위

- Web dashboard
  - 참고 구현에는 있지만 1차에서는 제외.
- 복잡한 timezone UI
  - 기본은 로컬 타임존. job에는 생성 시점의 timezone 문자열만 기록.
- Slack/Email notification 직접 연동
  - 1차는 run log 저장과 Pi 출력 캡처만 수행.

## 3. 사용자 경험

### 3.1 자연어 등록 흐름

사용자:

```text
방금 나랑 한 릴리즈 체크를 매일 아침 10시에 실행되게 해줘
```

에이전트 동작:

1. 현재 세션에서 필요한 맥락을 추출한다.
2. `cron` tool의 `upsert` 액션을 호출한다.
3. tool은 job metadata와 prompt markdown 파일을 생성한다.
4. daemon이 꺼져 있으면 tool 결과에서 `/cron start` 필요 여부를 알려준다.
5. 사용자는 이후 `/cron list` 또는 자연어로 등록 상태를 확인할 수 있다.

중요: 사용자는 crontab 문법을 몰라도 된다. 모델이 자연어를 cron expression / one-shot time으로 변환한다. “한 번만”, “1회만”, “다음 배포 때만” 같은 표현은 `once: true` 또는 `kind: "at" | "delay"`로 등록하고, 실행 후 자동 비활성화한다.

### 3.2 프롬프트 Markdown 예시

`~/.pi/agent/cron/prompts/release-check-daily.md`

```md
# Cron Job: release-check-daily

## 목적

매일 아침 10시에 릴리즈 체크를 수행한다.

## 실행 기준

- 현재 working directory: `/path/to/repo`
- 대상 브랜치: `development`
- 확인할 항목:
  - 어제 이후 머지된 PR 목록
  - 실패한 CI
  - Sentry 급증 이슈
  - 배포 전 수동 검증 항목

## 원본 대화 요약

사용자와 이전 세션에서 릴리즈 체크리스트를 정리했고, 그 내용을 매일 반복 실행하기로 했다.

## 수행 지침

1. 필요한 파일과 git 상태를 확인한다.
2. 가능한 자동 검증은 직접 실행한다.
3. 결과를 간결한 체크리스트로 요약한다.
4. 실패/위험 항목은 맨 위에 표시한다.
```

### 3.3 삭제 confirm

사용자:

```text
아까 만든 release-check 크론 지워줘
```

에이전트:

- `cron` tool `remove` 호출.
- tool 내부에서 `ctx.ui.confirm("Cron job 삭제", "release-check를 삭제할까요?")` 실행.
- 사용자가 승인한 경우에만 삭제.
- `ctx.hasUI === false`인 환경에서는 기본적으로 삭제를 거부한다.
  - 예외가 필요하면 `force: true` 같은 파라미터를 만들 수 있지만 1차에서는 제공하지 않는다.

## 4. 파일 구조

```text
/Users/creatrip/.pi/agent/extensions/cron/
├── index.ts                 # extension entrypoint: command/tool registration
├── daemon.mjs               # detached scheduler daemon entrypoint
├── types.ts                 # CronJob, RunRecord 등 타입
├── store.ts                 # jobs.json + prompt md CRUD
├── schedule.ts              # cron/at/delay parsing + nextRun 계산
├── daemon-client.ts         # start/stop/status PID helpers
├── launchd.ts               # macOS LaunchAgent install/uninstall/status helpers
├── render.ts                # tool result rendering, formatting helpers
├── IMPLEMENTATION_PLAN.md   # 이 문서
└── README.md                # 사용법
```

## 5. 데이터 모델

```ts
interface CronJob {
  id: string;
  name: string;
  enabled: boolean;
  kind: "cron" | "at" | "delay";
  once: boolean;           // true면 실행 후 자동 비활성화. at/delay는 항상 true
  schedule?: string;       // cron: "0 10 * * *"
  runAt?: string;          // at/delay: ISO timestamp
  timezone: string;        // 기본: Intl.DateTimeFormat().resolvedOptions().timeZone
  cwd: string;
  promptFile: string;      // ~/.pi/agent/cron/prompts/<id>.md
  createdAt: string;
  updatedAt: string;
  lastRunAt?: string;
  nextRunAt?: string;
  running?: boolean;
  lastExitCode?: number;
  disabledReason?: "completed_once" | "user_disabled" | "error";
  completedAt?: string;
}
```

## 6. Tool 설계

### 6.1 tool 이름

`cron`

### 6.2 actions

- `list`
- `status`
- `upsert`
- `update`
- `remove`
- `enable`
- `disable`
- `run`
- `start_daemon`
- `stop_daemon`
- `install_launchd`
- `uninstall_launchd`

### 6.3 upsert 파라미터

```ts
{
  action: "upsert",
  id?: string,
  name: string,
  kind: "cron" | "at" | "delay",
  schedule?: string,
  runAt?: string,
  promptMarkdown: string,
  cwd?: string,
  enabled?: boolean,
  once?: boolean
}
```

에이전트는 자연어를 해석해 `kind`, `schedule`/`runAt`, `promptMarkdown`를 채운다. `kind: "at" | "delay"`는 항상 1회용으로 저장하고, `kind: "cron"`이라도 사용자가 “한 번만”을 의도하면 `once: true`로 저장한다.

### 6.4 promptGuidelines

tool 등록 시 system prompt에 다음 지침을 추가한다.

- 사용자가 자연어로 반복/예약 실행을 요청하면 `cron` tool을 사용한다.
- “방금 한 것”, “이 작업”, “아까 정리한 것”처럼 현재 세션 맥락을 참조하면, 실행 시점에 필요한 정보를 `promptMarkdown`에 자급자족 형태로 요약해 저장한다.
- 크론잡 삭제는 사용자 confirm 없이는 수행하지 않는다.
- “한 번만”, “1회만”, “다음 실행 후 멈춰” 같은 요청은 삭제가 아니라 실행 후 자동 비활성화(`once: true`)로 처리한다.
- schedule은 표준 5-field cron expression을 사용한다.

## 7. Command 설계

```text
/cron                 # status
/cron start           # daemon 시작
/cron stop            # daemon 종료(confirm 필요 여부는 stop에는 불필요)
/cron install         # launchd LaunchAgent 등록 + 즉시 시작
/cron uninstall       # launchd 등록 해제(confirm 필요) + daemon stop 여부 선택
/cron list            # job 목록
/cron run <id>        # 즉시 실행
/cron remove <id>     # 삭제 confirm 후 삭제
/cron enable <id>
/cron disable <id>
```

## 8. Daemon 설계

### 8.1 시작

`/cron start` 또는 `cron` tool `start_daemon`이 다음을 수행한다.

1. `daemon.pid` 확인.
2. PID가 살아 있으면 이미 실행 중으로 처리.
3. stale PID면 제거.
4. `node daemon.mjs` detached spawn.
5. daemon log에 stdout/stderr append.

### 8.1.1 launchd 등록

`/cron install` 또는 `cron` tool `install_launchd`가 다음을 수행한다.

1. `~/Library/LaunchAgents/dev.pi.cron.plist` 생성.
2. `ProgramArguments`는 현재 Node executable과 `extensions/cron/daemon.mjs` 절대 경로를 사용한다.
3. `WorkingDirectory`는 `/Users/creatrip/.pi/agent`로 설정한다.
4. `StandardOutPath` / `StandardErrorPath`는 `~/.pi/agent/cron/daemon.log` 및 `daemon.err.log`로 설정한다.
5. `RunAtLoad: true`, `KeepAlive: true`로 설정한다.
6. `launchctl bootstrap gui/$UID <plist>` 후 `launchctl kickstart -k gui/$UID/dev.pi.cron`으로 즉시 시작한다.
7. 이미 등록되어 있으면 plist를 갱신하고 reload한다.

`/cron uninstall`은 LaunchAgent를 제거한다. 재부팅 지속 실행 설정을 삭제하는 작업이므로 사용자 confirm을 받는다.

### 8.2 tick

- 30초 간격 tick.
- `jobs.json` mtime 변경 시 reload.
- job별 `nextRunAt` 계산.
- 같은 job이 이미 실행 중이면 skip.
- 실행 완료 후 `lastRunAt`, `nextRunAt`, `lastExitCode` 갱신.
- 1회용 작업 처리:
  - `kind: "at" | "delay"` job은 항상 1회 실행 후 `enabled: false`, `disabledReason: "completed_once"`, `completedAt`을 기록한다.
  - `kind: "cron"` job도 `once: true`면 첫 실행 후 같은 방식으로 비활성화한다.
  - 비활성화된 작업은 삭제하지 않는다. 목록/상세 조회에서 이력으로 확인 가능해야 한다.

### 8.3 실행 명령

기본:

```bash
pi -p --no-session --no-extensions @/Users/creatrip/.pi/agent/cron/prompts/<id>.md
```

옵션:

- `cwd`: job에 저장된 cwd.
- timeout: 기본 10분.
- stdout/stderr는 `runs/<jobId>/<timestamp>.log`에 저장.

## 9. 안전 정책

- 1회용 작업은 실행 후 삭제하지 않고 자동 비활성화한다.
- 삭제는 항상 사용자 confirm 필요.
- `remove` tool은 `ctx.hasUI === false`이면 거부한다.
- prompt file path는 반드시 cron prompts 디렉터리 내부로 normalize한다.
- job id는 slug로 제한한다.
  - 허용: `[a-zA-Z0-9._-]`
- daemon은 jobs.json 외부 경로를 임의 실행하지 않는다.
- promptMarkdown은 파일로 저장하되, 실행은 `@prompt.md` 인자로만 전달한다.
- daemon은 lock/PID로 단일 인스턴스만 허용한다.

## 10. 구현 태스크

### Task 1: 타입과 저장소

파일:

- 생성: `extensions/cron/types.ts`
- 생성: `extensions/cron/store.ts`

내용:

- `CronJob`, `CronStore` 타입 정의.
- `once`, `disabledReason`, `completedAt` 필드 포함.
- `~/.pi/agent/cron` 디렉터리 생성.
- `jobs.json` read/write.
- prompt markdown 파일 write/read.
- job id slug 검증.

검증:

```bash
cd /Users/creatrip/.pi/agent/extensions
pnpm run typecheck
```

### Task 2: schedule parser

파일:

- 생성: `extensions/cron/schedule.ts`

내용:

- 5-field cron parser.
- `validateCron(expr)`.
- `nextRun(expr, from)`.
- `at`/`delay` ISO runAt 처리.

참고:

- `espennilsen/pi-cron/src/scheduler.ts`의 parseField/matchesCron 아이디어 활용.

### Task 3: daemon client

파일:

- 생성: `extensions/cron/daemon-client.ts`

내용:

- PID file 관리.
- stale PID 제거.
- detached daemon spawn.
- stop/status helpers.

### Task 3.5: launchd helpers

파일:

- 생성: `extensions/cron/launchd.ts`

내용:

- LaunchAgent plist 생성/삭제.
- `launchctl bootstrap/bootout/kickstart/print` 래퍼.
- 등록 상태 확인.
- `/cron uninstall` 및 `uninstall_launchd` tool action에서 사용자 confirm 연결.

### Task 4: daemon

파일:

- 생성: `extensions/cron/daemon.mjs`

내용:

- jobs.json 로드.
- 30초 tick.
- due job 실행.
- `pi -p --no-session --no-extensions @prompt.md` spawn.
- run log 저장.
- jobs.json 상태 갱신.
- 1회용 작업 실행 후 자동 비활성화 처리.

### Task 5: extension entrypoint

파일:

- 생성: `extensions/cron/index.ts`

내용:

- `pi.registerTool({ name: "cron", ... })`.
- `pi.registerCommand("cron", ...)`.
- 삭제 confirm 구현.
- tool result 표시.
- session_start에서 daemon status footer 표시.

### Task 6: README

파일:

- 생성: `extensions/cron/README.md`
- 수정: `extensions/README.md` 대표 확장 목록에 `cron/` 추가.

내용:

- 자연어 등록 예시.
- `/cron` 사용법.
- 저장 파일 위치.
- daemon 주의사항.
- launchd 설치/해제 방법과 재부팅 후 자동 실행 정책.

### Task 7: 검증

명령:

```bash
cd /Users/creatrip/.pi/agent/extensions
pnpm run typecheck
pnpm exec biome check cron
```

Pi 로딩 검증:

```bash
cd /Users/creatrip/.pi/agent
PI_OFFLINE=1 pi -p --no-session --no-tools --offline -e extensions/cron/index.ts "cron extension load check"
```

수동 시나리오:

1. `/cron install`
2. `launchctl print gui/$UID/dev.pi.cron`으로 LaunchAgent 등록 확인
3. `/cron start`
4. 자연어: `1분 뒤에 테스트로 현재 시간 알려줘`
3. `/cron list`
4. run log 생성 확인
5. 1회용 작업이 실행 후 `enabled: false`, `disabledReason: completed_once`로 남아 있는지 확인
6. `/cron remove <id>`에서 confirm 뜨는지 확인
7. confirm cancel 시 삭제되지 않는지 확인
8. confirm approve 시 삭제되는지 확인

## 11. 오픈 질문

1. 1차에서 `--no-extensions`로 실행할지, 현재 설치된 extensions 일부를 허용할지?
   - 추천: 기본 `--no-extensions`, job별 `extraExtensions`는 2차.
2. job 성공 결과를 어디에 노출할지?
   - 추천: 1차는 run log 파일 저장만. 알림/Slack은 2차.
3. launchd `KeepAlive` 정책을 항상 켤지?
   - 현재 계획: 재부팅 후 계속 수행 요구사항에 맞춰 `RunAtLoad: true`, `KeepAlive: true` 기본.
