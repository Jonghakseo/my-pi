/**
 * Lockfile for remote server discovery.
 * Allows multiple pi instances to find and join an existing remote server.
 *
 * Location: /tmp/pi-remote.lock
 */

import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const LOCKFILE_PATH = join(tmpdir(), "pi-remote.lock");

export interface LockfileData {
  port: number;
  mode: "lan" | "tailscale" | "funnel";
  token?: string;
  pin?: string;
  pid: number;
  url: string;
}

export function writeLockfile(data: LockfileData): void {
  try {
    writeFileSync(LOCKFILE_PATH, JSON.stringify(data, null, 2), "utf-8");
  } catch {
    // non-fatal — discovery just won't work
  }
}

export function readLockfile(): LockfileData | null {
  try {
    if (!existsSync(LOCKFILE_PATH)) return null;
    const content = readFileSync(LOCKFILE_PATH, "utf-8");
    const parsed = JSON.parse(content) as LockfileData;

    // Verify the process is still alive
    if (parsed.pid) {
      try {
        process.kill(parsed.pid, 0); // signal 0 = existence check
      } catch {
        // Process is dead — stale lockfile
        removeLockfile();
        return null;
      }
    }

    return parsed;
  } catch {
    return null;
  }
}

export function removeLockfile(): void {
  try {
    if (existsSync(LOCKFILE_PATH)) {
      unlinkSync(LOCKFILE_PATH);
    }
  } catch {
    // ignore
  }
}

export function removeLockfileIfMatches(expected: Pick<LockfileData, "pid" | "port" | "url">): void {
  try {
    if (!existsSync(LOCKFILE_PATH)) {
      return;
    }
    const content = readFileSync(LOCKFILE_PATH, "utf-8");
    const parsed = JSON.parse(content) as Partial<LockfileData>;
    if (parsed.pid === expected.pid && parsed.port === expected.port && parsed.url === expected.url) {
      unlinkSync(LOCKFILE_PATH);
    }
  } catch {
    // ignore
  }
}
