# Subagent Extension

`extensions/subagent/` is Pi's **delegation engine**.

It lets the main agent say:
- "start another agent and let it work separately"
- "run several agents in parallel"
- "run a pipeline where step 2 sees step 1's output"
- "don't poll manually; wait for async follow-up"

This README explains the **implementation philosophy**, the **runtime model**, and the **module structure** in practical terms.

---

## 1. What problem this extension solves

The main Pi agent is good at orchestration, but sometimes you want:
- isolated context windows
- different agent roles (`worker`, `reviewer`, `verifier`, ...)
- parallel work
- sequential pipelines
- long-running work that reports back later

The subagent extension provides that layer.

In one sentence:

> The main agent stays the conductor; subagents are temporary workers launched as separate `pi` processes.

---

## 2. Core philosophy

There are a few strong design choices behind this module.

### 2.1 Separate process, not shared brain

A subagent is **not** just a function call inside the main agent.
It is launched as a **separate `pi` process**.

Why?
- isolated context window
- isolated turn flow
- isolated tool usage
- reduced instruction contamination
- easier async lifecycle management

ASCII view:

```text
Main Agent Session
    |
    | subagent tool / command
    v
+-------------------------+
| Subagent Extension      |
| - parse CLI             |
| - register run state    |
| - spawn child process   |
+-------------------------+
    |
    v
+-------------------------+
| Separate `pi` process   |
| (subagent run)          |
+-------------------------+
```

---

### 2.2 CLI outside, structured state inside

Externally, the interface is intentionally simple:

```ts
{ command: "subagent ..." }
```

Examples:

```text
subagent run worker -- 로그인 버그 수정
subagent batch --main --agent worker --task "A" --agent reviewer --task "B"
subagent chain --main --agent worker --task "구현" --agent reviewer --task "리뷰"
```

But internally, the extension does **not** run raw strings directly.
It parses CLI text into structured forms such as:
- single run params
- batch `runs[]`
- chain `steps[]`

That split is important:

```text
LLM / User
  -> "subagent batch --main --agent ... --task ..."
  -> cli.ts parses it
  -> tool-execute.ts receives structured params
  -> runtime orchestration uses typed state
```

So the interface stays convenient, but execution stays deterministic.

---

### 2.3 Follow-up driven, not polling driven

Subagent work is fundamentally async.
The main agent should not sit there doing:

```text
run -> status -> status -> detail -> status -> ...
```

Instead, the model is:

```text
launch -> end turn -> wait for automatic follow-up
```

That is why the extension has:
- strong CLI help text about not polling
- anti-polling cooldown guards
- `pendingCompletion` handling
- origin-session recovery for deferred follow-ups

ASCII view:

```text
GOOD FLOW
---------
main agent
   |
   | launch subagent
   v
(wait)
   |
   v
automatic follow-up arrives

BAD FLOW
--------
launch
  -> status
  -> status
  -> detail
  -> status
  -> confusion / noisy turns
```

---

### 2.4 Reference is reference, instruction is instruction

This is one of the most important ideas in the implementation.

When the subagent gets main-session context or previous pipeline-step output, the extension tries to keep clear boundaries:
- **history/reference** is not authoritative
- **current request** is authoritative

That is why prompts use sections such as:
- `[HISTORY — REFERENCE ONLY]`
- `[PIPELINE PREVIOUS STEP — REFERENCE ONLY]`
- `[REQUEST — AUTHORITATIVE]`

The goal is to reduce this class of failure:

```text
Previous output contained an imperative sentence
-> next agent mistakes it for a direct command
-> pipeline semantics become fuzzy
```

---

## 3. High-level architecture

The easiest way to understand the module is as 4 layers.

```text
+------------------------------------------------------+
| 1. Interface Layer                                   |
|    cli.ts / commands.ts / tool-render.ts             |
+------------------------------------------------------+
| 2. Orchestration Layer                               |
|    tool-execute.ts / run-utils.ts / retry.ts         |
+------------------------------------------------------+
| 3. Execution + Context Layer                         |
|    runner.ts / session.ts / agents.ts                |
+------------------------------------------------------+
| 4. State + Recovery Layer                            |
|    store.ts / group-pending.ts / commands.ts         |
+------------------------------------------------------+
```

