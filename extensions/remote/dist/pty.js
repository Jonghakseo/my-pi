import { chmodSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { arch, platform } from "node:os";
import { dirname, join } from "node:path";
import pty from "node-pty";
import { OutputBuffer } from "./session.js";
const require = createRequire(import.meta.url);
let ptyProcess = null;
let lastExitCode = null;
let outputBuffer = new OutputBuffer();
let dataListeners = [];
let exitListeners = [];
let stdinDataListener = null;
function fixSpawnHelperPermissions() {
    try {
        const ptyPkg = require.resolve("node-pty/package.json");
        const ptyDir = dirname(ptyPkg);
        const helperPath = join(ptyDir, "prebuilds", `${platform()}-${arch()}`, "spawn-helper");
        const stat = statSync(helperPath);
        if (!(stat.mode & 0o111)) {
            chmodSync(helperPath, stat.mode | 0o755);
        }
    }
    catch {
        // ignore
    }
}
function detachLocalStdin() {
    if (!stdinDataListener || !process.stdin.isTTY)
        return;
    process.stdin.off("data", stdinDataListener);
    process.stdin.setRawMode(false);
    process.stdin.pause();
    stdinDataListener = null;
}
export async function spawnInPty(options) {
    if (ptyProcess) {
        throw new Error("PTY process already running");
    }
    fixSpawnHelperPermissions();
    lastExitCode = null;
    outputBuffer = new OutputBuffer();
    ptyProcess = pty.spawn(options.command, options.args ?? [], {
        name: "xterm-256color",
        cols: options.cols ?? 120,
        rows: options.rows ?? 30,
        cwd: options.cwd ?? process.cwd(),
        env: options.env ?? process.env,
    });
    ptyProcess.onData((data) => {
        outputBuffer.append(data);
        const currentOffset = outputBuffer.getCurrentOffset();
        if (options.attachLocal) {
            process.stdout.write(data);
        }
        for (const listener of dataListeners) {
            try {
                listener(data, currentOffset);
            }
            catch {
                // ignore listener errors
            }
        }
    });
    ptyProcess.onExit(({ exitCode }) => {
        lastExitCode = exitCode;
        ptyProcess = null;
        detachLocalStdin();
        for (const listener of exitListeners) {
            try {
                listener(exitCode);
            }
            catch {
                // ignore listener errors
            }
        }
    });
    if (options.attachLocal && process.stdin.isTTY) {
        process.stdin.setRawMode(true);
        process.stdin.resume();
        stdinDataListener = (data) => {
            ptyProcess?.write(data.toString());
        };
        process.stdin.on("data", stdinDataListener);
    }
}
export function writeToPty(data) {
    ptyProcess?.write(data);
}
export function resizePty(cols, rows) {
    if (!ptyProcess)
        return;
    try {
        ptyProcess.resize(cols, rows);
    }
    catch {
        // ignore resize failures while exiting
    }
}
export function killPty() {
    detachLocalStdin();
    if (!ptyProcess)
        return;
    try {
        ptyProcess.kill();
    }
    catch {
        // ignore
    }
    ptyProcess = null;
}
export function onPtyData(cb) {
    dataListeners.push(cb);
    return () => {
        dataListeners = dataListeners.filter((listener) => listener !== cb);
    };
}
export function onPtyExit(cb) {
    exitListeners.push(cb);
    return () => {
        exitListeners = exitListeners.filter((listener) => listener !== cb);
    };
}
export function getPtyState() {
    return { running: ptyProcess !== null, exitCode: lastExitCode };
}
export function getPtyOutputBuffer() {
    return outputBuffer;
}
//# sourceMappingURL=pty.js.map