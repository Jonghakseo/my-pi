import { WebSocket, WebSocketServer } from "ws";
import { createJwt, registerAuthRevokeHandler, verifyJwt, verifyPin, wsAuthCheck } from "./auth.js";
import { getPtyOutputBuffer, getPtyState, onPtyData, onPtyExit, resizePty, writeToPty } from "./pty.js";
function send(ws, message) {
    if (ws.readyState !== WebSocket.OPEN)
        return;
    ws.send(JSON.stringify(message));
}
function normalizeCloseReason(reason) {
    return Buffer.from(reason.slice(0, 120), "utf-8");
}
export function setupTerminalWebSocket(httpServer, mode) {
    const wss = new WebSocketServer({ noServer: true });
    let activeWs = null;
    const clientSizes = new Map();
    const mobileClients = new Set();
    const clientStates = new Map();
    const removePtyDataListener = onPtyData((data, offset) => {
        for (const [ws, state] of clientStates) {
            if (!state.authenticated)
                continue;
            if (state.awaitingResume)
                continue;
            send(ws, { type: "data", data, offset });
            state.lastOffset = offset;
        }
    });
    const removePtyExitListener = onPtyExit((exitCode) => {
        for (const [ws, state] of clientStates) {
            if (!state.authenticated)
                continue;
            send(ws, { type: "exit", exitCode });
        }
    });
    const revokeAll = (reason) => {
        for (const [ws, state] of clientStates) {
            stopHeartbeat(state);
            if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
                ws.close(4001, normalizeCloseReason(reason));
            }
        }
    };
    registerAuthRevokeHandler((reason) => {
        revokeAll(reason || "auth_revoked");
    });
    httpServer.on("upgrade", async (req, socket, head) => {
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
    wss.on("connection", (ws, req) => {
        const remoteIp = req.socket.remoteAddress ?? "";
        const state = {
            authenticated: mode === "lan",
            awaitingResume: true,
            missedPongs: 0,
            heartbeat: null,
            authTimeout: null,
            lastOffset: 0,
        };
        clientStates.set(ws, state);
        if (mode === "lan") {
            sendInitialState(ws, state, false);
        }
        else {
            state.authTimeout = setTimeout(() => {
                if (!state.authenticated && ws.readyState === WebSocket.OPEN) {
                    ws.close(4002, normalizeCloseReason("auth_timeout"));
                }
            }, 30_000);
            send(ws, { type: "auth_required", pinLength: mode === "funnel" ? 8 : 6 });
        }
        ws.on("message", async (raw) => {
            try {
                const message = JSON.parse(raw.toString());
                if (message.type === "pong") {
                    state.missedPongs = 0;
                    return;
                }
                if (!state.authenticated && message.type !== "auth_pin" && message.type !== "auth_token") {
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
                        state.awaitingResume = true;
                        state.missedPongs = 0;
                        clearAuthTimeout(state);
                        startHeartbeat(ws, state);
                        send(ws, { type: "auth_ok", token });
                        sendInitialState(ws, state, false);
                        break;
                    }
                    case "auth_token": {
                        if (!(await verifyJwt(message.token))) {
                            send(ws, { type: "auth_fail", reason: "Session expired. Re-enter the PIN." });
                            return;
                        }
                        state.authenticated = true;
                        state.awaitingResume = true;
                        state.missedPongs = 0;
                        clearAuthTimeout(state);
                        startHeartbeat(ws, state);
                        send(ws, { type: "auth_ok", token: message.token });
                        sendInitialState(ws, state, false);
                        break;
                    }
                    case "resume": {
                        sendResumedState(ws, state, message.lastOffset);
                        break;
                    }
                    case "input": {
                        ensureActiveClient(ws, clientSizes, mobileClients, () => {
                            const mobileSize = getMobileSize(mobileClients, clientSizes);
                            if (mobileSize) {
                                resizePty(mobileSize.cols, mobileSize.rows);
                                return;
                            }
                            const currentSize = clientSizes.get(ws);
                            if (currentSize)
                                resizePty(currentSize.cols, currentSize.rows);
                        }, () => {
                            activeWs = ws;
                        });
                        writeToPty(message.data);
                        break;
                    }
                    case "resize": {
                        clientSizes.set(ws, { cols: message.cols, rows: message.rows });
                        if (message.mobile) {
                            mobileClients.add(ws);
                            resizePty(message.cols, message.rows);
                            activeWs = ws;
                        }
                        else if (mobileClients.size === 0 && (activeWs === ws || activeWs === null)) {
                            activeWs = ws;
                            resizePty(message.cols, message.rows);
                        }
                        break;
                    }
                }
            }
            catch {
                // ignore malformed WS payloads
            }
        });
        ws.on("close", () => {
            stopHeartbeat(state);
            clearAuthTimeout(state);
            clientStates.delete(ws);
            clientSizes.delete(ws);
            mobileClients.delete(ws);
            if (activeWs === ws) {
                activeWs = null;
                const mobileSize = getMobileSize(mobileClients, clientSizes);
                if (mobileSize) {
                    resizePty(mobileSize.cols, mobileSize.rows);
                }
                else {
                    for (const [candidate, size] of clientSizes) {
                        if (candidate.readyState !== WebSocket.OPEN)
                            continue;
                        activeWs = candidate;
                        resizePty(size.cols, size.rows);
                        break;
                    }
                }
            }
        });
    });
    return async () => {
        removePtyDataListener();
        removePtyExitListener();
        for (const state of clientStates.values()) {
            stopHeartbeat(state);
            clearAuthTimeout(state);
        }
        await new Promise((resolve) => {
            wss.close(() => resolve());
        });
    };
}
function sendInitialState(ws, state, allowFullReplay) {
    if (!state.authenticated)
        return;
    const ptyState = getPtyState();
    send(ws, { type: "state", ...ptyState });
    const snapshot = getPtyOutputBuffer().getAll();
    state.lastOffset = snapshot.offset;
    if (allowFullReplay && snapshot.data) {
        send(ws, { type: "data", data: snapshot.data, offset: snapshot.offset });
    }
    if (state.heartbeat === null) {
        startHeartbeat(ws, state);
    }
}
function sendResumedState(ws, state, lastOffset) {
    if (!state.authenticated)
        return;
    state.awaitingResume = false;
    const delta = getPtyOutputBuffer().getFrom(lastOffset);
    if (delta === null) {
        send(ws, { type: "reset" });
        const snapshot = getPtyOutputBuffer().getAll();
        if (snapshot.data) {
            send(ws, { type: "data", data: snapshot.data, offset: snapshot.offset });
        }
        state.lastOffset = snapshot.offset;
        return;
    }
    if (delta.data) {
        send(ws, { type: "data", data: delta.data, offset: delta.newOffset });
    }
    state.lastOffset = delta.newOffset;
}
function startHeartbeat(ws, state) {
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
function stopHeartbeat(state) {
    if (state.heartbeat) {
        clearInterval(state.heartbeat);
        state.heartbeat = null;
    }
}
function clearAuthTimeout(state) {
    if (state.authTimeout) {
        clearTimeout(state.authTimeout);
        state.authTimeout = null;
    }
}
function getMobileSize(mobileClients, clientSizes) {
    for (const mobileClient of mobileClients) {
        if (mobileClient.readyState !== WebSocket.OPEN)
            continue;
        const size = clientSizes.get(mobileClient);
        if (size)
            return size;
    }
    return null;
}
function ensureActiveClient(ws, clientSizes, mobileClients, applySize, markActive) {
    markActive();
    const mobileSize = getMobileSize(mobileClients, clientSizes);
    if (mobileSize) {
        resizePty(mobileSize.cols, mobileSize.rows);
        return;
    }
    applySize();
}
//# sourceMappingURL=ws.js.map