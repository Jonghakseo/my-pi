#!/usr/bin/env node
/** Loopback-only Easy Review server backed by an in-process Pi SDK session. */

import { createServer as createHttpServer } from "node:http";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { randomBytes, timingSafeEqual } from "node:crypto";

const MAX_REQUEST_BYTES = 32 * 1024;
const MAX_MESSAGE_CHARS = 6_000;
const MAX_SELECTION_CHARS = 4_000;
const MAX_CONTEXT_CHARS = 64_000;
const TOKEN_RE = /[0-9A-Za-z_가-힣./@-]{2,}/gu;

export class ChatServerError extends Error {}

export class ReviewContext {
  constructor(review) {
    this.review = review;
    this.lines = review.source.lines;
    this.files = new Map(review.files.map((item) => [item.id, item]));
    this.sections = new Map(review.plan.sections.map((item) => [item.id, item]));
    this.anchorIndices = new Map(this.lines.map((line, index) => [line.id, index]));
  }

  systemPrompt() {
    const { plan, coverage } = this.review;
    const catalog = {
      title: plan.title,
      summary: plan.summary,
      overview: plan.overview,
      attention: plan.attention,
      sections: plan.sections.map((section) => ({
        id: section.id,
        title: section.title,
        summary: section.summary,
        evidence: section.evidence,
        files: section.files.map((filePlan) => ({
          path: this.files.get(filePlan.file_id).path,
          view: filePlan.view,
          note: filePlan.note,
        })),
      })),
      verification: plan.verification,
      coverage,
    };
    return [
      "You are the Q&A assistant embedded in an Easy Review document.",
      "Answer in the user's language, usually Korean. You have no tools and may use only the review catalog below plus evidence included with each question.",
      "Never claim to have read repository files, CI, or runtime behavior beyond that context. Distinguish observed diff behavior from inference.",
      "When possible cite exact file paths, original line numbers, and D anchors. If evidence is insufficient, say what cannot be confirmed.",
      "Keep answers concise and review-focused.",
      "",
      "REVIEW CATALOG",
      JSON.stringify(catalog),
    ].join("\n");
  }

  questionPrompt(message, sectionId, selection) {
    const section = this.sections.get(sectionId || "") || this.bestSection(message);
    const parts = ["USER QUESTION", message.trim().slice(0, MAX_MESSAGE_CHARS)];
    if (section) {
      parts.push(
        "CURRENT REVIEW SECTION",
        JSON.stringify({ id: section.id, title: section.title, summary: section.summary }),
      );
    }
    const selected = selection.trim().slice(0, MAX_SELECTION_CHARS);
    if (selected) parts.push("USER-SELECTED TEXT", selected);
    parts.push(
      "REVIEW EVIDENCE",
      section ? this.sectionEvidence(section) : "No section-specific evidence was selected.",
    );
    return parts.join("\n\n");
  }

  bestSection(message) {
    const terms = new Set(Array.from(message.matchAll(TOKEN_RE), (match) => match[0].toLowerCase()));
    let best = null;
    for (const section of this.sections.values()) {
      const text = [
        section.title,
        section.summary,
        ...section.files.flatMap((filePlan) => [filePlan.note, this.files.get(filePlan.file_id).path]),
      ].join(" ").toLowerCase();
      const title = section.title.toLowerCase();
      const score = Array.from(terms).reduce(
        (total, term) => total + (text.includes(term) ? (title.includes(term) ? 3 : 1) : 0),
        0,
      );
      if (score && (!best || score > best.score)) best = { score, section };
    }
    return best?.section || null;
  }

  sectionEvidence(section) {
    const ranges = [];
    for (const anchor of section.evidence) {
      const index = this.anchorIndices.get(anchor);
      if (index !== undefined) ranges.push([Math.max(0, index - 4), Math.min(this.lines.length - 1, index + 4)]);
    }
    for (const filePlan of section.files) {
      if (filePlan.view !== "detail") continue;
      for (const focus of filePlan.focus) {
        const start = this.anchorIndices.get(focus.start);
        const end = this.anchorIndices.get(focus.end);
        if (start !== undefined && end !== undefined) {
          ranges.push([Math.max(0, start - 3), Math.min(this.lines.length - 1, end + 3)]);
        }
      }
    }
    const blocks = [];
    let consumed = 0;
    for (const [start, end] of mergeRanges(ranges)) {
      const block = this.lines.slice(start, end + 1).map(formatLine).join("\n");
      if (consumed + block.length > MAX_CONTEXT_CHARS) {
        const remaining = MAX_CONTEXT_CHARS - consumed;
        if (remaining > 0) blocks.push(`${block.slice(0, remaining)}\n[context truncated]`);
        break;
      }
      blocks.push(block);
      consumed += block.length + 2;
    }
    return blocks.join("\n\n---\n\n") || "No exact diff evidence is available for this section.";
  }
}

