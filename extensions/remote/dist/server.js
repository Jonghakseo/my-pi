import { existsSync, readFileSync, statSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { networkInterfaces } from "node:os";
import { dirname, extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getCurrentPin, getLanToken, handleAuthRequest, httpAuthMiddleware } from "./auth.js";
const __dirname = dirname(fileURLToPath(import.meta.url));
const START_PORT = 7009;
const END_PORT = 7099;
let currentPublicUrl = null;
const MIME = {
    ".css": "text/css; charset=utf-8",
    ".html": "text/html; charset=utf-8",
    ".ico": "image/x-icon",
    ".js": "application/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".map": "application/json; charset=utf-8",
    ".png": "image/png",
    ".svg": "image/svg+xml",
    ".woff": "font/woff",
    ".woff2": "font/woff2",
};
export function setPublicUrl(url) {
    currentPublicUrl = url;
}
export async function startServer(options) {
    currentPublicUrl = null;
    const webDir = join(__dirname, "..", "web-dist");
    const bindHost = options.bindHost ?? (options.mode === "funnel" ? "127.0.0.1" : "0.0.0.0");
    let actualPort = 0;
    const server = options.mode === "tailscale"
        ? createHttpsServer({
            cert: readFileSync(requireValue(options.certPath, "certPath is required for tailscale mode")),
            key: readFileSync(requireValue(options.keyPath, "keyPath is required for tailscale mode")),
        }, (req, res) => void handleRequest(req, res, options, webDir, actualPort))
        : createHttpServer((req, res) => void handleRequest(req, res, options, webDir, actualPort));
    const port = await listenWithPortSearch(server, bindHost, options.port ?? START_PORT);
    actualPort = port;
    const url = buildBaseUrl(options, port);
    return {
        server,
        url,
        port,
        pin: options.mode === "lan" ? undefined : getCurrentPin(),
        cleanup: async () => {
            await new Promise((resolveClose) => {
                server.close(() => resolveClose());
            });
        },
    };
}
async function handleRequest(req, res, options, webDir, actualPort) {
    const requestUrl = new URL(req.url ?? "/", `${options.mode === "tailscale" ? "https" : "http"}://${req.headers.host ?? "127.0.0.1"}`);
    const pathname = requestUrl.pathname;
    const method = req.method ?? "GET";
    if (pathname === "/ws/terminal") {
        res.writeHead(426);
        res.end("Upgrade Required");
        return;
    }
    if (method === "GET" && pathname === "/api/info") {
        if (options.mode === "lan" && !(await httpAuthMiddleware(req, res)))
            return;
        respondJson(res, 200, {
            url: currentPublicUrl ?? buildBaseUrl(options, actualPort),
            mode: options.mode,
            hasTailscale: options.mode !== "lan",
            reason: options.reason,
            pinMayRotate: options.mode !== "lan",
            pinLength: options.mode === "lan" ? undefined : options.mode === "funnel" ? 8 : 6,
            token: options.mode === "lan" ? getLanToken() : undefined,
        });
        return;
    }
    if (method === "POST" && pathname === "/api/auth") {
        await handleAuthRequest(req, res);
        return;
    }
    if (method !== "GET" && method !== "HEAD") {
        res.writeHead(405);
        res.end("Method Not Allowed");
        return;
    }
    if (!(await shouldAllowStaticRequest(req, res, pathname, options.mode))) {
        return;
    }
    const resolved = resolveStaticPath(webDir, pathname);
    if (resolved && existsSync(resolved) && statSync(resolved).isFile()) {
        const content = readFileSync(resolved);
        res.writeHead(200, { "Content-Type": MIME[extname(resolved)] ?? "application/octet-stream" });
        res.end(method === "HEAD" ? undefined : content);
        return;
    }
    const fallback = join(webDir, "index.html");
    if (existsSync(fallback)) {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(method === "HEAD" ? undefined : readFileSync(fallback));
        return;
    }
    res.writeHead(404);
    res.end("Not Found");
}
async function shouldAllowStaticRequest(req, res, pathname, mode) {
    const staticAsset = pathname.startsWith("/assets/") || pathname === "/favicon.ico" || pathname.endsWith(".js") || pathname.endsWith(".css") || pathname.endsWith(".map");
    if (mode !== "lan") {
        return true;
    }
    if (staticAsset) {
        return true;
    }
    return httpAuthMiddleware(req, res);
}
function resolveStaticPath(webDir, pathname) {
    const relativePath = pathname === "/" ? "/index.html" : pathname;
    const normalizedPath = normalize(relativePath).replace(/^([.][.][/\\])+/, "");
    const candidate = resolve(webDir, `.${normalizedPath}`);
    if (!candidate.startsWith(resolve(webDir))) {
        return null;
    }
    return candidate;
}
function respondJson(res, statusCode, payload) {
    res.writeHead(statusCode, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(payload));
}
async function listenWithPortSearch(server, host, startPort) {
    for (let port = startPort; port <= END_PORT; port += 1) {
        try {
            await new Promise((resolveListen, rejectListen) => {
                const onError = (error) => {
                    server.off("error", onError);
                    rejectListen(error);
                };
                server.once("error", onError);
                server.listen(port, host, () => {
                    server.off("error", onError);
                    resolveListen();
                });
            });
            return port;
        }
        catch (error) {
            const code = error.code;
            if (code !== "EADDRINUSE") {
                throw error;
            }
        }
    }
    throw new Error(`No available port between ${startPort} and ${END_PORT}`);
}
function buildBaseUrl(options, port) {
    if (options.mode === "funnel") {
        return `http://127.0.0.1:${port}`;
    }
    if (options.mode === "tailscale") {
        return `https://${requireValue(options.hostname, "hostname is required for tailscale mode")}:${port}`;
    }
    return `${getLanOrigin(port)}?token=${getLanToken()}`;
}
function getLanOrigin(port) {
    const nets = networkInterfaces();
    let localIp = "127.0.0.1";
    outer: for (const ifaceList of Object.values(nets)) {
        for (const iface of ifaceList ?? []) {
            if (iface.family === "IPv4" && !iface.internal) {
                localIp = iface.address;
                break outer;
            }
        }
    }
    return `http://${localIp}:${port}`;
}
function requireValue(value, message) {
    if (!value) {
        throw new Error(message);
    }
    return value;
}
//# sourceMappingURL=server.js.map