### 3.1 Interface layer
Responsible for:
- parsing `subagent ...` commands
- slash commands like `/sub:*`
- rendering tool call/result output
- user-facing help text

Main files:
- `cli.ts`
- `commands.ts`
- `tool-render.ts`

### 3.2 Orchestration layer
Responsible for:
- deciding what kind of launch this is
- single / batch / chain execution
- concurrency guards
- anti-polling enforcement
- packaging final follow-up messages

Main files:
- `tool-execute.ts`
- `run-utils.ts`
- `retry.ts`

### 3.3 Execution + context layer
Responsible for:
- discovering agent definitions
- wrapping prompt/context safely
- spawning child `pi` processes
- reading final text/tool-call output

Main files:
- `agents.ts`
- `session.ts`
- `runner.ts`

### 3.4 State + recovery layer
Responsible for:
- in-memory run/group state
- widget-visible state
- deferred completion handling
- durable storage for finished grouped summaries

Main files:
- `store.ts`
- `group-pending.ts`
- parts of `commands.ts`

---

## 4. Main execution modes

## 4.1 Single run

```text
subagent run worker -- <task>
subagent continue 22 -- <task>
```

Mental model:

```text
main agent
   |
   | single launch
   v
+-------------------+
| run #22           |
| agent: worker     |
| status: running   |
+-------------------+
   |
   v
completed / failed / escalated follow-up
```

Use this when you want one delegated task.

---

## 4.2 Batch

```text
subagent batch --main \
  --agent worker --task "A" \
  --agent reviewer --task "B" \
  --agent verifier --task "C"
```

Mental model:

```text
               +--> run #1 (worker)
main agent --> |
               +--> run #2 (reviewer)
               |
               +--> run #3 (verifier)

all 3 finish
     |
     v
[group summary follow-up once]
```

Important behavior:
- runs start independently
- completion is collected at **group** level
- user-visible follow-up is now **group-oriented**, not per-member noisy telemetry
- if the origin session is not active, the final grouped summary can be deferred and recovered later

Batch is for **independent work**.
It is not a pipeline.

---

## 4.3 Chain

```text
subagent chain --main \
  --agent worker --task "구현" \
  --agent reviewer --task "리뷰" \
  --agent worker --task "리뷰 반영"
```

Mental model:

```text
step 1 output
     |
     v
step 2 sees step 1 as REFERENCE ONLY
     |
     v
step 3 sees step 2 as REFERENCE ONLY
     |
     v
[chain summary follow-up once]
```

More explicit ASCII:

```text
+---------+      +---------+      +---------+
| step 1  | ---> | step 2  | ---> | step 3  |
| worker  |      | reviewer|      | worker  |
+---------+      +---------+      +---------+
     |                |                |
     +----------------+----------------+
                      |
                      v
              grouped chain summary
```

Chain is for **dependent work**.
Only one step runs at a time.

---

## 5. How context flows

This is the part people usually get confused about.

## 5.1 Main context inheritance

If you use `--main`, the extension does **not** simply clone the whole main session and let the child impersonate the main agent.

Instead it builds a wrapped task with sections like:

```text
[GENERAL INSTRUCTION — AUTHORITATIVE]
...

[HISTORY — REFERENCE ONLY]
[Main Session Context]
...

[HISTORY SOURCE — REFERENCE ONLY]
Main agent session JSONL path: ...

[REQUEST — AUTHORITATIVE]
<actual task>
```

This is the reason `session.ts` is so important.
Its job is not just file paths — it is **instruction-boundary safety**.

---

## 5.2 Chain previous-step handoff

For later chain steps, previous output is injected as a dedicated reference section.

ASCII prompt shape:

```text
[GENERAL INSTRUCTION — AUTHORITATIVE]
...

[HISTORY — REFERENCE ONLY]
(main session context if --main)

[PIPELINE PREVIOUS STEP — REFERENCE ONLY]
Agent: worker
Task: 로그인 API 구현
Output:
...

[REQUEST — AUTHORITATIVE]
위 결과를 리뷰해라.
```

