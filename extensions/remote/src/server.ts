import { existsSync, readFileSync, statSync } from "node:fs";
import {
  createServer as createHttpServer,
  type IncomingMessage,
  type Server as HttpServer,
  type ServerResponse,
} from "node:http";
import { createServer as createHttpsServer, type Server as HttpsServer } from "node:https";
import { networkInterfaces } from "node:os";
import { dirname, extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getCurrentPin, getLanToken, handleAuthRequest, httpAuthMiddleware } from "./auth.js";
import { SessionManager } from "./session-manager.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const START_PORT = 7009;
const END_PORT = 7099;

let currentPublicUrl: string | null = null;

const MIME: Record<string, string> = {
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

export type ServerMode = "lan" | "tailscale" | "funnel";

export interface ServerOptions {
  mode: ServerMode;
  sessions: SessionManager;
  reason?: string;
  port?: number;
  certPath?: string;
  keyPath?: string;
  hostname?: string;
  bindHost?: string;
}

export interface ServerResult {
  server: HttpServer | HttpsServer;
  url: string;
  port: number;
  pin?: string;
  cleanup: () => Promise<void>;
}

export function setPublicUrl(url: string | null): void {
  currentPublicUrl = url;
}

export async function startServer(options: ServerOptions): Promise<ServerResult> {
  currentPublicUrl = null;
  const webDir = join(__dirname, "..", "web-dist");
  const bindHost = options.bindHost ?? (options.mode === "funnel" ? "127.0.0.1" : "0.0.0.0");
  let actualPort = 0;

  const server =
    options.mode === "tailscale"
      ? createHttpsServer(
          {
            cert: readFileSync(requireValue(options.certPath, "certPath is required for tailscale mode")),
            key: readFileSync(requireValue(options.keyPath, "keyPath is required for tailscale mode")),
          },
          (req, res) => void handleRequest(req, res, options, webDir, actualPort),
        )
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
      await new Promise<void>((resolveClose) => {
        server.close(() => resolveClose());
      });
    },
  };
}

async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  options: ServerOptions,
  webDir: string,
  actualPort: number,
): Promise<void> {
  const requestUrl = new URL(
    req.url ?? "/",
    `${options.mode === "tailscale" ? "https" : "http"}://${req.headers.host ?? "127.0.0.1"}`,
  );
  const pathname = requestUrl.pathname;
  const method = req.method ?? "GET";

  if (pathname === "/ws/terminal") {
    res.writeHead(426);
    res.end("Upgrade Required");
    return;
  }

  if (method === "GET" && pathname === "/api/info") {
    if (options.mode === "lan" && !(await httpAuthMiddleware(req, res))) return;
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

  if (pathname === "/api/sessions") {
    if (!(await httpAuthMiddleware(req, res))) return;

    if (method === "GET") {
      respondJson(res, 200, { sessions: options.sessions.list() });
      return;
    }

    if (method === "POST") {
      const body = (await readJsonBody(req)) as Record<string, unknown> | null;
      try {
        const session = options.sessions.create({
          name: typeof body?.name === "string" ? body.name : undefined,
          cols: typeof body?.cols === "number" ? body.cols : undefined,
          rows: typeof body?.rows === "number" ? body.rows : undefined,
          fromSessionId: typeof body?.fromSessionId === "string" ? body.fromSessionId : undefined,
          sessionFile: typeof body?.sessionFile === "string" ? body.sessionFile : undefined,
          cwd: typeof body?.cwd === "string" ? body.cwd : undefined,
        });
        respondJson(res, 201, { session: session.getState() });
      } catch (error) {
        respondJson(res, 400, { error: error instanceof Error ? error.message : "session_create_failed" });
      }
      return;
    }

    res.writeHead(405);
    res.end("Method Not Allowed");
    return;
  }

  const sessionDeleteMatch = pathname.match(/^\/api\/sessions\/([^/]+)$/);
  if (sessionDeleteMatch) {
    if (!(await httpAuthMiddleware(req, res))) return;

    if (method !== "DELETE") {
      res.writeHead(405);
      res.end("Method Not Allowed");
      return;
    }

    const sessionId = decodeURIComponent(sessionDeleteMatch[1]);
    if (!options.sessions.get(sessionId)) {
      respondJson(res, 404, { error: "session_not_found" });
      return;
    }

    options.sessions.kill(sessionId);
    respondJson(res, 200, { ok: true, sessionId });
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

async function shouldAllowStaticRequest(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
  mode: ServerMode,
): Promise<boolean> {
  const staticAsset =
    pathname.startsWith("/assets/") ||
    pathname === "/favicon.ico" ||
    pathname.endsWith(".js") ||
    pathname.endsWith(".css") ||
    pathname.endsWith(".map");
  if (mode !== "lan") {
    return true;
  }
  if (staticAsset) {
    return true;
  }
  return httpAuthMiddleware(req, res);
}

function resolveStaticPath(webDir: string, pathname: string): string | null {
  const relativePath = pathname === "/" ? "/index.html" : pathname;
  const normalizedPath = normalize(relativePath).replace(/^([.][.][/\\])+/, "");
  const candidate = resolve(webDir, `.${normalizedPath}`);
  if (!candidate.startsWith(resolve(webDir))) {
    return null;
  }
  return candidate;
}

function respondJson(res: ServerResponse, statusCode: number, payload: unknown): void {
  res.writeHead(statusCode, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(payload));
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  if (chunks.length === 0) {
    return null;
  }

  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf-8"));
  } catch {
    return null;
  }
}

async function listenWithPortSearch(
  server: HttpServer | HttpsServer,
  host: string,
  startPort: number,
): Promise<number> {
  for (let port = startPort; port <= END_PORT; port += 1) {
    try {
      await new Promise<void>((resolveListen, rejectListen) => {
        const onError = (error: NodeJS.ErrnoException): void => {
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
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EADDRINUSE") {
        throw error;
      }
    }
  }

  throw new Error(`No available port between ${startPort} and ${END_PORT}`);
}

function buildBaseUrl(options: ServerOptions, port: number): string {
  if (options.mode === "funnel") {
    return `http://127.0.0.1:${port}`;
  }
  if (options.mode === "tailscale") {
    return `https://${requireValue(options.hostname, "hostname is required for tailscale mode")}:${port}`;
  }
  return `${getLanOrigin(port)}?token=${getLanToken()}`;
}

function getLanOrigin(port: number): string {
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

function requireValue(value: string | undefined, message: string): string {
  if (!value) {
    throw new Error(message);
  }
  return value;
}
