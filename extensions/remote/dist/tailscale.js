import { execFile } from "node:child_process";
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
const execFileAsync = promisify(execFile);
const CERT_DIR = join(tmpdir(), "pi-remote-tailscale-certs");
// ── Retry helper ──────────────────────────────────────────────────────────────
async function withRetry(fn, { retries = 2, delayMs = 1000, label = "operation" } = {}) {
    let lastError;
    for (let attempt = 0; attempt <= retries; attempt++) {
        try {
            return await fn();
        }
        catch (error) {
            lastError = error;
            if (attempt < retries) {
                process.stderr.write(`[pi-remote] ${label} failed (attempt ${attempt + 1}/${retries + 1}), retrying in ${delayMs}ms...\n`);
                await new Promise((r) => setTimeout(r, delayMs));
            }
        }
    }
    throw lastError;
}
export async function getTailscaleInfo() {
    try {
        const { stdout } = await withRetry(() => execFileAsync("tailscale", ["status", "--json"], { encoding: "utf-8", timeout: 10_000 }), { retries: 2, delayMs: 1000, label: "tailscale status" });
        const parsed = JSON.parse(stdout);
        const backendState = parsed.BackendState ?? "";
        const certDomains = Array.isArray(parsed.CertDomains)
            ? parsed.CertDomains.filter((value) => typeof value === "string" && value.length > 0)
            : [];
        return {
            installed: true,
            running: backendState.toLowerCase() === "running",
            ip: parsed.Self?.TailscaleIPs?.[0] ?? null,
            certDomains,
            funnelAvailable: Boolean(parsed.Capabilities?.["https"]) ||
                Boolean(parsed.Capabilities?.["funnel"]) ||
                certDomains.length > 0,
        };
    }
    catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const notInstalled = /ENOENT|not found/i.test(message);
        return {
            installed: !notInstalled,
            running: false,
            ip: null,
            certDomains: [],
            funnelAvailable: false,
            reason: notInstalled ? "Tailscale not installed" : message,
        };
    }
}
export async function ensureCert(hostname) {
    mkdirSync(CERT_DIR, { recursive: true });
    const certPath = join(CERT_DIR, `${hostname}.crt`);
    const keyPath = join(CERT_DIR, `${hostname}.key`);
    await withRetry(() => execFileAsync("tailscale", ["cert", "--cert-file", certPath, "--key-file", keyPath, hostname], {
        encoding: "utf-8",
        timeout: 15_000,
    }), { retries: 2, delayMs: 2000, label: "tailscale cert" });
    return { certPath, keyPath };
}
export async function startFunnel(port) {
    await withRetry(() => execFileAsync("tailscale", ["funnel", "--bg", `http://127.0.0.1:${port}`], { encoding: "utf-8", timeout: 15_000 }), { retries: 2, delayMs: 2000, label: "tailscale funnel --bg" });
    try {
        const { stdout } = await withRetry(() => execFileAsync("tailscale", ["funnel", "status", "--json"], { encoding: "utf-8", timeout: 10_000 }), { retries: 2, delayMs: 1000, label: "tailscale funnel status" });
        const parsed = JSON.parse(stdout);
        const portKey = String(port);
        if (parsed.Funnel && typeof parsed.Funnel === "object") {
            for (const [url, config] of Object.entries(parsed.Funnel)) {
                if (typeof config === "object" && config && portKey in config) {
                    return url;
                }
            }
        }
        if (parsed.ServeConfig?.TCP?.[portKey]?.HTTPS) {
            return `https://127.0.0.1:${port}`;
        }
    }
    catch {
        // fall through
    }
    throw new Error("Unable to determine Funnel public URL");
}
export async function stopFunnel(port) {
    try {
        await execFileAsync("tailscale", ["funnel", String(port), "off"], { encoding: "utf-8", timeout: 10_000 });
    }
    catch {
        // ignore cleanup failure
    }
}
export async function resolveMode(options) {
    if (options.forceLan) {
        return {
            mode: "lan",
            reason: "Forced LAN mode",
            tailscale: {
                installed: false,
                running: false,
                ip: null,
                certDomains: [],
                funnelAvailable: false,
            },
        };
    }
    const tailscale = await getTailscaleInfo();
    if (!tailscale.installed) {
        return fallbackLan(tailscale, tailscale.reason ?? "Tailscale not installed");
    }
    if (!tailscale.running) {
        return fallbackLan(tailscale, "Tailscale stopped → LAN mode");
    }
    if (tailscale.certDomains.length === 0) {
        return fallbackLan(tailscale, "Tailscale cert domain unavailable → LAN mode");
    }
    const hostname = tailscale.certDomains[0];
    let cert;
    try {
        cert = await ensureCert(hostname);
    }
    catch {
        return fallbackLan(tailscale, "Tailscale cert preflight failed → LAN mode");
    }
    if (options.funnel) {
        if (!tailscale.funnelAvailable) {
            return fallbackLan(tailscale, "Tailscale Funnel unavailable → LAN mode");
        }
        return { mode: "funnel", hostname, cert, tailscale };
    }
    return { mode: "tailscale", hostname, cert, tailscale };
}
function fallbackLan(tailscale, reason) {
    return {
        mode: "lan",
        reason,
        tailscale,
    };
}
//# sourceMappingURL=tailscale.js.map