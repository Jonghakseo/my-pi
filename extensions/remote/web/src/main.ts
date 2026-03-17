import QRCode from "qrcode";
import { getRemoteInfo, showAuthScreen, type RemoteInfo } from "./auth.js";
import { setupPwa } from "./pwa.js";
import { SessionListView } from "./session-list.js";
import type { ConnectionState } from "./session-types.js";
import { isMobile, TerminalView, VIRTUAL_KEYS } from "./terminal.js";

const style = document.createElement("style");
style.textContent = `
  #app {
    display: flex;
    flex-direction: column;
    height: 100dvh;
    background: #0a0a0a;
    color: #d4d4d4;
  }
  #topbar {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 0 12px;
    height: 40px;
    background: #141414;
    border-bottom: 1px solid #2a2a2a;
    flex-shrink: 0;
    font-size: 13px;
  }
  #topbar .title { font-weight: 600; letter-spacing: 0.05em; color: #e0e0e0; }
  #topbar .spacer { margin-right: auto; }
  #topbar .status { font-size: 12px; color: #9a9a9a; }
  #topbar button {
    background: none;
    border: 1px solid #3a3a3a;
    border-radius: 5px;
    color: #bbb;
    font-size: 12px;
    padding: 3px 10px;
    cursor: pointer;
  }
  #topbar button:hover { background: #2a2a2a; color: #fff; }
  #topbar .mobile-back.hidden { display: none; }
  #content {
    flex: 1;
    min-height: 0;
    display: flex;
    overflow: hidden;
  }
  #sidebar {
    width: 180px;
    border-right: 1px solid #2a2a2a;
    background: #111;
    min-height: 0;
    display: flex;
  }
  #terminal-wrap, #session-view {
    flex: 1;
    overflow: hidden;
    padding: 4px 8px;
    position: relative;
    min-height: 0;
  }
  #session-view { padding: 0; }
  .terminal-shell, .terminal-host { height: 100%; }
  .terminal-host .xterm { height: 100%; }
  .terminal-blank {
    position: absolute;
    inset: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 24px;
    text-align: center;
    color: #8e8e8e;
    background: rgba(10, 10, 10, 0.95);
    z-index: 2;
  }
  .terminal-blank.hidden { display: none; }
  .session-list {
    display: flex;
    flex-direction: column;
    width: 100%;
    min-height: 0;
  }
  .session-list-header {
    padding: 12px;
    border-bottom: 1px solid #222;
    font-size: 12px;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: #8a8a8a;
  }
  .session-list-items {
    flex: 1;
    min-height: 0;
    overflow: auto;
    padding: 8px;
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .session-list-create {
    margin: 8px;
    padding: 10px 12px;
    border-radius: 8px;
    border: 1px solid #333;
    background: #1a1a1a;
    color: #e0e0e0;
    cursor: pointer;
  }
  .session-item {
    display: flex;
    gap: 10px;
    align-items: center;
    width: 100%;
    text-align: left;
    border: 1px solid #222;
    background: #151515;
    color: #d6d6d6;
    border-radius: 8px;
    padding: 10px;
    cursor: pointer;
  }
  .session-item.active {
    border-color: #444;
    background: #202020;
  }
  .session-item-status {
    width: 16px;
    text-align: center;
    flex-shrink: 0;
  }
  .session-item-content {
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .session-item-name {
    font-size: 13px;
    color: #f0f0f0;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .session-item-meta {
    font-size: 11px;
    color: #898989;
  }
  #keybar {
    display: flex;
    gap: 4px;
    padding: 4px 8px;
    background: #141414;
    border-top: 1px solid #2a2a2a;
    flex-shrink: 0;
    height: 52px;
    align-items: center;
    overflow-x: auto;
  }
  #keybar button {
    background: #1e1e1e;
    border: 1px solid #3a3a3a;
    border-radius: 5px;
    color: #d4d4d4;
    font-size: 12px;
    padding: 4px 10px;
    white-space: nowrap;
    cursor: pointer;
    user-select: none;
    -webkit-user-select: none;
  }
  #overlay, #auth-root {
    position: fixed;
    inset: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    background: rgba(0, 0, 0, 0.85);
    z-index: 100;
  }
  #overlay.hidden, #auth-root.hidden { display: none; }
  .card, #auth-screen .auth-card {
    background: #1a1a1a;
    border: 1px solid #333;
    border-radius: 10px;
    padding: 24px 28px;
    max-width: 360px;
    width: 92%;
    text-align: center;
  }
  .card h2, #auth-screen h2 { margin-bottom: 8px; font-size: 16px; color: #e0e0e0; }
  .card p, #auth-screen p { font-size: 12px; color: #888; margin-bottom: 16px; }
  #remote-url {
    background: #111;
    border: 1px solid #333;
    border-radius: 5px;
    padding: 6px 10px;
    font-size: 11px;
    word-break: break-all;
    color: #aaa;
    margin-bottom: 14px;
    text-align: left;
  }
  #remote-extra { color: #8d8d8d; font-size: 11px; margin-bottom: 14px; line-height: 1.5; }
  #overlay-buttons { display: flex; gap: 8px; justify-content: center; }
  #overlay-buttons button, #auth-screen button {
    background: #222;
    border: 1px solid #444;
    border-radius: 5px;
    color: #ccc;
    font-size: 12px;
    padding: 8px 14px;
    cursor: pointer;
  }
  #overlay-buttons button.primary { border-color: #555; color: #fff; background: #2a2a2a; }
  #auth-form { display: flex; flex-direction: column; gap: 10px; }
  #auth-pin {
    border: 1px solid #444;
    border-radius: 8px;
    background: #111;
    color: #f2f2f2;
    font-size: 22px;
    text-align: center;
    letter-spacing: 0.18em;
    padding: 12px;
  }
  #auth-error { min-height: 18px; color: #ff9b9b; font-size: 12px; margin-top: 10px; }
  #auth-screen .auth-meta { margin-top: 12px; color: #8d8d8d; font-size: 11px; line-height: 1.5; }
  @media (max-width: 768px) {
    #content.mobile { display: block; }
    #sidebar, #terminal-wrap, #session-view {
      width: 100%;
      border-right: 0;
      padding: 0;
      height: 100%;
    }
    #topbar .mobile-back.hidden { display: none; }
    #topbar .mobile-back { padding: 3px 8px; }
  }
`;
document.head.appendChild(style);

