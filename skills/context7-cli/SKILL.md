---
name: context7-cli
description: Use Context7 CLI (`ctx7`) from bash to look up library and framework documentation without MCP tools. Use when you need package docs grounding, API references, or example-driven answers from Context7.
compatibility: Requires bash plus either `ctx7` in PATH or `npx -y ctx7`; Node.js 18+ recommended.
---

# Context7 CLI

Last verified: 2026-04-06

## What this skill is for

Use this skill when you need Context7 documentation lookup but do **not** want MCP tool registration.

Typical cases:
- 라이브러리/프레임워크 공식 문서 기반 답변이 필요할 때
- 패키지 사용법, API, 버전별 예시를 빠르게 찾을 때
- searcher가 bash로 Context7를 직접 호출해야 할 때

## Preferred flow

1. **Check how to run Context7 CLI**
   - Prefer `ctx7` if it is already installed.
   - Otherwise retry with `npx -y ctx7`.
2. **Resolve the library ID**
   - Run `ctx7 library <name> [query]`
3. **Fetch docs with the resolved ID**
   - Run `ctx7 docs <library-id> <query>`
4. **Prefer JSON when machine-readable output helps**
   - Add `--json`
   - If JSON is malformed, sparse, or hard to parse, retry without `--json`
5. **Report fallback path clearly**
   - If Context7 fails, fall back to official docs / `web_search` / `fetch_content`
   - State that confidence is reduced

If you already know the exact library ID, skip `library` and go straight to `docs`.

## Command patterns

### 1) Check availability

```bash
ctx7 --help
```

If that fails:

```bash
npx -y ctx7 --help
```

### 2) Resolve a library ID

```bash
ctx7 library react
ctx7 library nextjs "app router authentication"
ctx7 library prisma "relations"
```

JSON mode:

```bash
ctx7 library react --json
```

### 3) Query docs

```bash
ctx7 docs /facebook/react "useEffect cleanup"
ctx7 docs /vercel/next.js "middleware authentication"
ctx7 docs /prisma/prisma "one-to-many relations"
```

JSON mode:

```bash
ctx7 docs /facebook/react "hooks" --json
```

## Bash usage guidance

When you are unsure whether `ctx7` is installed, prefer a bash pattern like this:

```bash
if command -v ctx7 >/dev/null 2>&1; then
  ctx7 library react --json
else
  npx -y ctx7 library react --json
fi
```

For doc queries:

```bash
if command -v ctx7 >/dev/null 2>&1; then
  ctx7 docs /facebook/react "useEffect cleanup" --json
else
  npx -y ctx7 docs /facebook/react "useEffect cleanup" --json
fi
```

## Authentication

For automation, prefer environment-variable auth when needed:

```bash
export CONTEXT7_API_KEY=your_key_here
```

Interactive auth may also be available:

```bash
ctx7 login
ctx7 whoami
ctx7 logout
```

Optional telemetry disable:

```bash
export CTX7_TELEMETRY_DISABLED=1
```

If unauthenticated access works but appears rate-limited, mention that limitation in the report.

## Output handling rules

- Prefer `--json` when you need to extract IDs or structured fields.
- Treat the JSON schema as **unstable unless verified in the current environment**.
- If parsing fails, retry in plain-text mode and summarize manually.
- Keep the resolved library ID in the final answer when it matters.
- Quote exact commands used whenever possible.

## Search quality rules

- Prefer the most relevant official/primary library result, not just the first fuzzy match.
- If `library` returns ambiguous results, refine the query with framework version, feature, or vendor name.
- Use focused doc queries such as:
  - feature name
  - API name
  - error message
  - migration topic
- If the Context7 result looks thin, cross-check with official docs or repository sources.

## Failure recovery

### `ctx7` command not found
Retry with:

```bash
npx -y ctx7 ...
```

### Auth / rate-limit issues
- Try `CONTEXT7_API_KEY`
- Report reduced confidence if only partial results are available

### JSON output is hard to parse
- Retry without `--json`
- Extract the important lines manually

### Library resolution is ambiguous
- Add a clarifying query, for example:

```bash
ctx7 library nextjs "vercel app router"
```

## Guidance for searcher

When answering library/framework questions:
- load this skill first when available
- prefer Context7 CLI over MCP tools
- use bash for the exact command execution
- report the exact command path used (`ctx7` or `npx -y ctx7`)
- if Context7 fails, fall back explicitly and say why

## Reference points

Re-check these in the current environment when accuracy matters:
- `ctx7 --help`
- `ctx7 library --help`
- `ctx7 docs --help`

External references used to shape this workflow:
- Context7 repository: https://github.com/upstash/context7
- Authentication implementation reference: https://github.com/upstash/context7/blob/6cba6fb2/packages/cli/src/utils/auth.ts#L42-L50
- CLI overview reference: https://deepwiki.com/upstash/context7/8-cli-tools-(ctx7)
- Authentication commands reference: https://deepwiki.com/upstash/context7/8.5-authentication-commands
