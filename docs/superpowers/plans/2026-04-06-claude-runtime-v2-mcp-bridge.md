# Claude Runtime Subagent v2: MCP Bridge Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Pi custom tools (`ask_master`, `remember/recall/forget`, `todo_write`, `until_report`, `show_widget`)을 Claude runtime subagent에서 MCP server를 통해 사용 가능하게 만들어, 나머지 agent(simplifier, worker 등)까지 `runtime: claude`로 확대한다.

**Architecture:** 각 Pi custom tool을 stdio-based MCP server로 감싸고, subagent 실행 시 `--mcp-config`로 동적 주입한다. MCP server는 Pi extension runtime과 IPC(파일 기반)로 통신하며, subagent runner가 IPC 결과를 수집해 Pi session에 반영한다.

**Tech Stack:** TypeScript, MCP SDK (`@modelcontextprotocol/sdk`), Node.js child_process (stdio transport), NDJSON IPC

---

## File Structure

```
extensions/subagent/mcp-bridge/
  server.ts              — MCP server entrypoint (stdio transport)
  tools/
    ask-master.ts        — ask_master tool handler
    memory.ts            — remember/recall/forget/memory_list handlers
    todo-write.ts        — todo_write handler
    until-report.ts      — until_report handler
    show-widget.ts       — show_widget handler (v2.1 후순위)
  ipc/
    types.ts             — IPC message types (request/response)
    file-channel.ts      — 파일 기반 IPC channel (요청 쓰기 → 응답 대기)
  config.ts              — 동적 MCP config 생성
  index.ts               — re-exports

extensions/subagent/
  runner.ts              — (수정) MCP bridge 연동, IPC 수집
  claude-args.ts         — (수정) MCP config에 bridge server 추가
  types.ts               — (수정) MCP bridge 관련 타입 추가

extensions/utils/
  mcp-bridge-server.test.ts
  mcp-bridge-ipc.test.ts
  mcp-bridge-tools.test.ts
  mcp-bridge-integration.test.ts
```

---

## Design Decisions

### IPC 방식: 파일 기반 (YAML/JSON)

MCP server는 별도 프로세스로 실행되므로 Pi extension runtime에 직접 접근할 수 없다. 대안:

| 방식 | 장점 | 단점 |
|------|------|------|
| **파일 IPC** | 단순, 디버깅 용이, ask_master과 동일 패턴 | 폴링 필요, 지연 |
| **HTTP IPC** | 실시간, 양방향 | 포트 충돌, 복잡도 |
| **Unix socket** | 실시간, 로컬 전용 | 플랫폼 의존, 복잡도 |

**결정: 파일 IPC**. ask_master가 이미 파일 기반 IPC를 쓰고 있고 (escalation YAML), 대부분의 도구는 요청-응답 패턴이므로 충분하다. 지연은 ~100ms 수준으로 subagent 실행 시간 대비 무시 가능.

### Tool 우선순위

| 도구 | 우선순위 | 이유 |
|------|---------|------|
| `ask_master` | P0 | worker/simplifier 확대에 필수 |
| `remember/recall/forget` | P1 | context 품질에 직접 영향 |
| `todo_write` | P1 | 작업 추적에 사용 |
| `until_report` | P2 | 일부 agent만 사용 |
| `show_widget` | P2 | UI 의존성 높음, 후순위 |

---

## Task 0: IPC channel 구현

**Files:**
- Create: `extensions/subagent/mcp-bridge/ipc/types.ts`
- Create: `extensions/subagent/mcp-bridge/ipc/file-channel.ts`
- Test: `extensions/utils/mcp-bridge-ipc.test.ts`

- [ ] **Step 1: Write IPC type definitions**

```typescript
// extensions/subagent/mcp-bridge/ipc/types.ts
export interface IpcRequest {
  id: string;
  tool: string;
  args: Record<string, unknown>;
  timestamp: number;
}

export interface IpcResponse {
  id: string;
  result?: { content: Array<{ type: "text"; text: string }>; isError?: boolean };
  error?: string;
  timestamp: number;
}
```

- [ ] **Step 2: Write failing tests for file channel**

