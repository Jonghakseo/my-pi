import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync } from "node:fs";
import http from "node:http";
import https from "node:https";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { readLockfile } from "./src/lockfile.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));

interface PendingRemoteLaunch {
  sessionFile?: string;
  funnel: boolean;
  lan: boolean;
}

function resolveLauncherPath(): string {
  const launcherPath = join(__dirname, "dist", "cli.js");
  if (!existsSync(launcherPath)) {
    throw new Error(`Remote launcher not found: ${launcherPath}`);
  }
  return launcherPath;
}

// ── Server discovery via lockfile ─────────────────────────────────────────────

interface DiscoveredServer {
  port: number;
  url: string;
  mode: string;
  token?: string;
  pin?: string;
}

function discoverExistingServer(): DiscoveredServer | null {
  const data = readLockfile();
  if (!data) return null;

  return {
    port: data.port,
    url: data.url,
    mode: data.mode,
    token: data.token,
    pin: data.pin,
  };
}

async function joinExistingServer(
  server: DiscoveredServer,
  sessionFile: string | undefined,
  cwd: string,
): Promise<boolean> {
  try {
    const body = JSON.stringify({
      sessionFile,
      cwd,
      cols: 80,
      rows: 24,
    });
    const localServerOrigin = `${server.mode === "tailscale" ? "https" : "http"}://127.0.0.1:${server.port}`;

    // Build auth — LAN uses token query, Tailscale/Funnel uses PIN→JWT
    let headers: Record<string, string> = {
      "Content-Type": "application/json",
      "Content-Length": String(Buffer.byteLength(body)),
    };

    if (server.mode === "lan" && server.token) {
      // LAN: token as query param
      const result = await httpPost(`${localServerOrigin}/api/sessions?token=${server.token}`, body, headers);
      const parsed = JSON.parse(result) as { session?: { id: string } };
      return !!parsed.session?.id;
    }

    if (server.pin) {
      // Tailscale/Funnel: first get JWT via PIN, then create session
      const authBody = JSON.stringify({ pin: server.pin });
      const authHeaders = {
        "Content-Type": "application/json",
        "Content-Length": String(Buffer.byteLength(authBody)),
      };
      const authResult = await httpPost(`${localServerOrigin}/api/auth`, authBody, authHeaders).catch(() =>
        server.mode === "tailscale" ? httpPost(`http://127.0.0.1:${server.port}/api/auth`, authBody, authHeaders) : Promise.reject(),
      );
      const authParsed = JSON.parse(authResult) as { token?: string };
      if (!authParsed.token) return false;

      headers = {
        ...headers,
        Authorization: `Bearer ${authParsed.token}`,
      };
    }

    const result = await httpPost(`${localServerOrigin}/api/sessions`, body, headers);
    const parsed = JSON.parse(result) as { session?: { id: string } };
    return !!parsed.session?.id;
  } catch {
    return false;
  }
}

function httpGet(url: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const client = parsed.protocol === "https:" ? https : http;
    const req = client.get(
      {
        hostname: parsed.hostname,
        port: parsed.port,
        path: parsed.pathname + parsed.search,
        timeout: 3000,
        ...(parsed.protocol === "https:" ? { rejectUnauthorized: false } : {}),
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
      },
    );
    req.on("error", reject);
    req.on("timeout", () => {
      req.destroy();
      reject(new Error("timeout"));
    });
  });
}

function httpPost(url: string, body: string, headers?: Record<string, string>): Promise<string> {
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
        headers: headers ?? { "Content-Type": "application/json", "Content-Length": String(Buffer.byteLength(body)) },
        ...(parsed.protocol === "https:" ? { rejectUnauthorized: false } : {}),
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
      },
    );
    req.on("error", reject);
    req.on("timeout", () => {
      req.destroy();
      reject(new Error("timeout"));
    });
    req.write(body);
    req.end();
  });
}

function buildWidgetLines(): string[] {
  const remoteUrl = process.env.PI_REMOTE_URL;
  if (!remoteUrl) return [];

  const mode = process.env.PI_REMOTE_MODE ?? "lan";
  const pin = process.env.PI_REMOTE_PIN;

  const lines = [`Remote (${mode}): ${remoteUrl}`];
  if (pin) {
    lines.push(`PIN: ${pin} (runtime 중 변경될 수 있음)`);
  }
  return lines;
}