That means:
- the next agent **can read the previous output**
- but the previous output is **not treated as the new command**

This boundary was an intentional design point and an explicit bug-fix area during recent batch/chain work.

---

## 6. State model

There are two kinds of state in this extension:

### 6.1 In-memory live state
Stored in `store.ts`.

Examples:
- `commandRuns`
- `globalLiveRuns`
- `recentLaunchTimestamps`
- `batchGroups`
- `pipelines`

ASCII view:

```text
store.ts
  |
  +-- commandRuns          # visible run states
  +-- globalLiveRuns       # live processes across session switches
  +-- batchGroups          # in-memory batch aggregation
  +-- pipelines            # in-memory chain aggregation
  +-- recentLaunchTimestamps # anti-polling cooldown
```

This is the active runtime brain.

---

### 6.2 Durable pending grouped summaries
Stored in `group-pending.ts`.

This is a narrower layer.
It does **not** try to persist everything.
It only persists:

> finished batch/chain summaries that still need to be delivered to the origin session.

That means it helps with:
- grouped summary delivery after reload / session return
- stale eviction based on pending age

It explicitly does **not** do:
- in-flight chain resume
- in-flight batch orchestration resume

This limitation is intentional.

ASCII view:

```text
In-memory orchestration
   |
   | group finishes while origin session is elsewhere
   v
pending grouped summary
   |
   +--> memory map (fast path)
   |
   +--> group-pending.ts file (durable fallback)
             |
             v
      origin session returns
             |
             v
      deliver grouped summary
```

---

## 7. Recovery philosophy

Subagent recovery is deliberately split into two categories.

### 7.1 What we try to recover
- visible run state after session switch
- deferred single-run follow-ups
- deferred batch summary follow-ups
- deferred chain summary follow-ups

### 7.2 What we do **not** try to recover
- resuming an in-flight chain after reload/restart
- restarting batch orchestration from the middle
- reconstructing a half-finished pipeline and continuing execution automatically

Why not?
Because these are much harder correctness problems:
- was the child process still alive?
- did the previous summary already get sent?
- should the next step be retried or not?
- would resume create duplicate execution?

So the design decision is:

```text
recover completed summaries
YES

resume half-finished orchestration automatically
NO
```

That trade-off keeps the system understandable and avoids silent double-execution.

---

## 8. Notification philosophy

Recent UX changes simplified grouped notifications.

### 8.1 Single run
Still behaves like a normal run lifecycle:
- start message / launch result
- final completion/failure follow-up

### 8.2 Batch / Chain
Now behaves at **group level**.

For batch/chain, the user-facing goal is:
- one start indication from the launch result
- one final grouped summary
- error reflected in grouped summary
- no noisy per-member started/completed follow-ups

ASCII comparison:

```text
OLD
---
member 1 started
member 2 started
member 1 completed
member 2 completed
batch summary

NEW
---
(batch launch result)
...
batch summary
```

Same idea for chain.
This makes the main session much easier to read.

---

## 9. Anti-polling guard

The extension actively discourages polling.

Mechanism:
- a launch timestamp is stored in `recentLaunchTimestamps`
- if the main agent immediately asks for `status` or `detail`
- and the run is still within cooldown
- the extension refuses and tells the caller to wait for automatic follow-up

ASCII:

```text
launch run #12
   |
   +-- immediate status/detail?
           |
           +-- yes -> blocked by cooldown guard
           |
           +-- no  -> wait for follow-up
```

This is one of the keys to keeping async delegation usable.

---

## 10. File-by-file guide

### `index.ts`
Top-level orchestrator.
- creates store
- registers everything
- runs periodic hang detection

### `cli.ts`
Parses CLI-style commands.
- `run`
- `continue`
- `batch`
- `chain`
- `status`
- `detail`
- `abort`
- `remove`

### `commands.ts`
Huge integration layer.
- tool registration
- slash commands
- session restore
- pending completion delivery
- widgets and UI interactions