```typescript
// extensions/utils/mcp-bridge-ipc.test.ts
import { describe, it, expect } from "vitest";
import { IpcFileChannel } from "../subagent/mcp-bridge/ipc/file-channel.ts";

describe("IpcFileChannel", () => {
  it("writes request and reads response", async () => {
    const channel = new IpcFileChannel(tmpDir);
    const reqId = await channel.sendRequest({ tool: "recall", args: { query: "test" } });
    // simulate response
    channel.writeResponse(reqId, { content: [{ type: "text", text: "found" }] });
    const resp = await channel.waitResponse(reqId, 5000);
    expect(resp.result?.content[0].text).toBe("found");
  });

  it("times out if no response", async () => {
    const channel = new IpcFileChannel(tmpDir);
    const reqId = await channel.sendRequest({ tool: "recall", args: {} });
    await expect(channel.waitResponse(reqId, 100)).rejects.toThrow("timeout");
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `cd extensions && pnpm exec vitest run --config utils/vitest.config.ts utils/mcp-bridge-ipc.test.ts`
Expected: FAIL (module not found)

- [ ] **Step 4: Implement IpcFileChannel**

```typescript
// extensions/subagent/mcp-bridge/ipc/file-channel.ts
import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";
import type { IpcRequest, IpcResponse } from "./types.js";

export class IpcFileChannel {
  constructor(private dir: string) {
    fs.mkdirSync(path.join(dir, "requests"), { recursive: true });
    fs.mkdirSync(path.join(dir, "responses"), { recursive: true });
  }

  async sendRequest(partial: Omit<IpcRequest, "id" | "timestamp">): Promise<string> {
    const id = crypto.randomUUID();
    const req: IpcRequest = { id, ...partial, timestamp: Date.now() };
    fs.writeFileSync(
      path.join(this.dir, "requests", `${id}.json`),
      JSON.stringify(req),
    );
    return id;
  }

  writeResponse(id: string, result: IpcResponse["result"], error?: string): void {
    const resp: IpcResponse = { id, result, error, timestamp: Date.now() };
    fs.writeFileSync(
      path.join(this.dir, "responses", `${id}.json`),
      JSON.stringify(resp),
    );
  }

  async waitResponse(id: string, timeoutMs: number): Promise<IpcResponse> {
    const respPath = path.join(this.dir, "responses", `${id}.json`);
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        const data = fs.readFileSync(respPath, "utf-8");
        fs.unlinkSync(respPath);
        return JSON.parse(data);
      } catch {
        await new Promise((r) => setTimeout(r, 50));
      }
    }
    throw new Error(`IPC timeout waiting for response ${id}`);
  }

  pendingRequests(): IpcRequest[] {
    const dir = path.join(this.dir, "requests");
    return fs.readdirSync(dir)
      .filter((f) => f.endsWith(".json"))
      .map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), "utf-8")));
  }

  consumeRequest(id: string): IpcRequest | undefined {
    const reqPath = path.join(this.dir, "requests", `${id}.json`);
    try {
      const data = fs.readFileSync(reqPath, "utf-8");
      fs.unlinkSync(reqPath);
      return JSON.parse(data);
    } catch {
      return undefined;
    }
  }

  cleanup(): void {
    fs.rmSync(this.dir, { recursive: true, force: true });
  }
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd extensions && pnpm exec vitest run --config utils/vitest.config.ts utils/mcp-bridge-ipc.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add extensions/subagent/mcp-bridge/ipc/ extensions/utils/mcp-bridge-ipc.test.ts
git commit -m "feat(v2): add file-based IPC channel for MCP bridge"
```

---

## Task 1: MCP server skeleton (stdio transport)

**Files:**
- Create: `extensions/subagent/mcp-bridge/server.ts`
- Create: `extensions/subagent/mcp-bridge/tools/ask-master.ts`
- Test: `extensions/utils/mcp-bridge-server.test.ts`

- [ ] **Step 1: Write failing test for MCP server tool registration**

```typescript
// extensions/utils/mcp-bridge-server.test.ts
import { describe, it, expect } from "vitest";
import { createBridgeToolDefs } from "../subagent/mcp-bridge/server.ts";

