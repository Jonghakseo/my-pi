import { spawnSync } from "node:child_process";

function replaceSessionArg(args: string[], sessionFile?: string): string[] {
  const nextArgs = [...args];
  for (let index = nextArgs.indexOf("--session"); index !== -1; index = nextArgs.indexOf("--session")) {
    nextArgs.splice(index, 2);
  }
  if (sessionFile) {
    nextArgs.push("--session", sessionFile);
  }
  return nextArgs;
}

function stripRemoteEnv(env: Record<string, string>): Record<string, string> {
  const nextEnv = { ...env };
  delete nextEnv.PI_REMOTE_URL;
  delete nextEnv.PI_REMOTE_MODE;
  delete nextEnv.PI_REMOTE_REASON;
  delete nextEnv.PI_REMOTE_PIN;
  delete nextEnv.PI_REMOTE_SESSION_ID;
  delete nextEnv.PI_REMOTE_ATTACH_LOCAL;
  return nextEnv;
}

export function relaunchLocalPi(options: {
  piPath: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  sessionFile?: string;
}): number {
  const result = spawnSync(options.piPath, replaceSessionArg(options.args, options.sessionFile), {
    stdio: "inherit",
    cwd: options.cwd,
    env: stripRemoteEnv(options.env),
  });
  if (result.status !== null) {
    return result.status;
  }
  if (result.signal) {
    // Convention: 128 + signal number. Use kill() to re-raise if needed.
    const signalCodes: Record<string, number> = { SIGINT: 2, SIGTERM: 15, SIGKILL: 9, SIGHUP: 1 };
    return 128 + (signalCodes[result.signal] ?? 1);
  }
  return 1;
}
