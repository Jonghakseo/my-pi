import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export type CloseRequestAction = "return-local" | "shutdown-server";

interface CloseRequestPayload {
  action: CloseRequestAction;
}

function getCloseRequestPath(sessionId: string): string {
  return join(tmpdir(), `pi-remote-close-${sessionId}.json`);
}

export function writeCloseRequest(sessionId: string, action: CloseRequestAction): void {
  writeFileSync(getCloseRequestPath(sessionId), JSON.stringify({ action } satisfies CloseRequestPayload), "utf-8");
}

export function consumeCloseRequest(sessionId: string): CloseRequestPayload | null {
  const path = getCloseRequestPath(sessionId);
  try {
    if (!existsSync(path)) {
      return null;
    }
    const raw = readFileSync(path, "utf-8");
    rmSync(path, { force: true });
    const parsed = JSON.parse(raw) as Partial<CloseRequestPayload>;
    if (parsed.action === "return-local" || parsed.action === "shutdown-server") {
      return { action: parsed.action };
    }
    return null;
  } catch {
    try {
      rmSync(path, { force: true });
    } catch {
      // ignore
    }
    return null;
  }
}
