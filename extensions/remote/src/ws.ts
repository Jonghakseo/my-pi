import type { IncomingMessage, Server } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocket, WebSocketServer } from "ws";
import { createJwt, registerAuthRevokeHandler, verifyJwt, verifyPin, wsAuthCheck } from "./auth.js";
import { SessionManager, type Session, type SessionInfo } from "./session-manager.js";

export type ServerMode = "lan" | "tailscale" | "funnel";

interface ClientState {
  authenticated: boolean;
  missedPongs: number;
  heartbeat: NodeJS.Timeout | null;
  authTimeout: NodeJS.Timeout | null;
  activeSessionId: string | null;
  replayToken: number;
  resumeCounter: number;
}

type BrowserMessage =
  | { type: "input"; data: string; sessionId: string }
  | { type: "resize"; cols: number; rows: number; sessionId: string; mobile?: boolean }
  | { type: "auth_pin"; pin: string }
  | { type: "auth_token"; token: string }
  | { type: "resume"; lastOffset: number; sessionId: string }
  | { type: "session_create"; name?: string; cols?: number; rows?: number; fromSessionId?: string }
  | { type: "session_kill"; sessionId: string }
  | { type: "session_title"; sessionId: string; title: string }
  | { type: "session_list" }
  | { type: "pong" };

type ServerMessage =
  | { type: "data"; data: string; offset?: number; sessionId: string; resumeId?: number }
  | { type: "exit"; exitCode: number | null; sessionId: string }
  | { type: "state"; running: boolean; exitCode: number | null; sessionId: string }
  | { type: "auth_required"; pinLength: number }
  | { type: "auth_ok"; token: string }
  | { type: "auth_fail"; reason: string }
  | { type: "ping" }
  | { type: "reset"; sessionId: string; resumeId: number }
  | { type: "session_created"; session: SessionInfo }
  | { type: "session_killed"; sessionId: string }
  | { type: "session_list"; sessions: SessionInfo[] }
  | { type: "session_updated"; session: SessionInfo }
  | { type: "session_removed"; sessionId: string }
  | { type: "replay_complete"; sessionId: string; resumeId: number }
  | { type: "session_error"; reason: string; sessionId?: string };

interface SessionRuntimeState {
  busy: boolean;
  idleTimer: NodeJS.Timeout | null;
}

const REPLAY_CAP_BYTES = 200_000;
const REPLAY_CHUNK_SIZE = 32_000;
const BACKPRESSURE_DROP_BYTES = 1_000_000;
const BACKPRESSURE_CLOSE_BYTES = 5_000_000;
const IDLE_MS = 5_000;

function normalizeCloseReason(reason: string): Buffer {
  return Buffer.from(reason.slice(0, 120), "utf-8");
}

function isSessionScopedMessage(message: BrowserMessage): message is Extract<
  BrowserMessage,
  { sessionId: string }
> {
  return "sessionId" in message;
}

function send(ws: WebSocket, message: ServerMessage, stream = false): boolean {
  if (ws.readyState !== WebSocket.OPEN) return false;

  if (stream) {
    if (ws.bufferedAmount > BACKPRESSURE_CLOSE_BYTES) {
      ws.close(4003, normalizeCloseReason("backpressure"));
      return false;
    }
    if (ws.bufferedAmount > BACKPRESSURE_DROP_BYTES) {
      return false;
    }
  }

  ws.send(JSON.stringify(message));
  return true;
}

