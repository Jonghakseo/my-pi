import { execSync } from "node:child_process";
import QRCode from "qrcode-terminal";
import { initializeAuth } from "./auth.js";
import { killPty, onPtyExit, spawnInPty, writeToPty } from "./pty.js";
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
}

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

export async function startRemote(options: RemoteOptions = {}): Promise<() => Promise<void>> {
  const piPath = resolvePiPath(options.piPath);
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

  const cleanup = async (): Promise<void> => {
    if (cleaningUp) return;
    cleaningUp = true;
    killPty();
    await closeWebSocket?.();
    await serverResult?.cleanup();
    if (funnelCleanupPort !== null) {
      await stopFunnel(funnelCleanupPort);
    }
    setPublicUrl(null);
  };

  const registerCleanupHandlers = (): void => {
    if (cleanupRegistered) return;
    cleanupRegistered = true;

    onPtyExit(async (exitCode) => {
      await cleanup();
      process.exit(exitCode ?? 0);
    });

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
        if (reason !== "initial_pin") {
          writeToPty(`\r\n\x1b[33m⚠ PIN rotated (${reason}). New PIN: ${nextPin}\x1b[0m\r\n`);
        }
      },
    });
  };

  try {
    applyAuth(activeMode);
    serverResult = await startServer({
      mode: activeMode,
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
        serverResult = await startServer({ mode: activeMode, reason: activeReason });
        remoteUrl = serverResult.url;
        pin = serverResult.pin;
      }
    }

    closeWebSocket = setupTerminalWebSocket(serverResult.server, activeMode);

    printRemoteSummary({
      url: remoteUrl,
      mode: activeMode,
      pin,
      reason: activeReason,
    });

    const piEnv: Record<string, string> = {
      ...(options.env ?? (process.env as Record<string, string>)),
      PI_REMOTE_URL: remoteUrl,
      PI_REMOTE_MODE: activeMode,
    };

    if (activeReason) {
      piEnv.PI_REMOTE_REASON = activeReason;
    }
    if (pin) {
      piEnv.PI_REMOTE_PIN = pin;
    }

    registerCleanupHandlers();
    await spawnInPty({
      command: piPath,
      args: options.args ?? [],
      cwd: options.cwd ?? process.cwd(),
      env: piEnv,
      cols: process.stdout.columns || 120,
      rows: process.stdout.rows || 30,
      attachLocal: true,
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
