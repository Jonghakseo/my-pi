# cron extension

Persistent scheduler for Pi.

## What it does

- Lets the agent register scheduled work from natural language.
- Stores each job as metadata plus a self-contained Markdown prompt.
- Runs jobs through a headless Pi process: `pi -p --no-session --no-extensions @prompt.md`.
- Uses a detached daemon and macOS `launchd` LaunchAgent so jobs continue after Pi exits and after reboot/login.
- Keeps one-shot jobs as disabled history after they run.
- Requires user confirmation before deleting jobs or uninstalling the LaunchAgent.

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

The agent should call the `cron` tool and include a self-contained `promptMarkdown`. This is important because scheduled runs are headless and do not have access to the original session history.

## Commands

```text
/cron status
/cron install       # install launchd LaunchAgent and start daemon
/cron uninstall     # confirm, then remove LaunchAgent
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
- Uninstalling launchd requires `ctx.ui.confirm()`.
- In non-UI contexts, destructive actions are denied by default.
- Job IDs are restricted to `[a-zA-Z0-9._-]`.
- Prompt files are written only under `~/.pi/agent/cron/prompts/`.