export default function (pi: ExtensionAPI) {
  let pendingLaunch: PendingRemoteLaunch | null = null;

  const remoteHandler = async (variant: { funnel: boolean; lan: boolean }, ctx: any) => {
    if (!ctx.hasUI) {
      console.log("/remote is only available in interactive mode.");
      return;
    }

    await ctx.waitForIdle();

    const sessionFile = ctx.sessionManager.getSessionFile() ?? undefined;
    const cwd = process.cwd();

    // Try to join an existing remote server via lockfile
    if (!process.env.PI_REMOTE_URL) {
      const existing = discoverExistingServer();
      if (existing) {
        let joinSessionFile = sessionFile;
        if (sessionFile && existsSync(sessionFile)) {
          const copyPath = join(tmpdir(), `pi-remote-session-${randomUUID().slice(0, 8)}.json`);
          copyFileSync(sessionFile, copyPath);
          joinSessionFile = copyPath;
        }

        // Register this pi session on the existing remote server
        const joined = await joinExistingServer(existing, joinSessionFile, cwd);
        if (joined) {
          ctx.ui.notify(`Session transferred to ${existing.url}. Exiting.`, "info");
          // pendingLaunch stays null → session_shutdown won't start a launcher
          // This pi exits, session is now managed by the existing remote server
          ctx.shutdown();
          return;
        }
        ctx.ui.notify("Join failed. Starting new remote server...", "info");
      }
    }

    // No existing server or join failed — start a new launcher
    pendingLaunch = {
      sessionFile,
      funnel: variant.funnel,
      lan: variant.lan,
    };

    const modeLabel = variant.lan ? "LAN" : variant.funnel ? "Funnel" : "auto";
    ctx.ui.notify(`Starting remote server (${modeLabel})...`, "info");
    ctx.shutdown();
  };

  pi.registerCommand("remote", {
    description: "Start remote access (auto: Tailscale HTTPS if available, else LAN)",
    handler: async (_args, ctx) => remoteHandler({ funnel: false, lan: false }, ctx),
  });

  pi.registerCommand("remote:lan", {
    description: "Start remote access in LAN-only mode",
    handler: async (_args, ctx) => remoteHandler({ funnel: false, lan: true }, ctx),
  });

  pi.registerCommand("remote:funnel", {
    description: "Start remote access via Tailscale Funnel (public URL)",
    handler: async (_args, ctx) => remoteHandler({ funnel: true, lan: false }, ctx),
  });

  pi.registerCommand("remote:close", {
    description: "Exit remote mode and return to normal pi",
    handler: async (_args, ctx) => {
      if (!process.env.PI_REMOTE_URL) {
        ctx.ui.notify("Not in remote mode.", "error");
        return;
      }
      // Signal the launcher to shut down (fire and forget — don't wait)
      // The launcher's PTY exit handler will clean up server/WS/lockfile
      ctx.ui.notify("Exiting remote mode...", "info");
      ctx.shutdown();
      // session_shutdown handler will NOT set pendingLaunch (it's null)
      // so the launcher process will exit, and pi restarts normally via --session
    },
  });

  pi.on("session_shutdown", async () => {
    if (!pendingLaunch) return;

    const current = pendingLaunch;
    pendingLaunch = null;

    const launcherPath = resolveLauncherPath();
    const extensionPath = join(__dirname, "index.ts");
    const launcherArgs = [launcherPath];

    if (current.sessionFile) {
      launcherArgs.push("--session", current.sessionFile);
    }
    if (current.funnel) {
      launcherArgs.push("--funnel");
    }
    if (current.lan) {
      launcherArgs.push("--lan");
    }

    launcherArgs.push("--", "-e", extensionPath);

    const originalExit = process.exit;
    process.exit = ((code?: number) => {
      process.exit = originalExit;
      const result = spawnSync(process.execPath, launcherArgs, {
        stdio: "inherit",
        cwd: process.cwd(),
        env: process.env as Record<string, string>,
      });
      originalExit(result.status ?? code ?? 1);
    }) as typeof process.exit;
  });

  // ── Widget & notify on session start ─────────────────────────────────────

  const syncWidget = async (_event: unknown, ctx: any) => {
    if (!ctx.hasUI) return;
    const lines = buildWidgetLines();
    if (lines.length === 0) {
      ctx.ui.setWidget("remote-url", undefined);
      return;
    }
    ctx.ui.setWidget("remote-url", lines, { placement: "belowEditor" });
  };

  pi.on("session_start", async (_event: unknown, ctx: any) => {
    await syncWidget(_event, ctx);

    if (process.env.PI_REMOTE_URL && ctx.hasUI) {
      const mode = process.env.PI_REMOTE_MODE ?? "lan";
      const pin = process.env.PI_REMOTE_PIN;
      const parts = [`Remote (${mode}): ${process.env.PI_REMOTE_URL}`];
      if (pin) parts.push(`PIN: ${pin}`);
      ctx.ui.notify(parts.join(" | "), "info");
    }
  });

  pi.on("session_switch", syncWidget);
  pi.on("session_shutdown", async (_event, ctx) => {
    if (!ctx.hasUI) return;
    ctx.ui.setWidget("remote-url", undefined);
  });
}
