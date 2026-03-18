import { execSync } from "node:child_process";
import QRCode from "qrcode-terminal";
import { initializeAuth, getCurrentPin, getLanToken } from "./auth.js";
import { startClient } from "./client.js";
import { consumeCloseRequest } from "./close-request.js";
import { readLockfile, removeLockfile, removeLockfileIfMatches, writeLockfile } from "./lockfile.js";
import { relaunchLocalPi } from "./local-pi.js";
import { SessionManager } from "./session-manager.js";
import { setPublicUrl, startServer, type ServerResult } from "./server.js";
import { resolveMode, startFunnel, stopFunnel } from "./tailscale.js";
import { setupTerminalWebSocket } from "./ws.js";

export interface RemoteOptions {
  piPath?: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  funnel?: boolean;
  forceLan?: boolean;
  sessionFile?: string;
}

const GRACE_PERIOD_MS = 30_000;

function resolvePiPath(piPath?: string): string {
  if (piPath) return piPath;

  for (const command of ["which pi", "command -v pi"]) {
    try {
      const resolved = execSync(command, { encoding: "utf-8", env: process.env }).trim();
      if (resolved && !resolved.includes("\n")) {
        return resolved;
      }
    } catch {
      // try next
    }
  }

  throw new Error('Could not resolve the "pi" executable. Pass --pi-path explicitly.');
}

function isJoinServerUnavailableError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return ["ECONNREFUSED", "ECONNRESET", "socket hang up", "timeout", "EPIPE", "fetch failed"].some((token) =>
    message.includes(token),
  );
}

