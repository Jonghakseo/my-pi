import QRCode from "qrcode";
import { getRemoteInfo, showAuthScreen, type RemoteInfo } from "./auth.js";
import { setupPwa } from "./pwa.js";
import { isMobile, TerminalView, VIRTUAL_KEYS, type ConnectionState } from "./terminal.js";

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
  #terminal-wrap { flex: 1; overflow: hidden; padding: 4px 8px; position: relative; }
  #terminal-wrap .xterm { height: 100%; }
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
`;
document.head.appendChild(style);

const app = document.getElementById("app");
if (!app) {
  throw new Error("#app container not found");
}

const topbar = document.createElement("div");
topbar.id = "topbar";
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
topbar.append(title, status, spacer, reauthBtn, remoteBtn);
app.appendChild(topbar);

const termWrap = document.createElement("div");
termWrap.id = "terminal-wrap";
app.appendChild(termWrap);

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
let latestAuthMessage: string | undefined;
let isOpeningAuth = false;

function updateStatus(nextState: ConnectionState): void {
  const icon = nextState === "connected" ? "🟢" : nextState === "reconnecting" ? "🟡" : "🔴";
  const text = nextState === "connected" ? "Connected" : nextState === "reconnecting" ? "Reconnecting" : "Disconnected";
  status.textContent = `${icon} ${text}`;
}

function mountTerminal(token?: string): void {
  if (!remoteInfo) {
    throw new Error("Remote info not loaded");
  }

  isOpeningAuth = false;
  authRoot.classList.add("hidden");
  authRoot.replaceChildren();
  termWrap.replaceChildren();
  terminalView?.dispose();

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
  });
}

async function openAuth(): Promise<void> {
  if (!remoteInfo) {
    remoteInfo = await getRemoteInfo();
  }

  if (remoteInfo.mode === "lan") {
    mountTerminal();
    return;
  }

  isOpeningAuth = true;
  authRoot.classList.remove("hidden");
  await showAuthScreen(authRoot, (token) => {
    latestAuthMessage = undefined;
    mountTerminal(token);
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
  void openAuth();
});

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

void (async () => {
  remoteInfo = await getRemoteInfo();

  if (remoteInfo.mode === "lan") {
    mountTerminal();
  } else {
    const existingToken = sessionStorage.getItem("piRemoteJwt");
    if (existingToken) {
      mountTerminal(existingToken);
    } else {
      await openAuth();
    }
  }

  if (!isMobile) {
    overlay.classList.remove("hidden");
    await renderRemoteOverlay();
  }
})();
