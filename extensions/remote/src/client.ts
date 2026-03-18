import { randomUUID } from "node:crypto";
import { copyFileSync, existsSync, rmSync } from "node:fs";
import http from "node:http";
import https from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { WebSocket } from "ws";
import { consumeCloseRequest } from "./close-request.js";
import type { LockfileData } from "./lockfile.js";
import { relaunchLocalPi } from "./local-pi.js";

export interface ClientOptions {
  piPath: string;
  args: string[];
  sessionFile?: string;
  cwd: string;
  env?: Record<string, string>;
}

type ServerMessage =
  | { type: "auth_required"; pinLength: number }
  | { type: "auth_ok"; token: string }
  | { type: "auth_fail"; reason: string }
  | { type: "ping" }
  | { type: "session_list" }
  | { type: "state"; sessionId: string; running: boolean; exitCode: number | null }
  | { type: "reset"; sessionId: string; resumeId: number }
  | { type: "data"; sessionId: string; data: string; offset?: number; resumeId?: number }
  | { type: "replay_complete"; sessionId: string; resumeId: number }
  | { type: "exit"; sessionId: string; exitCode: number | null }
  | { type: "session_error"; reason: string; sessionId?: string };

interface SessionCreateResponse {
  session?: {
    id: string;
  };
  error?: string;
}

interface AuthResponse {
  token?: string;
  error?: string;
}