function delay(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

export function setupTerminalWebSocket(
  httpServer: Server,
  mode: ServerMode,
  sessionManager: SessionManager,
): () => Promise<void> {
  const wss = new WebSocketServer({ noServer: true });
  const clientStates = new Map<WebSocket, ClientState>();
  const sessionListeners = new Map<string, Array<() => void>>();
  const sessionRuntime = new Map<string, SessionRuntimeState>();

  const registerSession = (session: Session): void => {
    if (sessionListeners.has(session.id)) return;

    const runtime: SessionRuntimeState = { busy: false, idleTimer: null };
    sessionRuntime.set(session.id, runtime);

    const removeDataListener = session.onData((data, offset) => {
      markSessionBusy(session, runtime);
      for (const viewer of session.getLiveViewers()) {
        const state = clientStates.get(viewer);
        if (!state?.authenticated) continue;
        send(
          viewer,
          { type: "data", data, offset, sessionId: session.id, resumeId: state.resumeCounter },
          true,
        );
      }
    });

    const removeExitListener = session.onExit((exitCode) => {
      clearIdleTimer(runtime);
      runtime.busy = false;

      for (const viewer of session.getLiveViewers()) {
        send(viewer, { type: "exit", exitCode, sessionId: session.id });
      }
    });

    sessionListeners.set(session.id, [removeDataListener, removeExitListener]);
  };

  for (const sessionInfo of sessionManager.list()) {
    const session = sessionManager.get(sessionInfo.id);
    if (session) registerSession(session);
  }

  const removeCreated = sessionManager.onCreated((sessionInfo) => {
    const session = sessionManager.get(sessionInfo.id);
    if (session) registerSession(session);
    broadcastLifecycle({ type: "session_created", session: sessionInfo });
  });

  const removeUpdated = sessionManager.onUpdated((sessionInfo) => {
    broadcastLifecycle({ type: "session_updated", session: sessionInfo });
  });

  const removeKilled = sessionManager.onKilled((sessionId) => {
    broadcastLifecycle({ type: "session_killed", sessionId });
  });

  const removeRemoved = sessionManager.onRemoved((sessionId) => {
    const disposers = sessionListeners.get(sessionId) ?? [];
    for (const dispose of disposers) dispose();
    sessionListeners.delete(sessionId);
    clearIdleTimer(sessionRuntime.get(sessionId) ?? null);
    sessionRuntime.delete(sessionId);
    broadcastLifecycle({ type: "session_removed", sessionId });
  });

  const revokeAll = (reason: string): void => {
    for (const [ws, state] of clientStates) {
      abortReplay(state);
      stopHeartbeat(state);
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
        ws.close(4001, normalizeCloseReason(reason));
      }
    }
  };

  registerAuthRevokeHandler((reason) => {
    revokeAll(reason || "auth_revoked");
  });

  httpServer.on("upgrade", async (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "127.0.0.1"}`);
    if (url.pathname !== "/ws/terminal") {
      socket.destroy();
      return;
    }

    const authResult = await wsAuthCheck(req);
    if (!authResult.ok) {
      socket.destroy();
      return;
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit("connection", ws, req);
    });
  });

  wss.on("connection", (ws: WebSocket, req: IncomingMessage) => {
    const remoteIp = req.socket.remoteAddress ?? "";
    const state: ClientState = {
      authenticated: mode === "lan",
      missedPongs: 0,
      heartbeat: null,
      authTimeout: null,
      activeSessionId: null,
      replayToken: 0,
      resumeCounter: 0,
    };
    clientStates.set(ws, state);

    if (mode === "lan") {
      sendSessionList(ws, state);
      startHeartbeat(ws, state);
    } else {
      state.authTimeout = setTimeout(() => {
        if (!state.authenticated && ws.readyState === WebSocket.OPEN) {
          ws.close(4002, normalizeCloseReason("auth_timeout"));
        }
      }, 30_000);
      send(ws, { type: "auth_required", pinLength: mode === "funnel" ? 8 : 6 });
    }

    ws.on("message", async (raw) => {
      try {
        const message = JSON.parse(raw.toString()) as BrowserMessage;

        if (message.type === "pong") {
          state.missedPongs = 0;
          return;
        }

        if (!state.authenticated && message.type !== "auth_pin" && message.type !== "auth_token") {
          return;
        }

        if (isSessionScopedMessage(message) && !message.sessionId) {
          send(ws, { type: "session_error", reason: "sessionId_required" });
          return;
        }

        switch (message.type) {
          case "auth_pin": {
            const result = verifyPin(message.pin, remoteIp);
            if (!result.ok) {
              send(ws, { type: "auth_fail", reason: result.reason });
              return;
            }

            const token = await createJwt();
            state.authenticated = true;
            state.missedPongs = 0;
            clearAuthTimeout(state);
            startHeartbeat(ws, state);
            send(ws, { type: "auth_ok", token });
            sendSessionList(ws, state);
            break;
          }
          case "auth_token": {
            if (!(await verifyJwt(message.token))) {
              send(ws, { type: "auth_fail", reason: "Session expired. Re-enter the PIN." });
              return;
            }

            state.authenticated = true;
            state.missedPongs = 0;
            clearAuthTimeout(state);
            startHeartbeat(ws, state);
            send(ws, { type: "auth_ok", token: message.token });
            sendSessionList(ws, state);
            break;
          }
          case "resume": {
            await handleResume(ws, state, message.sessionId, message.lastOffset);
            break;
          }
          case "input": {
            if (state.activeSessionId !== message.sessionId) {
              send(ws, { type: "session_error", reason: "active_session_mismatch", sessionId: message.sessionId });
              return;
            }
            const session = sessionManager.get(message.sessionId);
            if (!session) {
              send(ws, { type: "session_error", reason: "session_not_found", sessionId: message.sessionId });
              return;
            }
            session.write(message.data, ws);
            break;
          }
          case "resize": {
            const session = sessionManager.get(message.sessionId);
            if (!session) {
              send(ws, { type: "session_error", reason: "session_not_found", sessionId: message.sessionId });
              return;
            }
            session.resize(ws, message.cols, message.rows, message.mobile);
            break;
          }
          case "session_create": {
            try {
              sessionManager.create({
                name: message.name,
                cols: message.cols,
                rows: message.rows,
                fromSessionId: message.fromSessionId,
              });
            } catch (error) {
              send(ws, { type: "session_error", reason: formatSessionCreateError(error) });
            }
            break;
          }
          case "session_kill": {
            const killTarget = sessionManager.get(message.sessionId);
            if (!killTarget) {
              send(ws, { type: "session_error", reason: "session_not_found", sessionId: message.sessionId });
              return;
            }
            if (killTarget.getState().attachLocal) {
              send(ws, { type: "session_error", reason: "cannot_kill_local_session", sessionId: message.sessionId });
              return;
            }
            sessionManager.kill(message.sessionId);
            break;
          }
          case "session_title": {
            const session = sessionManager.get(message.sessionId);
            if (!session) {
              send(ws, { type: "session_error", reason: "session_not_found", sessionId: message.sessionId });
              return;
            }
            session.setTitle(message.title);
            break;
          }
          case "session_list": {
            sendSessionList(ws, state);
            break;
          }
        }
      } catch {
        // ignore malformed WS payloads
      }
    });

    ws.on("close", () => {
      abortReplay(state);
      stopHeartbeat(state);
      clearAuthTimeout(state);

      if (state.activeSessionId) {
        sessionManager.get(state.activeSessionId)?.detachViewer(ws);
      }

      clientStates.delete(ws);
    });
  });

  return async () => {
    removeCreated();
    removeUpdated();
    removeKilled();
    removeRemoved();

    for (const disposers of sessionListeners.values()) {
      for (const dispose of disposers) dispose();
    }
    sessionListeners.clear();

    for (const runtime of sessionRuntime.values()) {
      clearIdleTimer(runtime);
    }
    sessionRuntime.clear();

    for (const state of clientStates.values()) {
      abortReplay(state);
      stopHeartbeat(state);
      clearAuthTimeout(state);
    }

    await new Promise<void>((resolve) => {
      wss.close(() => resolve());
    });
  };

  function broadcastLifecycle(message: ServerMessage): void {
    for (const [ws, state] of clientStates) {
      if (!state.authenticated) continue;
      send(ws, message);
    }
  }

  function sendSessionList(ws: WebSocket, state: ClientState): void {
    if (!state.authenticated) return;
    send(ws, { type: "session_list", sessions: sessionManager.list() });
  }

  async function handleResume(
    ws: WebSocket,
    state: ClientState,
    sessionId: string,
    lastOffset: number,
  ): Promise<void> {
    const session = sessionManager.get(sessionId);
    if (!session) {
      send(ws, { type: "session_error", reason: "session_not_found", sessionId });
      return;
    }

    abortReplay(state);

    if (state.activeSessionId) {
      sessionManager.get(state.activeSessionId)?.detachViewer(ws);
    }

    state.activeSessionId = sessionId;
    session.attachViewer(ws);
    state.resumeCounter += 1;
    state.replayToken += 1;
    const resumeId = state.resumeCounter;
    const replayToken = state.replayToken;

    const sessionState = session.getState();
    send(ws, {
      type: "state",
      running: sessionState.state === "running",
      exitCode: sessionState.exitCode,
      sessionId,
    });

    let replayData = "";
    let replayStartOffset = session.outputBuffer.getCurrentOffset();
    let lastSentOffset = lastOffset;
    let shouldReset = lastOffset <= 0;

    if (lastOffset > 0) {
      const delta = session.outputBuffer.getFrom(lastOffset);
      if (delta === null) {
        shouldReset = true;
      } else {
        replayData = delta.data;
        replayStartOffset = delta.newOffset - delta.data.length;
      }
    }

    if (shouldReset) {
      const snapshot = session.outputBuffer.getLastN(REPLAY_CAP_BYTES);
      replayData = snapshot.data;
      replayStartOffset = snapshot.offset - snapshot.data.length;
      lastSentOffset = replayStartOffset;
      send(ws, { type: "reset", sessionId, resumeId });
    }

    if (replayData) {
      for (let index = 0; index < replayData.length; index += REPLAY_CHUNK_SIZE) {
        if (state.replayToken !== replayToken || ws.readyState !== WebSocket.OPEN) {
          return;
        }

        const chunk = replayData.slice(index, index + REPLAY_CHUNK_SIZE);
        const chunkOffset = replayStartOffset + index + chunk.length;
        send(ws, { type: "data", data: chunk, offset: chunkOffset, sessionId, resumeId }, true);
        lastSentOffset = chunkOffset;
        await delay();
      }
    }

    if (state.replayToken !== replayToken || ws.readyState !== WebSocket.OPEN) {
      return;
    }

    const catchUpDelta = session.outputBuffer.getFrom(lastSentOffset);
    if (catchUpDelta?.data) {
      for (let index = 0; index < catchUpDelta.data.length; index += REPLAY_CHUNK_SIZE) {
        if (state.replayToken !== replayToken || ws.readyState !== WebSocket.OPEN) {
          return;
        }

        const chunk = catchUpDelta.data.slice(index, index + REPLAY_CHUNK_SIZE);
        const chunkOffset = lastSentOffset + index + chunk.length;
        send(ws, { type: "data", data: chunk, offset: chunkOffset, sessionId, resumeId }, true);
        await delay();
      }
      lastSentOffset = catchUpDelta.newOffset;
    }

    if (state.replayToken !== replayToken || ws.readyState !== WebSocket.OPEN) {
      return;
    }

    session.activateViewer(ws);
    send(ws, { type: "replay_complete", sessionId, resumeId });
  }

  function markSessionBusy(session: Session, runtime: SessionRuntimeState): void {
    if (!runtime.busy) {
      runtime.busy = true;
      broadcastLifecycle({ type: "session_updated", session: session.getState() });
    }

    clearIdleTimer(runtime);
    runtime.idleTimer = setTimeout(() => {
      runtime.busy = false;
      runtime.idleTimer = null;
      broadcastLifecycle({ type: "session_updated", session: session.getState() });
    }, IDLE_MS);
  }
}

function formatSessionCreateError(error: unknown): string {
  if (!(error instanceof Error)) {
    return "session_create_failed";
  }

  if (error.message.startsWith("session_limit_exceeded:")) {
    return error.message.replace(":", "_");
  }

  if (error.message === "attach_local_conflict") {
    return error.message;
  }

  return error.message || "session_create_failed";
}

function abortReplay(state: ClientState): void {
  state.replayToken += 1;
}

function startHeartbeat(ws: WebSocket, state: ClientState): void {
  stopHeartbeat(state);
  state.heartbeat = setInterval(() => {
    if (ws.readyState !== WebSocket.OPEN) {
      stopHeartbeat(state);
      return;
    }

    state.missedPongs += 1;
    if (state.missedPongs >= 3) {
      ws.close(4000, normalizeCloseReason("heartbeat_timeout"));
      stopHeartbeat(state);
      return;
    }

    send(ws, { type: "ping" });
  }, 30_000);
}

function stopHeartbeat(state: ClientState): void {
  if (state.heartbeat) {
    clearInterval(state.heartbeat);
    state.heartbeat = null;
  }
}

function clearAuthTimeout(state: ClientState): void {
  if (state.authTimeout) {
    clearTimeout(state.authTimeout);
    state.authTimeout = null;
  }
}

function clearIdleTimer(runtime: SessionRuntimeState | null): void {
  if (runtime?.idleTimer) {
    clearTimeout(runtime.idleTimer);
    runtime.idleTimer = null;
  }
}