const app = document.getElementById("app");
if (!app) {
  throw new Error("#app container not found");
}

const topbar = document.createElement("div");
topbar.id = "topbar";
const backBtn = document.createElement("button");
backBtn.className = "mobile-back hidden";
backBtn.textContent = "←";
const title = document.createElement("span");
title.className = "title";
title.textContent = "π remote";
const status = document.createElement("span");
status.className = "status";
const spacer = document.createElement("span");
spacer.className = "spacer";
const reauthBtn = document.createElement("button");
reauthBtn.textContent = "Re-auth";
const remoteBtn = document.createElement("button");
remoteBtn.textContent = isMobile ? "Info" : "Remote link";
topbar.append(backBtn, title, status, spacer, reauthBtn, remoteBtn);
app.appendChild(topbar);

const content = document.createElement("div");
content.id = "content";
if (isMobile) {
  content.classList.add("mobile");
}
app.appendChild(content);

const sidebar = document.createElement("div");
sidebar.id = "sidebar";
const sessionView = document.createElement("div");
sessionView.id = "session-view";
const termWrap = document.createElement("div");
termWrap.id = "terminal-wrap";

if (isMobile) {
  content.append(sessionView, termWrap);
} else {
  content.append(sidebar, termWrap);
}

let keybar: HTMLElement | null = null;
if (isMobile) {
  keybar = document.createElement("div");
  keybar.id = "keybar";
  app.appendChild(keybar);
}

const overlay = document.createElement("div");
overlay.id = "overlay";
overlay.classList.add("hidden");
overlay.innerHTML = `
  <div class="card">
    <h2>Remote access</h2>
    <p>Scan the QR code or open the link in a browser.</p>
    <canvas id="qr-canvas"></canvas>
    <div id="remote-url">Loading…</div>
    <div id="remote-extra"></div>
    <div id="overlay-buttons">
      <button id="copy-btn">Copy link</button>
      <button id="close-btn" class="primary">Close</button>
    </div>
  </div>
`;
document.body.appendChild(overlay);

const authRoot = document.createElement("div");
authRoot.id = "auth-root";
authRoot.classList.add("hidden");
document.body.appendChild(authRoot);

let remoteInfo: RemoteInfo | null = null;
let terminalView: TerminalView | null = null;
let sessionListView: SessionListView | null = null;
let latestAuthMessage: string | undefined;
let isOpeningAuth = false;
let currentView: "list" | "terminal" = isMobile ? "list" : "terminal";
let autoSelectedDesktop = false;

