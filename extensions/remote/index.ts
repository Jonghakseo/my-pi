import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

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

const LOCKFILE_PATH = join(tmpdir(), "pi-remote.lock");

interface DiscoveredServer {
  port: number;
  url: string;
  mode: string;
  token?: string;
  pin?: string;
}

function discoverExistingServer(): DiscoveredServer | null {
  try {
    if (!existsSync(LOCKFILE_PATH)) return null;
    const content = readFileSync(LOCKFILE_PATH, "utf-8");
    const parsed = JSON.parse(content) as {
      port?: number;
      url?: string;
      mode?: string;
      token?: string;
      pin?: string;
      pid?: number;
    };
    if (!parsed.port || !parsed.url || !parsed.mode) return null;

    // Verify process is still alive
    if (parsed.pid) {
      try {
        process.kill(parsed.pid, 0);
      } catch {
        return null; // stale lockfile
      }
    }

    return {
      port: parsed.port,
      url: parsed.url,
      mode: parsed.mode,
      token: parsed.token,
      pin: parsed.pin,
    };
  } catch {
    return null;
  }
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

    // Build auth — LAN uses token query, Tailscale/Funnel uses PIN→JWT
    let headers: Record<string, string> = {
      "Content-Type": "application/json",
      "Content-Length": String(Buffer.byteLength(body)),
    };

    if (server.mode === "lan" && server.token) {
      // LAN: token as query param
      const result = await httpPost(
        `http://127.0.0.1:${server.port}/api/sessions?token=${server.token}`,
        body,
        headers,
      );
      const parsed = JSON.parse(result) as { session?: { id: string } };
      return !!parsed.session?.id;
    }

    if (server.pin) {
      // Tailscale/Funnel: first get JWT via PIN, then create session
      const authBody = JSON.stringify({ pin: server.pin });
      const authResult = await httpPost(
        `https://127.0.0.1:${server.port}/api/auth`,
        authBody,
        { "Content-Type": "application/json", "Content-Length": String(Buffer.byteLength(authBody)) },
      ).catch(() =>
        // HTTPS might fail if self-signed, try HTTP (funnel upstream)
        httpPost(
          `http://127.0.0.1:${server.port}/api/auth`,
          authBody,
          { "Content-Type": "application/json", "Content-Length": String(Buffer.byteLength(authBody)) },
        ),
      );
      const authParsed = JSON.parse(authResult) as { token?: string };
      if (!authParsed.token) return false;

      headers = {
        ...headers,
        Authorization: `Bearer ${authParsed.token}`,
      };
    }

    const result = await httpPost(
      `http://127.0.0.1:${server.port}/api/sessions`,
      body,
      headers,
    );
    const parsed = JSON.parse(result) as { session?: { id: string } };
    return !!parsed.session?.id;
  } catch {
    return false;
  }
}

function httpGet(url: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = http.get(url, { timeout: 3000 }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    });
    req.on("error", reject);
    req.on("timeout", () => { req.destroy(); reject(new Error("timeout")); });
  });
}

function httpPost(url: string, body: string, headers?: Record<string, string>): Promise<string> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const req = http.request(
      {
        hostname: parsed.hostname,
        port: parsed.port,
        path: parsed.pathname + parsed.search,
        method: "POST",
        timeout: 5000,
        headers: headers ?? { "Content-Type": "application/json", "Content-Length": String(Buffer.byteLength(body)) },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
      },
    );
    req.on("error", reject);
    req.on("timeout", () => { req.destroy(); reject(new Error("timeout")); });
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
        // Register this pi session on the existing remote server
        const joined = await joinExistingServer(existing, sessionFile, cwd);
        if (joined) {
          ctx.ui.notify(`Session added to remote server at ${existing.url}`, "info");
          return; // pi keeps running locally — no shutdown
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
