---
name: interactive-shell
description: Local guide for using interactive_shell in this repo. Prefer it for dev servers, TUI apps, REPLs, database shells, log viewers, and commands that need a visible terminal overlay. Do not use it for subagent-style delegation; use the subagent tool for that.
---

# Interactive Shell (Project-local Skill)

Last verified: 2026-04-03

> Local note: this project vendors the extension under `extensions/interactive-shell/`. Treat it as a repo-local skill/extension, not a separately installed package.

## What this skill is for

In this project, `interactive_shell` is mainly for:
- **개발 서버 실행** (`pnpm dev`, `npm run dev`, `vite`, `next dev`, etc.)
- **TUI 보여주기** (`lazygit`, `htop`, DB shell, interactive CLI menus)
- **REPL / 콘솔 / 로그 tail 보기**
- **일반 bash로 돌리면 불편하거나 깨지는 인터랙티브 프로그램 실행**

## What this skill is NOT for

Do **not** frame `interactive_shell` as a subagent/delegation tool in this repo.

If the goal is:
- another coding agent doing a task,
- structured delegation,
- hidden/background AI worker execution,

use the **`subagent` tool** instead.

`interactive_shell` here is for **terminal UX and process supervision**, not subagent orchestration.

## Preferred mode by use case

### 1) Interactive — for TUI / direct user interaction
Use when the user should directly see and possibly control the program.

Good for:
- `lazygit`
- `htop`
- `python`
- `node`
- `psql`
- `sqlite3`
- `git rebase -i`
- any curses/full-screen TUI

```typescript
interactive_shell({ command: 'lazygit' })
interactive_shell({ command: 'psql -d mydb' })
interactive_shell({ command: 'python' })
```

This is the default mode.

---

### 2) Hands-Free — for dev servers you want to watch
Use when starting a long-running process and then checking its output later.

Good for:
- `pnpm dev`
- `npm run dev`
- `vite`
- `next dev`
- `docker compose up`
- `tail -f ...`

```typescript
interactive_shell({
  command: 'pnpm dev',
  mode: 'hands-free',
  reason: 'Run local dev server'
})
```

Then later:

```typescript
interactive_shell({ sessionId: 'calm-reef' })
interactive_shell({ sessionId: 'calm-reef', outputLines: 50 })
interactive_shell({ sessionId: 'calm-reef', kill: true })
```

Use this as the **default** for dev servers when you want the overlay visible and the process queryable.

---

### 3) Dispatch / background — only for process lifecycle, not delegation
This can still be useful for **headless long-running processes**, but do not describe it as subagent delegation.

Good for:
- starting a server without keeping the overlay open
- launching a log tail or watcher in background
- starting a process and getting notified when it exits

```typescript
interactive_shell({
  command: 'pnpm dev',
  mode: 'dispatch',
  background: true,
  reason: 'Run local dev server headlessly'
})
```

Use this for **process management**, not “ask another agent to do work”.

## Common workflows

## A. Start a dev server and inspect logs

```typescript
interactive_shell({
  command: 'pnpm dev',
  mode: 'hands-free',
  reason: 'Frontend dev server'
})
```

Check output later:

```typescript
interactive_shell({ sessionId: 'calm-reef' })
interactive_shell({ sessionId: 'calm-reef', outputLines: 100, outputMaxChars: 30000 })
```

Stop it:

```typescript
interactive_shell({ sessionId: 'calm-reef', kill: true })
```

---

## B. Open a TUI for the user to inspect

```typescript
interactive_shell({ command: 'lazygit' })
interactive_shell({ command: 'htop' })
interactive_shell({ command: 'git rebase -i HEAD~3' })
```

Use **interactive mode** here so the user can watch and take over naturally.

---

## C. Open a database shell / REPL

```typescript
interactive_shell({ command: 'psql -d app' })
interactive_shell({ command: 'sqlite3 dev.db' })
interactive_shell({ command: 'node' })
interactive_shell({ command: 'python' })
```

Again, prefer **interactive mode** unless there is a strong reason to poll from the agent side.

---

## D. Reattach to a backgrounded process

```typescript
interactive_shell({ listBackground: true })
interactive_shell({ attach: 'calm-reef' })
interactive_shell({ dismissBackground: 'calm-reef' })
```

## Querying output

Status queries return **rendered terminal output** (what is actually on screen), not raw PTY bytes.

Defaults:
- `outputLines`: 20
- `outputMaxChars`: 5KB

Useful patterns:

```typescript
interactive_shell({ sessionId: 'calm-reef' })
interactive_shell({ sessionId: 'calm-reef', outputLines: 50 })
interactive_shell({ sessionId: 'calm-reef', outputLines: 100, outputMaxChars: 30000 })
interactive_shell({ sessionId: 'calm-reef', incremental: true, outputLines: 50 })
```

Use `incremental: true` when reading long scrollback progressively.

## Sending input

```typescript
interactive_shell({ sessionId: 'calm-reef', input: '/help\n' })
interactive_shell({ sessionId: 'calm-reef', inputKeys: ['ctrl+c'] })
interactive_shell({ sessionId: 'calm-reef', inputPaste: 'line1\nline2\nline3' })
interactive_shell({ sessionId: 'calm-reef', input: 'y', inputKeys: ['enter'] })
```

### Common named keys
- `up`, `down`, `left`, `right`
- `enter`
- `escape`
- `tab`, `shift+tab`
- `backspace`
- `ctrl+c`, `ctrl+d`, `ctrl+z`

## Background session management

```typescript
interactive_shell({ sessionId: 'calm-reef', background: true })
interactive_shell({ listBackground: true })
interactive_shell({ attach: 'calm-reef' })
interactive_shell({ attach: 'calm-reef', mode: 'hands-free' })
interactive_shell({ attach: 'calm-reef', mode: 'dispatch' })
interactive_shell({ dismissBackground: true })
interactive_shell({ dismissBackground: 'calm-reef' })
```

## Safe TUI capture

Never use plain `bash` for a truly interactive/TUI app when you actually need terminal behavior.

If you only need a quick capture from a TUI-ish command that does not exit cleanly, use `interactive_shell` with a timeout:

```typescript
interactive_shell({
  command: 'pi --help',
  mode: 'hands-free',
  timeout: 5000
})
```

Good for:
- `--help` output from TUI apps
- commands that animate or do terminal detection
- short-lived inspection of otherwise interactive commands

## Practical guidance for this repo

### Prefer `interactive_shell` when:
- you need to **show a terminal UI**
- you need to **start/monitor a dev server**
- you need to **interact with a REPL or shell**
- you want **attach/background/reattach** behavior

### Prefer `bash` when:
- command is simple and non-interactive
- you only need stdout/stderr once
- no overlay / no PTY semantics are needed

### Prefer `subagent` when:
- the task is really **delegation to another coding agent**
- you want structured worker/reviewer flows
- you want hidden/background AI execution rather than terminal supervision

## Recommended defaults

### Dev server
```typescript
interactive_shell({
  command: 'pnpm dev',
  mode: 'hands-free',
  reason: 'Run dev server'
})
```

### TUI tool
```typescript
interactive_shell({ command: 'lazygit' })
```

### Background server
```typescript
interactive_shell({
  command: 'pnpm dev',
  mode: 'dispatch',
  background: true,
  reason: 'Run dev server in background'
})
```

### Stop a running session
```typescript
interactive_shell({ sessionId: 'calm-reef', kill: true })
```