export async function startRemote(options: RemoteOptions = {}): Promise<() => Promise<void>> {
  const launcherCwd = options.cwd ?? process.cwd();
  const piPath = resolvePiPath(options.piPath);
  const piArgs = options.args ?? [];

  // Try to join an existing server (client mode).
  // Explicit transport requests only reuse a server of the same transport.
  const existingServer = readLockfile();
  const requestedMode = options.funnel ? "funnel" : options.forceLan ? "lan" : null;
  const canJoinExisting = existingServer && (requestedMode === null || existingServer.mode === requestedMode);
  if (canJoinExisting && existingServer) {
    try {
      return await startClient(existingServer, {
        piPath,
        args: piArgs,
        cwd: launcherCwd,
        env: options.env,
        sessionFile: options.sessionFile,
      });
    } catch (error) {
      if (!isJoinServerUnavailableError(error)) {
        throw error;
      }

      // Only dead/unreachable existing servers should trigger fallback to server mode.
      process.stderr.write(
        `[pi-remote] Existing server unavailable: ${error instanceof Error ? error.message : String(error)}. Starting server mode.\n`,
      );
      removeLockfileIfMatches(existingServer);
    }
  }

  const modeResult = await resolveMode({ forceLan: options.forceLan, funnel: options.funnel });

  let activeMode = modeResult.mode;
  let activeReason = modeResult.reason;
  let remoteUrl = "";
  let pin: string | undefined;
  let serverResult: ServerResult | null = null;
  let closeWebSocket: (() => Promise<void>) | null = null;
  let funnelCleanupPort: number | null = null;
  let cleaningUp = false;
  let cleanupRegistered = false;
  let graceTimer: NodeJS.Timeout | null = null;

  const syncLockfile = (): void => {
    if (!serverResult) {
      return;
    }

    writeLockfile({
      port: serverResult.port,
      mode: activeMode,
      token: activeMode === "lan" ? getLanToken() : undefined,
      pin: activeMode !== "lan" ? (getCurrentPin() ?? pin) : undefined,
      pid: process.pid,
      url: remoteUrl,
    });
  };

  const baseEnv: Record<string, string> = {
    ...(options.env ?? (process.env as Record<string, string>)),
  };

  const sessionManager = new SessionManager({
    piPath,
    args: piArgs,
    cwd: launcherCwd,
    env: baseEnv,
    cols: process.stdout.columns || 120,
    rows: process.stdout.rows || 30,
  });

  const cleanup = async (): Promise<void> => {
    if (cleaningUp) return;
    cleaningUp = true;

    if (graceTimer) {
      clearTimeout(graceTimer);
      graceTimer = null;
    }

    removeLockfile();
    sessionManager.killAll();

    // Cleanup with timeout — don't block exit for slow WS/server close
    const cleanupWithTimeout = async (fn: () => Promise<void>, ms = 3000): Promise<void> => {
      try {
        await Promise.race([fn(), new Promise<void>((r) => setTimeout(r, ms))]);
      } catch {
        // cleanup must continue even if one step fails
      }
    };

    await cleanupWithTimeout(() => closeWebSocket?.() ?? Promise.resolve());
    await cleanupWithTimeout(() => serverResult?.cleanup() ?? Promise.resolve());
    if (funnelCleanupPort !== null) {
      await cleanupWithTimeout(() => stopFunnel(funnelCleanupPort!), 5000);
    }
    setPublicUrl(null);
  };

  const scheduleGracefulExit = (): void => {
    if (cleaningUp || graceTimer) return;
    graceTimer = setTimeout(async () => {
      graceTimer = null;
      await cleanup();
      process.exit(0);
    }, GRACE_PERIOD_MS);
  };

  const cancelGracefulExit = (): void => {
    if (!graceTimer) return;
    clearTimeout(graceTimer);
    graceTimer = null;
  };

  const registerCleanupHandlers = (): void => {
    if (cleanupRegistered) return;
    cleanupRegistered = true;

    for (const signal of ["SIGINT", "SIGTERM"] as const) {
      process.on(signal, async () => {
        await cleanup();
        process.exit(0);
      });
    }
  };

  const applyAuth = (mode: "lan" | "tailscale" | "funnel"): void => {
    initializeAuth({
      mode,
      onPinChange: (nextPin, reason) => {
        pin = nextPin;
        if (nextPin) {
          baseEnv.PI_REMOTE_PIN = nextPin;
        } else {
          delete baseEnv.PI_REMOTE_PIN;
        }
        syncLockfile();
        if (reason !== "initial_pin") {
          process.stdout.write(`\r\n\x1b[33m⚠ PIN rotated (${reason}). New PIN: ${nextPin}\x1b[0m\r\n`);
        }
      },
    });
  };

  try {
    applyAuth(activeMode);
    serverResult = await startServer({
      mode: activeMode,
      sessions: sessionManager,
      reason: activeReason,
      certPath: modeResult.cert?.certPath,
      keyPath: modeResult.cert?.keyPath,
      hostname: modeResult.hostname,
    });
    remoteUrl = serverResult.url;
    pin = serverResult.pin;

    if (activeMode === "funnel") {
      try {
        remoteUrl = await startFunnel(serverResult.port);
        funnelCleanupPort = serverResult.port;
        setPublicUrl(remoteUrl);
      } catch (error) {
        activeReason = formatFunnelFallbackReason(error);
        process.stderr.write(`[pi-remote] ${activeReason}\n`);
        await stopFunnel(serverResult.port);
        await serverResult.cleanup();
        serverResult = null;
        setPublicUrl(null);

        activeMode = "lan";
        applyAuth(activeMode);
        serverResult = await startServer({ mode: activeMode, sessions: sessionManager, reason: activeReason });
        remoteUrl = serverResult.url;
        pin = serverResult.pin;
      }
    }

    baseEnv.PI_REMOTE_URL = remoteUrl;
    baseEnv.PI_REMOTE_MODE = activeMode;
    if (activeReason) {
      baseEnv.PI_REMOTE_REASON = activeReason;
    }
    if (pin) {
      baseEnv.PI_REMOTE_PIN = pin;
    }

    closeWebSocket = setupTerminalWebSocket(serverResult.server, activeMode, sessionManager);

    const initialSession = sessionManager.create({
      attachLocal: true,
      cols: process.stdout.columns || 120,
      rows: process.stdout.rows || 30,
    });

    sessionManager.onRunningCountChange((count) => {
      if (count === 0) {
        scheduleGracefulExit();
        return;
      }
      cancelGracefulExit();
    });

    initialSession.onExit(() => {
      const closeRequest = consumeCloseRequest(initialSession.id);
      if (closeRequest?.action === "shutdown-server") {
        void (async () => {
          await cleanup();
          const nextCode = relaunchLocalPi({
            piPath,
            args: piArgs,
            cwd: launcherCwd,
            env: baseEnv,
            sessionFile: options.sessionFile,
          });
          process.exit(nextCode);
        })().catch(() => process.exit(1));
        return;
      }

      const remaining = sessionManager.runningCount();
      if (remaining > 0) {
        process.stdout.write(
          `\r\n\x1b[33mInitial session exited. ${remaining} remote sessions still active. Press Ctrl+C to shut down.\x1b[0m\r\n`,
        );
      }
    });

    registerCleanupHandlers();

    // Write lockfile for server discovery by other pi instances
    syncLockfile();

    printRemoteSummary({
      url: remoteUrl,
      mode: activeMode,
      pin,
      reason: activeReason,
    });

    return cleanup;
  } catch (error) {
    await cleanup();
    throw error;
  }
}

function formatFunnelFallbackReason(error: unknown): string {
  const detail = error instanceof Error ? error.message : String(error);
  return `Tailscale Funnel failed (${detail}) → LAN mode`;
}

function printRemoteSummary(input: {
  url: string;
  mode: "lan" | "tailscale" | "funnel";
  pin?: string;
  reason?: string;
}): void {
  const modeLabel: Record<string, string> = { lan: "LAN", funnel: "Funnel", tailscale: "Tailscale" };
  const label = modeLabel[input.mode] ?? input.mode;
  process.stdout.write(`\n[pi-remote] ${label}: ${input.url}\n`);
  if (input.pin) {
    process.stdout.write(`[pi-remote] PIN: ${input.pin}${input.mode === "lan" ? "" : " (may rotate)"}\n`);
  }
  if (input.reason) {
    process.stdout.write(`[pi-remote] ${input.reason}\n`);
  }

  try {
    QRCode.generate(input.url, { small: true });
  } catch {
    // ignore QR rendering failure
  }
}
