# cron extension

Persistent scheduler for Pi.

## What it does

- Lets the agent register scheduled work from natural language.
- Stores each job as metadata plus a self-contained Markdown prompt.
- Runs jobs through a headless Pi process: `pi -p --no-session --no-extensions @prompt.md`.
- Uses a detached daemon and macOS `launchd` LaunchAgent so jobs continue after Pi exits and after reboot/login.
- Keeps one-shot jobs as disabled history after they run.
- Requires user confirmation before deleting jobs. LaunchAgent uninstall can be explicitly confirmed with `cron uninstall-launchd --yes`.

## Files

```text
~/.pi/agent/cron/jobs.json
~/.pi/agent/cron/prompts/<jobId>.md
~/.pi/agent/cron/runs/<jobId>/<timestamp>.log
~/.pi/agent/cron/daemon.pid
~/.pi/agent/cron/daemon.log
~/Library/LaunchAgents/dev.pi.cron.plist
```

## Natural language examples

```text
방금 나랑 한 릴리즈 체크를 매일 아침 10시에 실행되게 해줘
2시간 뒤에 방금 정리한 QA 체크리스트 다시 확인해줘
다음 배포 30분 뒤에 한 번만 상태 확인해줘
매주 월요일 오전 9시에 PR 리뷰 상태 요약해줘
```

The LLM-facing `cron` tool intentionally exposes only one parameter: `command`. Agents should call `cron help` when they need the grammar, then pass a CLI-style command string. Scheduled prompts must be self-contained because headless runs do not have access to the original session history.

## Tool commands

```text
cron help
cron status
cron list [--include-prompt]
cron upsert [<id>] --name <name> --kind <cron|at|delay> (--schedule <expr>|--run-at <iso>) [--cwd <path>] [--enabled <true|false>] [--once] -- <promptMarkdown>
cron update <id> [--name <name>] [--kind <cron|at|delay>] [--schedule <expr>] [--run-at <iso>] [--cwd <path>] [--enabled <true|false>] [--once|--once=false] [-- <promptMarkdown>]
cron run <id>
cron enable <id>
cron disable <id>
cron remove <id>       # confirm required
cron start-daemon      # alias: cron start
cron stop-daemon       # alias: cron stop
cron install-launchd   # alias: cron install
cron uninstall-launchd [--yes] # --yes skips extra UI confirm; alias: cron uninstall
```

Human-facing slash commands are still available for convenience:

```text
/cron status
/cron install       # install launchd LaunchAgent and start daemon
/cron uninstall     # confirm, then remove LaunchAgent (`/cron uninstall --yes` skips extra UI confirm)
/cron start         # start daemon for current boot
/cron stop          # stop daemon
/cron list
/cron run <id>
/cron remove <id>   # confirm required
/cron enable <id>
/cron disable <id>
```

## One-shot jobs

`kind: "at"` and `kind: "delay"` are always one-shot. A `kind: "cron"` job can also be one-shot with `once: true`.

After a one-shot job runs, it is not deleted. It is updated with:

```json
{
  "enabled": false,
  "disabledReason": "completed_once",
  "completedAt": "..."
}
```

This keeps the job visible for later audit while preventing future execution.

## Safety

- Removing a job requires `ctx.ui.confirm()`.
- Uninstalling launchd requires `ctx.ui.confirm()` unless explicitly confirmed with `--yes`.
- In non-UI contexts, destructive actions are denied by default.
- Job IDs are restricted to `[a-zA-Z0-9._-]`.
- Prompt files are written only under `~/.pi/agent/cron/prompts/`.