### `tool-execute.ts`
The heart of tool-mode orchestration.
- anti-polling
- single run launches
- batch launches
- chain launches
- final grouped summaries

### `runner.ts`
Actually spawns the child `pi` process and collects structured output.

### `session.ts`
Builds safe prompt wrappers.
- main context injection
- pipeline reference section construction
- task/history separation

### `store.ts`
Shared in-memory state.

### `group-pending.ts`
Durable storage for **finished grouped summaries waiting for delivery**.

### `types.ts`
Shared types and Typebox schemas.

### `widget.ts` / `above-widget.ts`
UI status surfaces.

### `run-utils.ts`
Helpers for summaries, cleanup, removal, trimming.

### `retry.ts`
Auto-retry support for command-driven runs.

### `invocation-queue.ts`
Paces launches so they do not all start at the exact same instant.
Important detail:
- it paces **start times**
- it does **not** force all running tasks to be sequential

---

## 11. Typical flow examples

### 11.1 Single run flow

```text
subagent run worker -- 버그 수정
   |
   v
cli.ts parses
   |
   v
tool-execute.ts registers run state
   |
   v
runner.ts spawns child pi process
   |
   v
result captured
   |
   v
follow-up delivered to origin session
```

### 11.2 Batch flow

```text
subagent batch ...
   |
   v
cli.ts -> runs[]
   |
   v
tool-execute.ts creates batchGroup
   |
   +--> child run 1
   +--> child run 2
   +--> child run 3
   |
   v
collect results in batchGroups.completedRunIds
   |
   v
emit one grouped batch summary
   |
   +--> if origin session active: send now
   |
   +--> else: persist pending grouped summary
```

### 11.3 Chain flow

```text
subagent chain ...
   |
   v
cli.ts -> steps[]
   |
   v
tool-execute.ts creates pipeline state
   |
   v
step 1 runs
   |
   v
step 1 output -> pipeline reference section
   |
   v
step 2 runs
   |
   v
step 2 output -> next reference section
   |
   v
final grouped chain summary
```

---

## 12. Known limitations

These are important to say out loud.

### Supported
- async single run delegation
- grouped batch completion summaries
- grouped chain completion summaries
- chain previous-step reference handoff
- deferred grouped summary recovery

### Not supported
- in-flight chain resume after reload/restart
- automatic continuation of half-finished batch/chain orchestrators
- full durable replay of every internal orchestration decision

If you are modifying this module, keep those boundaries in mind.
A lot of bugs happen when a developer assumes the system is stronger than its actual contract.

---

## 13. If you want to modify this module safely

Recommended reading order:

```text
1. README.md           <- this file
2. cli.ts              <- external command model
3. types.ts            <- shared shapes
4. tool-execute.ts     <- actual orchestration logic
5. session.ts          <- context safety rules
6. commands.ts         <- restore / UI / pending delivery behavior
7. group-pending.ts    <- durable grouped summary recovery
8. runner.ts           <- child process execution details
```

Recommended rule of thumb:

```text
If changing execution semantics:
  check cli.ts + tool-execute.ts + types.ts + commands.ts

If changing prompt/context semantics:
  check session.ts + tool-execute.ts

If changing recovery semantics:
  check store.ts + commands.ts + group-pending.ts
```

---

## 14. Short mental summary

If you remember only one diagram, remember this one:

```text
                 +----------------------+
                 | Main Agent           |
                 | decides / delegates  |
                 +----------+-----------+
                            |
                            v
                 +----------------------+
                 | Subagent Extension    |
                 | parse / orchestrate   |
                 | track / recover       |
                 +----------+-----------+
                            |
            +---------------+----------------+
            |                                |
            v                                v
   +------------------+             +------------------+
   | Single Run       |             | Grouped Runs     |
   | run / continue   |             | batch / chain    |
   +------------------+             +------------------+
            |                                |
            v                                v
   child `pi` process                 child `pi` process(es)
            |                                |
            v                                v
     final follow-up                grouped final summary
```

And the philosophy:

> isolate execution, preserve instruction boundaries, avoid polling, and recover finished summaries — but do not pretend in-flight orchestration can always be resumed safely.
