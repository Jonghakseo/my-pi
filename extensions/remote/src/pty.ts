import { chmodSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { arch, platform } from "node:os";
import { dirname, join } from "node:path";

const require = createRequire(import.meta.url);

export type PtyDataListener = (data: string, offset: number) => void;
export type PtyExitListener = (exitCode: number) => void;

let stdinDataListener: ((data: Buffer) => void) | null = null;

export function fixSpawnHelperPermissions(): void {
  try {
    const ptyPkg = require.resolve("node-pty/package.json");
    const ptyDir = dirname(ptyPkg);
    const helperPath = join(ptyDir, "prebuilds", `${platform()}-${arch()}`, "spawn-helper");
    const stat = statSync(helperPath);
    if (!(stat.mode & 0o111)) {
      chmodSync(helperPath, stat.mode | 0o755);
    }
  } catch {
    // ignore
  }
}

export function registerLocalStdinListener(listener: (data: Buffer) => void): void {
  detachLocalStdin();
  stdinDataListener = listener;

  if (!process.stdin.isTTY) {
    return;
  }

  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.on("data", listener);
}

export function detachLocalStdin(): void {
  if (!stdinDataListener || !process.stdin.isTTY) {
    stdinDataListener = null;
    return;
  }

  process.stdin.off("data", stdinDataListener);
  process.stdin.setRawMode(false);
  process.stdin.pause();
  stdinDataListener = null;
}