describe("MCP bridge server", () => {
  it("registers ask_master tool with correct schema", () => {
    const tools = createBridgeToolDefs();
    const askMaster = tools.find((t) => t.name === "ask_master");
    expect(askMaster).toBeDefined();
    expect(askMaster?.inputSchema.properties).toHaveProperty("message");
  });

  it("registers memory tools", () => {
    const tools = createBridgeToolDefs();
    expect(tools.find((t) => t.name === "remember")).toBeDefined();
    expect(tools.find((t) => t.name === "recall")).toBeDefined();
    expect(tools.find((t) => t.name === "forget")).toBeDefined();
  });

  it("registers todo_write tool", () => {
    const tools = createBridgeToolDefs();
    expect(tools.find((t) => t.name === "todo_write")).toBeDefined();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

- [ ] **Step 3: Implement MCP server with tool definitions**

```typescript
// extensions/subagent/mcp-bridge/server.ts
import { IpcFileChannel } from "./ipc/file-channel.js";

export interface BridgeToolDef {
  name: string;
  description: string;
  inputSchema: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
  };
}

export function createBridgeToolDefs(): BridgeToolDef[] {
  return [
    {
      name: "ask_master",
      description: "마스터에게 즉시 종료 후 메시지 전달. 방향 판단이 필요할 때만 사용.",
      inputSchema: {
        type: "object",
        properties: {
          message: { type: "string", description: "마스터에게 전달할 메시지" },
          context: { type: "string", description: "추가 컨텍스트" },
        },
        required: ["message"],
      },
    },
    {
      name: "remember",
      description: "중요한 사실/규칙/교훈을 장기 메모리에 저장",
      inputSchema: {
        type: "object",
        properties: {
          content: { type: "string", description: "저장할 내용" },
          title: { type: "string", description: "메모리 제목" },
          scope: { type: "string", enum: ["user", "project"] },
        },
        required: ["content"],
      },
    },
    {
      name: "recall",
      description: "장기 메모리에서 정보 검색",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", description: "검색어" },
          topic: { type: "string", description: "토픽 파일명" },
          scope: { type: "string", enum: ["user", "project"] },
        },
      },
    },
    {
      name: "forget",
      description: "장기 메모리에서 특정 항목 삭제",
      inputSchema: {
        type: "object",
        properties: {
          title: { type: "string", description: "삭제할 메모리 제목" },
          topic: { type: "string" },
          scope: { type: "string", enum: ["user", "project"] },
        },
        required: ["title"],
      },
    },
    {
      name: "todo_write",
      description: "작업 체크리스트 업데이트",
      inputSchema: {
        type: "object",
        properties: {
          todos: {
            type: "array",
            items: {
              type: "object",
              properties: {
                content: { type: "string" },
                status: { type: "string", enum: ["pending", "in_progress", "completed"] },
                activeForm: { type: "string" },
                notes: { type: "string" },
              },
              required: ["content", "status"],
            },
          },
        },
        required: ["todos"],
      },
    },
    {
      name: "until_report",
      description: "until 반복 작업의 결과 보고",
      inputSchema: {
        type: "object",
        properties: {
          taskId: { type: "number", description: "until task ID" },
          done: { type: "boolean", description: "조건 충족 여부" },
          summary: { type: "string", description: "현재 상태 요약" },
        },
        required: ["taskId", "done", "summary"],
      },
    },
  ];
}
```

MCP server의 실제 stdio entrypoint는 Task 3에서 구현한다. 여기서는 tool definition만 확정.

- [ ] **Step 4: Run tests to verify they pass**

- [ ] **Step 5: Commit**

```bash
git add extensions/subagent/mcp-bridge/server.ts extensions/utils/mcp-bridge-server.test.ts
git commit -m "feat(v2): define MCP bridge tool schemas"
```

---

## Task 2: Tool handlers (IPC relay)

**Files:**
- Create: `extensions/subagent/mcp-bridge/tools/ask-master.ts`
- Create: `extensions/subagent/mcp-bridge/tools/memory.ts`
- Create: `extensions/subagent/mcp-bridge/tools/todo-write.ts`
- Create: `extensions/subagent/mcp-bridge/tools/until-report.ts`
- Test: `extensions/utils/mcp-bridge-tools.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// extensions/utils/mcp-bridge-tools.test.ts
import { describe, it, expect } from "vitest";
import { handleToolCall } from "../subagent/mcp-bridge/tools/handler.ts";
import { IpcFileChannel } from "../subagent/mcp-bridge/ipc/file-channel.ts";

describe("MCP bridge tool handlers", () => {
  it("ask_master sends IPC request and returns response", async () => {
    const channel = new IpcFileChannel(tmpDir);
    const resultPromise = handleToolCall(channel, "ask_master", { message: "help" });

    // simulate host responding
    const [req] = channel.pendingRequests();
    channel.writeResponse(req.id, { content: [{ type: "text", text: "ok" }] });

    const result = await resultPromise;
    expect(result.content[0].text).toBe("ok");
  });

  it("recall sends IPC request with query", async () => {
    const channel = new IpcFileChannel(tmpDir);
    const resultPromise = handleToolCall(channel, "recall", { query: "test" });

    const [req] = channel.pendingRequests();
    expect(req.tool).toBe("recall");
    expect(req.args.query).toBe("test");
    channel.writeResponse(req.id, { content: [{ type: "text", text: "found" }] });

    const result = await resultPromise;
    expect(result.content[0].text).toBe("found");
  });

  it("returns error on timeout", async () => {
    const channel = new IpcFileChannel(tmpDir);
    const result = await handleToolCall(channel, "recall", { query: "x" }, 100);
    expect(result.isError).toBe(true);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

- [ ] **Step 3: Implement unified tool handler**

```typescript
// extensions/subagent/mcp-bridge/tools/handler.ts
import type { IpcFileChannel } from "../ipc/file-channel.js";

const DEFAULT_TIMEOUT_MS = 30_000;

export interface ToolResult {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}

export async function handleToolCall(
  channel: IpcFileChannel,
  toolName: string,
  args: Record<string, unknown>,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<ToolResult> {
  const reqId = await channel.sendRequest({ tool: toolName, args });
  try {
    const resp = await channel.waitResponse(reqId, timeoutMs);
    if (resp.error) {
      return { content: [{ type: "text", text: resp.error }], isError: true };
    }
    return resp.result ?? { content: [{ type: "text", text: "(no result)" }] };
  } catch (e) {
    return {
      content: [{ type: "text", text: `MCP bridge error: ${e instanceof Error ? e.message : String(e)}` }],
      isError: true,
    };
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

- [ ] **Step 5: Commit**

```bash
git add extensions/subagent/mcp-bridge/tools/ extensions/utils/mcp-bridge-tools.test.ts
git commit -m "feat(v2): implement MCP bridge tool handlers with IPC relay"
```

---

## Task 3: MCP server stdio entrypoint

**Files:**
- Modify: `extensions/subagent/mcp-bridge/server.ts`
- Create: `extensions/subagent/mcp-bridge/bin.ts` (CLI entrypoint)

- [ ] **Step 1: Install MCP SDK dependency**

```bash
cd extensions && pnpm add @modelcontextprotocol/sdk
```

- [ ] **Step 2: Implement MCP stdio server**

```typescript
// extensions/subagent/mcp-bridge/bin.ts
import { McpServer, StdioServerTransport } from "@modelcontextprotocol/sdk/server/index.js";
import { createBridgeToolDefs } from "./server.js";
import { handleToolCall } from "./tools/handler.js";
import { IpcFileChannel } from "./ipc/file-channel.js";

const ipcDir = process.env.PI_MCP_BRIDGE_IPC_DIR;
if (!ipcDir) {
  process.stderr.write("PI_MCP_BRIDGE_IPC_DIR is required\n");
  process.exit(1);
}

const channel = new IpcFileChannel(ipcDir);
const server = new McpServer({ name: "pi-bridge", version: "1.0.0" });

for (const def of createBridgeToolDefs()) {
  server.tool(def.name, def.description, def.inputSchema, async (args) => {
    return handleToolCall(channel, def.name, args);
  });
}

const transport = new StdioServerTransport();
await server.connect(transport);
```

- [ ] **Step 3: Add bin entry to package.json (if needed)**

- [ ] **Step 4: Verify server starts and responds to tool list**

```bash
echo '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}' | PI_MCP_BRIDGE_IPC_DIR=/tmp/test-ipc node extensions/subagent/mcp-bridge/bin.ts
```

- [ ] **Step 5: Commit**

```bash
git add extensions/subagent/mcp-bridge/bin.ts extensions/subagent/mcp-bridge/server.ts
git commit -m "feat(v2): MCP bridge stdio server entrypoint"
```

---

## Task 4: 동적 MCP config 생성 + runner 연동

**Files:**
- Create: `extensions/subagent/mcp-bridge/config.ts`
- Modify: `extensions/subagent/claude-args.ts`
- Modify: `extensions/subagent/runner.ts`
- Test: `extensions/utils/mcp-bridge-integration.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// extensions/utils/mcp-bridge-integration.test.ts
import { describe, it, expect } from "vitest";
import { generateBridgeMcpConfig } from "../subagent/mcp-bridge/config.ts";

describe("MCP bridge config", () => {
  it("generates valid MCP config with pi-bridge server", () => {
    const config = generateBridgeMcpConfig({ ipcDir: "/tmp/ipc", nodePath: "node" });
    expect(config.mcpServers["pi-bridge"]).toBeDefined();
    expect(config.mcpServers["pi-bridge"].command).toBe("node");
    expect(config.mcpServers["pi-bridge"].env.PI_MCP_BRIDGE_IPC_DIR).toBe("/tmp/ipc");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

- [ ] **Step 3: Implement config generator**

```typescript
// extensions/subagent/mcp-bridge/config.ts
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

export interface BridgeMcpConfigOptions {
  ipcDir: string;
  nodePath?: string;
  existingMcpConfig?: Record<string, unknown>;
}

export function generateBridgeMcpConfig(opts: BridgeMcpConfigOptions): Record<string, any> {
  const binPath = path.resolve(__dirname, "bin.js");
  const base = opts.existingMcpConfig ?? {};
  return {
    ...base,
    mcpServers: {
      ...(base as any).mcpServers,
      "pi-bridge": {
        command: opts.nodePath ?? "node",
        args: [binPath],
        env: { PI_MCP_BRIDGE_IPC_DIR: opts.ipcDir },
      },
    },
  };
}

export function writeBridgeMcpConfig(opts: BridgeMcpConfigOptions): string {
  const config = generateBridgeMcpConfig(opts);
  const tmpPath = path.join(os.tmpdir(), `pi-mcp-bridge-${Date.now()}.json`);
  fs.writeFileSync(tmpPath, JSON.stringify(config, null, 2));
  return tmpPath;
}
```

- [ ] **Step 4: Modify runner.ts to create IPC channel and inject MCP config**

`runClaudeAgent()`에서:
1. agent의 tool 목록에 Pi custom tool이 있으면 MCP bridge 활성화
2. IPC dir 생성
3. bridge MCP config 생성
4. `buildClaudeArgs`에 mcpConfigPath 전달
5. run 중 IPC 요청 폴링 → Pi extension으로 위임 → 응답 작성

- [ ] **Step 5: Run tests**

- [ ] **Step 6: Commit**

```bash
git add extensions/subagent/mcp-bridge/config.ts extensions/subagent/runner.ts extensions/subagent/claude-args.ts extensions/utils/mcp-bridge-integration.test.ts
git commit -m "feat(v2): dynamic MCP config generation and runner integration"
```

---

## Task 5: Host-side IPC handler (Pi extension에서 도구 실행)

**Files:**
- Modify: `extensions/subagent/runner.ts`
- Test: 기존 테스트 확장

- [ ] **Step 1: Write failing test for IPC request processing**

host가 IPC 요청을 폴링하고, Pi extension의 실제 도구를 호출한 뒤, IPC 응답을 작성하는 로직 테스트.

- [ ] **Step 2: Implement IPC request processor in runner**

`runClaudeAgent()` 내에서 주기적으로 (500ms) IPC 요청을 폴링하는 타이머:

```typescript
const ipcPollTimer = setInterval(async () => {
  for (const req of ipcChannel.pendingRequests()) {
    ipcChannel.consumeRequest(req.id);
    try {
      const result = await executePiTool(req.tool, req.args, ctx);
      ipcChannel.writeResponse(req.id, result);
    } catch (e) {
      ipcChannel.writeResponse(req.id, undefined, String(e));
    }
  }
}, 500);
```

`executePiTool()`은 도구별로:
- `ask_master`: escalation file 작성 + `currentResult.errorMessage` 설정 (exit(42) 대신 structured return)
- `remember/recall/forget`: memory-layer API 직접 호출
- `todo_write`: todo state 업데이트 + widget 동기화
- `until_report`: until task 상태 업데이트

- [ ] **Step 3: Run tests**

- [ ] **Step 4: Commit**

```bash
git commit -m "feat(v2): host-side IPC handler for Pi tool execution"
```

---

## Task 6: tool validation 정책 확장

**Files:**
- Modify: `extensions/utils/agent-utils.ts` — `mapPiToolsToClaude` 확장
- Modify: `extensions/subagent/runner.ts` — unsupported tool 정책 완화
- Test: 기존 dispatch 테스트 수정

- [ ] **Step 1: Update PI_TO_CLAUDE_TOOL_MAP**

MCP bridge tool은 `--tools`에 포함하지 않고 MCP config로 노출되므로, tool mapping을 두 카테고리로 분리:

```typescript
export const PI_TOOL_CATEGORIES = {
  claudeBuiltin: ["read", "find", "grep", "ls", "bash", "edit", "write"],
  mcpBridge: ["ask_master", "remember", "recall", "forget", "todo_write", "until_report", "show_widget"],
} as const;
```

`mapPiToolsToClaude()`는 builtin만 매핑하고, mcpBridge 도구는 별도로 반환.

- [ ] **Step 2: Update tests**

- [ ] **Step 3: Commit**

```bash
git commit -m "feat(v2): split tool categories for builtin vs MCP bridge"
```

---

## Task 7: prompt 정책 확장 (ask_master guideline 복원)

**Files:**
- Modify: `extensions/subagent/agents.ts` — `runtime: claude`에서도 ask_master 가능할 때 guideline 주입

- [ ] **Step 1: Update attachCommonSubagentRule**

MCP bridge가 활성화된 `runtime: claude` agent는 ask_master guideline을 포함하되, "MCP를 통해 사용 가능" 문구로 수정.

- [ ] **Step 2: Test prompt contains ask_master for bridge-enabled claude agents**

- [ ] **Step 3: Commit**

```bash
git commit -m "feat(v2): restore ask_master guideline for MCP bridge agents"
```

---

## Task 8: agent 확대 + 통합 테스트

**Files:**
- Modify: `agents/simplifier.md` — `runtime: claude` 추가
- Modify: `agents/worker.md` — `runtime: claude` 추가
- Test: E2E 통합 테스트

- [ ] **Step 1: Add runtime: claude to simplifier and worker**

- [ ] **Step 2: Write integration tests**

- ask_master IPC 왕복
- recall → remember → recall 왕복
- todo_write 상태 동기화
- Claude built-in + MCP bridge 혼합 agent가 올바르게 실행되는지

- [ ] **Step 3: Full acceptance run**

```bash
cd extensions && pnpm run typecheck
cd extensions && pnpm run test
```

- [ ] **Step 4: Commit**

```bash
git commit -m "feat(v2): expand claude runtime to simplifier and worker agents"
```

---

## Task 9: 정리 + 문서 업데이트

**Files:**
- Modify: `extensions/subagent/CLAUDE_RUNTIME_PLAN.md`
- Modify: `extensions/subagent/progress.md`

- [ ] **Step 1: Update PLAN with v2 completion status**
- [ ] **Step 2: Update progress with v2 task completion**
- [ ] **Step 3: Final typecheck + test**
- [ ] **Step 4: Commit**

---

## Dependency Map

```
Task 0 (IPC channel) ──────┐
                            v
Task 1 (tool defs) ──> Task 2 (handlers) ──> Task 3 (stdio server)
                                                      |
                                                      v
                                              Task 4 (config + runner)
                                                      |
                                                      v
                                              Task 5 (host IPC handler)
                                                      |
                                              Task 6 (tool validation) ──┐
                                              Task 7 (prompt policy) ────┤
                                                                         v
                                                                  Task 8 (agent 확대)
                                                                         |
                                                                         v
                                                                  Task 9 (문서화)
```

## Parallel Execution Waves

- **Wave 0**: Task 0
- **Wave 1**: Task 1 (after Task 0)
- **Wave 2**: Task 2 (after Task 1)
- **Wave 3**: Task 3 (after Task 2)
- **Wave 4**: Task 4, Task 5 (순차, after Task 3)
- **Wave 5**: Task 6 || Task 7 (병렬, after Task 5)
- **Wave 6**: Task 8 (after Task 6 + 7)
- **Wave 7**: Task 9 (after Task 8)

## Risk & Mitigation

| Risk | Mitigation |
|------|-----------|
| MCP SDK 호환성 | `@modelcontextprotocol/sdk` 버전 고정, 최소 의존 |
| IPC 지연으로 Claude timeout | 30초 timeout + 명확한 에러 메시지 |
| Pi extension API 변경 | handler를 thin relay로 유지, 직접 import 최소화 |
| ask_master exit(42) 패턴 불일치 | MCP bridge에서는 structured return, runner가 escalation 처리 |
| MCP server 프로세스 leak | runner finally 블록에서 cleanup |