function updateStatus(nextState: ConnectionState): void {
  const icon = nextState === "connected" ? "🟢" : nextState === "reconnecting" ? "🟡" : "🔴";
  const text = nextState === "connected" ? "Connected" : nextState === "reconnecting" ? "Reconnecting" : "Disconnected";
  status.textContent = `${icon} ${text}`;
}

function setCurrentView(nextView: "list" | "terminal"): void {
  currentView = nextView;

  if (!isMobile) {
    return;
  }

  const showingTerminal = nextView === "terminal";
  sessionView.style.display = showingTerminal ? "none" : "";
  termWrap.style.display = showingTerminal ? "" : "none";
  if (showingTerminal) {
    terminalView?.show();
    terminalView?.mobileFixedResizePublic();
  } else {
    terminalView?.hide();
  }
  if (keybar) {
    keybar.style.display = showingTerminal ? "flex" : "none";
  }
  backBtn.classList.toggle("hidden", !showingTerminal);
  refreshTitle();
}

function refreshTitle(): void {
  if (!isMobile) {
    title.textContent = "π remote";
    return;
  }

  const activeId = terminalView?.activeSessionId;
  const active = activeId ? sessionListView?.getSession(activeId) : undefined;
  title.textContent = currentView === "terminal" && active ? active.name : "π remote";
}

function selectSession(sessionId: string): void {
  terminalView?.switchSession(sessionId);
  sessionListView?.setActiveSession(sessionId);
  setCurrentView("terminal");
  refreshTitle();
}

function handleActiveSessionEnded(sessionId: string): void {
  sessionListView?.setActiveSession(null);
  if (terminalView?.activeSessionId === sessionId) {
    terminalView.activeSessionId = null;
  }
  if (isMobile) {
    setCurrentView("list");
  }
  refreshTitle();
}

function mountViews(token?: string): void {
  if (!remoteInfo) {
    throw new Error("Remote info not loaded");
  }

  isOpeningAuth = false;
  authRoot.classList.add("hidden");
  authRoot.replaceChildren();
  sidebar.replaceChildren();
  sessionView.replaceChildren();
  termWrap.replaceChildren();
  terminalView?.dispose();
  sessionListView?.dispose();

  const listContainer = isMobile ? sessionView : sidebar;
  sessionListView = new SessionListView(listContainer, {
    onSelect: (sessionId) => {
      selectSession(sessionId);
    },
    onCreate: () => {
      terminalView?.createSession(terminalView.activeSessionId ?? undefined);
    },
    onKill: (sessionId) => {
      terminalView?.killSession(sessionId);
    },
  });

  terminalView = new TerminalView(termWrap, {
    requiresAuth: remoteInfo.mode !== "lan",
    initialToken: token ?? sessionStorage.getItem("piRemoteJwt") ?? undefined,
    onConnectionStateChange: updateStatus,
    onAuthRequired: (reason) => {
      latestAuthMessage = reason;
      sessionStorage.removeItem("piRemoteJwt");
      if (!isOpeningAuth) {
        void openAuth();
      }
    },
    onSessionList: (sessions) => {
      sessionListView?.updateSessions(sessions);
      if (!autoSelectedDesktop && !isMobile && sessions.length > 0 && !terminalView?.activeSessionId) {
        autoSelectedDesktop = true;
        selectSession(sessions[0].id);
      }
      refreshTitle();
    },
    onSessionCreated: (session, shouldAutoSelect) => {
      sessionListView?.upsertSession(session);
      if (shouldAutoSelect) {
        selectSession(session.id);
      }
    },
    onSessionUpdated: (session) => {
      sessionListView?.upsertSession(session);
      refreshTitle();
    },
    onSessionKilled: () => {
      refreshTitle();
    },
    onSessionRemoved: (sessionId) => {
      sessionListView?.removeSession(sessionId);
      refreshTitle();
    },
    onSessionError: () => {
      // no-op for now
    },
    onActiveSessionEnded: handleActiveSessionEnded,
  });

  setCurrentView(isMobile ? "list" : "terminal");
  refreshTitle();
}