function mergeRanges(ranges) {
  const merged = [];
  for (const [start, end] of ranges.sort((left, right) => left[0] - right[0])) {
    const last = merged.at(-1);
    if (!last || start > last[1] + 1) merged.push([start, end]);
    else last[1] = Math.max(last[1], end);
  }
  return merged;
}

function formatLine(line) {
  return `${line.id} old:${line.old_line ?? "-"} new:${line.new_line ?? "-"} [${line.kind}] ${line.text}`;
}

function safeEqual(left, right) {
  const leftBuffer = Buffer.from(left || "");
  const rightBuffer = Buffer.from(right || "");
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function parseCookies(header) {
  return Object.fromEntries(
    String(header || "").split(";").map((part) => part.trim()).filter(Boolean).map((part) => {
      const separator = part.indexOf("=");
      return separator === -1 ? [part, ""] : [part.slice(0, separator), part.slice(separator + 1)];
    }),
  );
}

async function readJsonBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_REQUEST_BYTES) throw new ChatServerError("request is too large");
    chunks.push(chunk);
  }
  if (!size) throw new ChatServerError("request body is empty");
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch (error) {
    throw new ChatServerError(`invalid JSON request: ${error.message}`);
  }
}

function securityHeaders() {
  return {
    "cache-control": "no-store",
    "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; img-src data:; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY",
  };
}

function sendJson(response, status, value, headers = {}) {
  const body = Buffer.from(JSON.stringify(value));
  response.writeHead(status, {
    ...securityHeaders(),
    "content-type": "application/json; charset=utf-8",
    "content-length": body.length,
    ...headers,
  });
  response.end(body);
}

function createSessionFactory({ sdk, bundle, context }) {
  let modelRuntime;
  let resourceLoader;

  return async () => {
    modelRuntime ||= await sdk.ModelRuntime.create();
    if (!resourceLoader) {
      resourceLoader = new sdk.DefaultResourceLoader({
        cwd: bundle,
        agentDir: sdk.getAgentDir(),
        noExtensions: true,
        noSkills: true,
        noPromptTemplates: true,
        noThemes: true,
        noContextFiles: true,
        systemPromptOverride: () => context.systemPrompt(),
        appendSystemPromptOverride: () => [],
      });
      await resourceLoader.reload();
    }
    const { session } = await sdk.createAgentSession({
      cwd: bundle,
      modelRuntime,
      resourceLoader,
      sessionManager: sdk.SessionManager.inMemory(bundle),
      noTools: "all",
      tools: [],
    });
    if (!session.model) throw new ChatServerError("Pi SDK could not resolve an authenticated model");
    return session;
  };
}