export async function startClient(server: LockfileData, options: ClientOptions): Promise<() => Promise<void>> {
  const sessionFileCopy = copySessionFile(options.sessionFile);
  let authToken: string | undefined;
  let sessionId: string | null = null;

  try {
    authToken = await getAuthToken(server);
    sessionId = await createRemoteSession(server, {
      authToken,
      cwd: options.cwd,
      sessionFile: sessionFileCopy.path,
    });
  } catch (error) {
    sessionFileCopy.cleanup();
    throw error;
  }

  process.stdout.write(`\n[pi-remote] Client mode: connected to ${server.url}\n`);
  process.stdout.write(`[pi-remote] Session: ${sessionId}\n\n`);

  const tokenQuery = server.mode === "lan" && server.token ? `?token=${encodeURIComponent(server.token)}` : "";
  const wsProtocol = server.mode === "tailscale" ? "wss" : "ws";
  const wsUrl = `${wsProtocol}://127.0.0.1:${server.port}/ws/terminal${tokenQuery}`;
  const ws = new WebSocket(wsUrl, server.mode === "tailscale" ? { rejectUnauthorized: false } : undefined);

  let cleanedUp = false;
  let exiting = false;
  let resumed = false;
  let attached = false;
  let orphanCleanupStarted = false;
  const stdinDecoder = new StringDecoder("utf8");

  const cleanupRemoteSessionIfNeeded = async (): Promise<void> => {
    if (attached || !sessionId || orphanCleanupStarted) {
      return;
    }
    orphanCleanupStarted = true;
    const deleted = await deleteRemoteSession(server, sessionId, authToken);
    if (deleted) {
      sessionFileCopy.cleanup();
    }
  };

  const resumeSession = (): void => {
    if (resumed || ws.readyState !== WebSocket.OPEN || !sessionId) {
      return;
    }
    resumed = true;
    ws.send(JSON.stringify({ type: "resume", sessionId, lastOffset: 0 }));
  };

  const stdinListener = (data: Buffer): void => {
    if (ws.readyState !== WebSocket.OPEN || !sessionId) {
      return;
    }
    const chunk = stdinDecoder.write(data);
    if (!chunk) {
      return;
    }
    ws.send(JSON.stringify({ type: "input", sessionId, data: chunk }));
  };

  const resizeListener = (): void => {
    if (ws.readyState !== WebSocket.OPEN || !sessionId) {
      return;
    }
    ws.send(
      JSON.stringify({
        type: "resize",
        sessionId,
        cols: process.stdout.columns || 80,
        rows: process.stdout.rows || 24,
      }),
    );
  };

  const signalHandler = (): void => {
    void exitWithCode(0);
  };

  const cleanup = async (): Promise<void> => {
    if (cleanedUp) return;
    cleanedUp = true;

    process.stdout.off("resize", resizeListener);

    for (const signal of ["SIGINT", "SIGTERM"] as const) {
      process.off(signal, signalHandler);
    }

    if (process.stdin.isTTY) {
      process.stdin.off("data", stdinListener);
      const trailing = stdinDecoder.end();
      if (trailing && ws.readyState === WebSocket.OPEN && sessionId) {
        ws.send(JSON.stringify({ type: "input", sessionId, data: trailing }));
      }
      process.stdin.setRawMode(false);
      process.stdin.pause();
    }

    if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
      await new Promise<void>((resolve) => {
        ws.once("close", () => resolve());
        ws.close();
      }).catch(() => undefined);
    }
  };

  const exitWithCode = async (code: number): Promise<void> => {
    if (exiting) return;
    exiting = true;

    const closeRequest = sessionId ? consumeCloseRequest(sessionId) : null;

    await cleanupRemoteSessionIfNeeded();
    await cleanup();

    if (closeRequest?.action === "return-local") {
      const nextCode = relaunchLocalPi({
        piPath: options.piPath,
        args: options.args,
        cwd: options.cwd,
        env: options.env ?? (process.env as Record<string, string>),
        sessionFile: sessionFileCopy.path,
      });
      sessionFileCopy.cleanup();
      process.exit(nextCode);
      return;
    }

    process.exit(code);
  };

  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.on("data", stdinListener);
  }
  process.stdout.on("resize", resizeListener);

  ws.on("open", () => {
    if (server.mode === "lan") {
      resumeSession();
    }
  });

  ws.on("message", async (raw) => {
    let message: ServerMessage;
    try {
      message = JSON.parse(raw.toString()) as ServerMessage;
    } catch {
      return;
    }

    switch (message.type) {
      case "auth_required":
        if (authToken) {
          ws.send(JSON.stringify({ type: "auth_token", token: authToken }));
        }
        break;
      case "auth_ok":
        resumeSession();
        break;
      case "auth_fail":
        process.stderr.write(`[pi-remote] Authentication failed: ${message.reason}\n`);
        await exitWithCode(1);
        break;
      case "ping":
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: "pong" }));
        }
        break;
      case "session_list":
        break;
      case "state":
        if (message.sessionId === sessionId) {
          attached = true;
          if (!message.running && message.exitCode !== null) {
            process.stderr.write(`[pi-remote] Session exited with code ${message.exitCode}.\n`);
          }
        }
        break;
      case "reset":
        if (message.sessionId === sessionId) {
          attached = true;
          process.stdout.write("\x1b[2J\x1b[H");
        }
        break;
      case "data":
        if (message.sessionId === sessionId) {
          attached = true;
          process.stdout.write(message.data);
        }
        break;
      case "replay_complete":
        if (message.sessionId === sessionId) {
          attached = true;
          resizeListener();
        }
        break;
      case "exit":
        if (message.sessionId === sessionId) {
          attached = true;
          await exitWithCode(message.exitCode ?? 0);
        }
        break;
      case "session_error":
        if (!message.sessionId || message.sessionId === sessionId) {
          process.stderr.write(`[pi-remote] Session error: ${message.reason}\n`);
          await exitWithCode(1);
        }
        break;
    }
  });

  ws.on("error", (error) => {
    const detail = error instanceof Error ? error.message : String(error);
    process.stderr.write(`[pi-remote] WebSocket error: ${detail}\n`);
  });

  ws.on("close", async () => {
    if (exiting) return;
    process.stderr.write("[pi-remote] Connection closed.\n");
    await exitWithCode(1);
  });

  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, signalHandler);
  }

  return cleanup;
}

function copySessionFile(sessionFile?: string): { path?: string; cleanup: () => void } {
  if (!sessionFile || !existsSync(sessionFile)) {
    return { cleanup: () => undefined };
  }

  const copyPath = join(tmpdir(), `pi-remote-session-${randomUUID().slice(0, 8)}.json`);
  copyFileSync(sessionFile, copyPath);
  return {
    path: copyPath,
    cleanup: () => {
      rmSync(copyPath, { force: true });
    },
  };
}