async function openAuth(): Promise<void> {
  if (!remoteInfo) {
    remoteInfo = await getRemoteInfo();
  }

  if (remoteInfo.mode === "lan") {
    mountViews();
    return;
  }

  isOpeningAuth = true;
  authRoot.classList.remove("hidden");
  await showAuthScreen(authRoot, (token) => {
    latestAuthMessage = undefined;
    mountViews(token);
  });

  if (latestAuthMessage) {
    const errorEl = authRoot.querySelector<HTMLElement>("#auth-error");
    if (errorEl) {
      errorEl.textContent = latestAuthMessage;
    }
  }
}

async function renderRemoteOverlay(): Promise<void> {
  remoteInfo ??= await getRemoteInfo();

  const urlEl = overlay.querySelector<HTMLElement>("#remote-url");
  const extraEl = overlay.querySelector<HTMLElement>("#remote-extra");
  const canvas = overlay.querySelector<HTMLCanvasElement>("#qr-canvas");
  if (!urlEl || !extraEl || !canvas) return;

  urlEl.textContent = remoteInfo.url;
  extraEl.textContent =
    remoteInfo.reason ??
    (remoteInfo.pinMayRotate ? "PIN may rotate while the session is running." : "LAN token is embedded in the URL.");

  await QRCode.toCanvas(canvas, remoteInfo.url, {
    width: 200,
    color: { dark: "#d9d9d9", light: "#141414" },
  });
}

remoteBtn.addEventListener("click", () => {
  overlay.classList.remove("hidden");
  void renderRemoteOverlay();
});

overlay.querySelector("#close-btn")?.addEventListener("click", () => {
  overlay.classList.add("hidden");
});

overlay.querySelector("#copy-btn")?.addEventListener("click", async () => {
  remoteInfo ??= await getRemoteInfo();
  navigator.clipboard.writeText(remoteInfo.url).catch(() => {});
});

reauthBtn.addEventListener("click", () => {
  sessionStorage.removeItem("piRemoteJwt");
  latestAuthMessage = undefined;
  autoSelectedDesktop = false;
  void openAuth();
});

backBtn.addEventListener("click", () => {
  setCurrentView("list");
});

if (isMobile) {
  let swipeStartX = 0;
  let swipeStartY = 0;

  termWrap.addEventListener(
    "touchstart",
    (event) => {
      if (event.touches.length !== 1) return;
      swipeStartX = event.touches[0].clientX;
      swipeStartY = event.touches[0].clientY;
    },
    { passive: true },
  );

  termWrap.addEventListener(
    "touchend",
    (event) => {
      if (currentView !== "terminal" || event.changedTouches.length !== 1) return;
      const dx = event.changedTouches[0].clientX - swipeStartX;
      const dy = event.changedTouches[0].clientY - swipeStartY;
      if (dx > 72 && Math.abs(dy) < 48) {
        setCurrentView("list");
      }
    },
    { passive: true },
  );
}

if (keybar) {
  let startX = 0;
  let startY = 0;
  let moved = false;
  let activeButton: HTMLElement | null = null;

  for (const key of VIRTUAL_KEYS) {
    const button = document.createElement("button");
    button.textContent = key.label;

    button.addEventListener(
      "touchstart",
      (event) => {
        const touch = event.touches[0];
        startX = touch.clientX;
        startY = touch.clientY;
        moved = false;
        activeButton = button;
        button.style.background = "#2e2e2e";
      },
      { passive: true },
    );

    button.addEventListener(
      "touchmove",
      (event) => {
        const touch = event.touches[0];
        const dx = touch.clientX - startX;
        const dy = touch.clientY - startY;
        if (dx * dx + dy * dy > 64) {
          moved = true;
        }
      },
      { passive: true },
    );

    button.addEventListener("touchend", (event) => {
      event.preventDefault();
      activeButton?.style.removeProperty("background");
      activeButton = null;
      if (!moved) {
        terminalView?.sendInput(key.seq);
      }
    });

    keybar.appendChild(button);
  }
}

setupPwa();
updateStatus("disconnected");
setCurrentView(isMobile ? "list" : "terminal");

void (async () => {
  remoteInfo = await getRemoteInfo();

  if (remoteInfo.mode === "lan") {
    mountViews();
  } else {
    const existingToken = sessionStorage.getItem("piRemoteJwt");
    if (existingToken) {
      mountViews(existingToken);
    } else {
      await openAuth();
    }
  }

  if (!isMobile) {
    overlay.classList.remove("hidden");
    await renderRemoteOverlay();
  }
})();