export async function createEasyReviewServer({ bundle, host = "127.0.0.1", port = 0, sdk }) {
  if (host !== "127.0.0.1") throw new ChatServerError("Easy Review chat may bind only to 127.0.0.1");
  const review = JSON.parse(await readFile(resolve(bundle, "review.json"), "utf8"));
  await readFile(resolve(bundle, "review.html"));
  const context = new ReviewContext(review);
  const createSession = createSessionFactory({ sdk, bundle, context });
  let session = await createSession();
  let busy = false;
  const token = randomBytes(32).toString("base64url");
  const sourceSha = review.source.source_sha256;

  const server = createHttpServer(async (request, response) => {
    try {
      const origin = `http://127.0.0.1:${server.address().port}`;
      const url = new URL(request.url, origin);
      const hostValid = request.headers.host === `127.0.0.1:${server.address().port}`;
      const bundleValid = safeEqual(url.searchParams.get("bundle"), sourceSha);
      const cookieValid = safeEqual(parseCookies(request.headers.cookie).easy_review_chat, token);
      const postOriginValid = request.headers.origin === origin;
      const authorized = bundleValid || cookieValid;
      if (!hostValid) return sendJson(response, 400, { error: "invalid host" });

      if (request.method === "GET" && ["/", "/review.html"].includes(url.pathname)) {
        const body = await readFile(resolve(bundle, "review.html"));
        response.writeHead(200, {
          ...securityHeaders(),
          "content-type": "text/html; charset=utf-8",
          "content-length": body.length,
          "set-cookie": `easy_review_chat=${token}; HttpOnly; SameSite=Strict; Path=/`,
        });
        return response.end(body);
      }
      if (request.method === "GET" && url.pathname === "/source.diff") {
        const body = await readFile(resolve(bundle, "source.diff"));
        response.writeHead(200, {
          ...securityHeaders(),
          "content-type": "text/plain; charset=utf-8",
          "content-length": body.length,
        });
        return response.end(body);
      }
      if (request.method === "GET" && url.pathname === "/api/health") {
        if (!authorized) return sendJson(response, 401, { error: "unauthorized" });
        return sendJson(response, 200, {
          connected: Boolean(session.model),
          busy,
          scope: "review-bundle-only",
          runtime: "pi-sdk",
          model: `${session.model.provider}/${session.model.id}`,
        });
      }
      if (request.method === "POST" && url.pathname.startsWith("/api/")) {
        if (!authorized || !postOriginValid) return sendJson(response, 403, { error: "forbidden" });
      }
      if (request.method === "POST" && url.pathname === "/api/abort") {
        await session.abort();
        return sendJson(response, 200, { aborted: true });
      }
      if (request.method === "POST" && url.pathname === "/api/reset") {
        if (busy) return sendJson(response, 409, { error: "cannot reset while a response is streaming" });
        session.dispose();
        session = await createSession();
        return sendJson(response, 200, { reset: true });
      }
      if (request.method === "POST" && url.pathname === "/api/chat") {
        if (busy) return sendJson(response, 409, { error: "another response is already streaming" });
        const body = await readJsonBody(request);
        if (typeof body.message !== "string" || !body.message.trim()) throw new ChatServerError("message must be a non-empty string");
        if (body.message.length > MAX_MESSAGE_CHARS) throw new ChatServerError(`message exceeds ${MAX_MESSAGE_CHARS} characters`);
        if (body.sectionId != null && typeof body.sectionId !== "string") throw new ChatServerError("sectionId must be a string or null");
        if (body.selection != null && typeof body.selection !== "string") throw new ChatServerError("selection must be a string");

        response.writeHead(200, {
          ...securityHeaders(),
          "content-type": "application/x-ndjson; charset=utf-8",
          connection: "close",
        });
        const emit = (event) => {
          if (!response.destroyed) response.write(`${JSON.stringify(event)}\n`);
        };
        emit({ type: "start" });
        busy = true;
        const unsubscribe = session.subscribe((event) => {
          if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
            emit({ type: "delta", delta: event.assistantMessageEvent.delta });
          }
        });
        const onClose = () => {
          if (!response.writableEnded) session.abort().catch(() => {});
        };
        response.on("close", onClose);
        try {
          await session.prompt(context.questionPrompt(body.message, body.sectionId, body.selection || ""));
          emit({ type: "done" });
        } catch (error) {
          emit({ type: "error", message: error instanceof Error ? error.message : String(error) });
        } finally {
          busy = false;
          unsubscribe();
          response.off("close", onClose);
          response.end();
        }
        return;
      }
      sendJson(response, 404, { error: "not found" });
    } catch (error) {
      if (!response.headersSent) sendJson(response, error instanceof ChatServerError ? 400 : 500, { error: error.message || String(error) });
      else response.end(`${JSON.stringify({ type: "error", message: error.message || String(error) })}\n`);
    }
  });

  await new Promise((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(port, host, resolvePromise);
  });
  const address = server.address();
  const origin = `http://${address.address}:${address.port}`;
  return {
    server,
    session: () => session,
    origin,
    close: async () => {
      await new Promise((resolvePromise) => server.close(resolvePromise));
      session.dispose();
    },
  };
}

async function loadSdk(sdkRoot) {
  const entry = pathToFileURL(resolve(sdkRoot, "dist", "index.js")).href;
  return import(entry);
}

function parseArguments(argv) {
  const options = { host: "127.0.0.1", port: 0 };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--bundle") options.bundle = resolve(argv[++index]);
    else if (argument === "--sdk-root") options.sdkRoot = resolve(argv[++index]);
    else if (argument === "--port") options.port = Number(argv[++index]);
    else throw new ChatServerError(`unknown argument: ${argument}`);
  }
  if (!options.bundle || !options.sdkRoot) throw new ChatServerError("--bundle and --sdk-root are required");
  if (!Number.isInteger(options.port) || options.port < 0 || options.port > 65535) throw new ChatServerError("invalid --port");
  return options;
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const sdk = await loadSdk(options.sdkRoot);
  const app = await createEasyReviewServer({ ...options, sdk });
  console.log(`Easy Review chat: ${app.origin}/`);
  console.log(`Runtime: Pi SDK · Model: ${app.session().model.provider}/${app.session().model.id} · Tools: disabled`);
  const shutdown = async () => {
    await app.close();
    process.exit(0);
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : "";
if (import.meta.url === invokedPath) {
  main().catch((error) => {
    console.error(`easy-review: ${error.message || error}`);
    process.exit(1);
  });
}