async function getAuthToken(server: LockfileData): Promise<string | undefined> {
  if (server.mode === "lan") {
    return undefined;
  }

  if (!server.pin) {
    throw new Error("Remote server PIN is missing from lockfile.");
  }

  const protocol = server.mode === "tailscale" ? "https" : "http";
  const response = await httpPost(`${protocol}://127.0.0.1:${server.port}/api/auth`, JSON.stringify({ pin: server.pin }), {
    "Content-Type": "application/json",
  });
  const parsed = JSON.parse(response) as AuthResponse;
  if (!parsed.token) {
    throw new Error(parsed.error ?? "Failed to authenticate remote client.");
  }
  return parsed.token;
}

async function createRemoteSession(
  server: LockfileData,
  options: { authToken?: string; cwd: string; sessionFile?: string },
): Promise<string> {
  const body = JSON.stringify({
    sessionFile: options.sessionFile,
    cwd: options.cwd,
    cols: process.stdout.columns || 80,
    rows: process.stdout.rows || 24,
  });
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };

  if (options.authToken) {
    headers.Authorization = `Bearer ${options.authToken}`;
  }

  const protocol = server.mode === "tailscale" ? "https" : "http";
  const tokenQuery = server.mode === "lan" && server.token ? `?token=${encodeURIComponent(server.token)}` : "";
  const response = await httpPost(`${protocol}://127.0.0.1:${server.port}/api/sessions${tokenQuery}`, body, headers);
  const parsed = JSON.parse(response) as SessionCreateResponse;
  if (!parsed.session?.id) {
    throw new Error(parsed.error ?? "Failed to create remote session.");
  }
  return parsed.session.id;
}

async function deleteRemoteSession(server: LockfileData, sessionId: string, authToken?: string): Promise<boolean> {
  const headers: Record<string, string> = {};
  if (authToken) {
    headers.Authorization = `Bearer ${authToken}`;
  }

  const protocol = server.mode === "tailscale" ? "https" : "http";
  const tokenQuery = server.mode === "lan" && server.token ? `?token=${encodeURIComponent(server.token)}` : "";
  try {
    await httpDelete(`${protocol}://127.0.0.1:${server.port}/api/sessions/${encodeURIComponent(sessionId)}${tokenQuery}`, headers);
    return true;
  } catch {
    return false;
  }
}

function httpPost(url: string, body: string, headers: Record<string, string>): Promise<string> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const client = parsed.protocol === "https:" ? https : http;
    const req = client.request(
      {
        hostname: parsed.hostname,
        port: parsed.port,
        path: parsed.pathname + parsed.search,
        method: "POST",
        timeout: 5000,
        headers: {
          ...headers,
          "Content-Length": String(Buffer.byteLength(body)),
        },
        ...(parsed.protocol === "https:" ? { rejectUnauthorized: false } : {}),
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          const responseBody = Buffer.concat(chunks).toString("utf-8");
          if ((res.statusCode ?? 500) >= 400) {
            reject(new Error(responseBody || `HTTP ${res.statusCode}`));
            return;
          }
          resolve(responseBody);
        });
      },
    );

    req.on("error", reject);
    req.on("timeout", () => {
      req.destroy(new Error("timeout"));
    });
    req.write(body);
    req.end();
  });
}

function httpDelete(url: string, headers: Record<string, string>): Promise<void> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const client = parsed.protocol === "https:" ? https : http;
    const req = client.request(
      {
        hostname: parsed.hostname,
        port: parsed.port,
        path: parsed.pathname + parsed.search,
        method: "DELETE",
        timeout: 5000,
        headers,
        ...(parsed.protocol === "https:" ? { rejectUnauthorized: false } : {}),
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          if ((res.statusCode ?? 500) >= 400) {
            reject(new Error(Buffer.concat(chunks).toString("utf-8") || `HTTP ${res.statusCode}`));
            return;
          }
          resolve();
        });
      },
    );

    req.on("error", reject);
    req.on("timeout", () => {
      req.destroy(new Error("timeout"));
    });
    req.end();
  });
}
