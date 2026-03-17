import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";

export const isMobile = /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent);

export const VIRTUAL_KEYS = [
  { label: "↑", seq: "\x1b[A" },
  { label: "↓", seq: "\x1b[B" },
  { label: "←", seq: "\x1b[D" },
  { label: "→", seq: "\x1b[C" },
  { label: "Enter", seq: "\r" },
  { label: "Tab", seq: "\t" },
  { label: "Esc", seq: "\x1b" },
  { label: "Ctrl+C", seq: "\x03" },
] as const;

export type ConnectionState = "connected" | "reconnecting" | "disconnected";

interface TerminalViewOptions {
  requiresAuth: boolean;
  initialToken?: string;
  onConnectionStateChange?: (state: ConnectionState) => void;
  onAuthRequired?: (reason?: string) => void;
}

type BrowserMessage =
  | { type: "input"; data: string }
  | { type: "resize"; cols: number; rows: number; mobile?: boolean }
  | { type: "auth_token"; token: string }
  | { type: "resume"; lastOffset: number }
  | { type: "pong" };

type ServerMessage =
  | { type: "data"; data: string; offset?: number }
  | { type: "exit"; exitCode: number | null }
  | { type: "state"; running: boolean; exitCode: number | null }
  | { type: "auth_required"; pinLength: number }
  | { type: "auth_ok"; token: string }
  | { type: "auth_fail"; reason: string }
  | { type: "ping" }
  | { type: "reset" };

export class TerminalView {
  private terminal: Terminal;
  private fitAddon: FitAddon;
  private webglAddon: WebglAddon | null = null;
  private ws: WebSocket | null = null;
  private resizeObserver: ResizeObserver | null = null;
  private container: HTMLElement;
  private writeBuffer = "";
  private writeTimer: number | null = null;
  private stopMobileMomentum: (() => void) | null = null;
  private inputBuffer = "";
  private inputTimer: number | null = null;
  private composing = false;
  private reconnectTimer: number | null = null;
  private token: string | null;
  private lastOffset = 0;
  private connectionState: ConnectionState = "disconnected";
  private disposed = false;

  constructor(container: HTMLElement, private readonly options: TerminalViewOptions) {
    this.container = container;
    this.token = options.initialToken ?? sessionStorage.getItem("piRemoteJwt");

    this.terminal = new Terminal({
      cursorBlink: !isMobile,
      fontSize: isMobile ? 11 : 13,
      fontFamily: 'Menlo, Monaco, "Courier New", monospace',
      theme: {
        background: "#0a0a0a",
        foreground: "#d4d4d4",
        cursor: "#d4d4d4",
        selectionBackground: "#264f78",
      },
      allowProposedApi: true,
      scrollback: isMobile ? 500 : 1000,
    });

    this.fitAddon = new FitAddon();
    this.terminal.loadAddon(this.fitAddon);
    this.terminal.open(container);

    try {
      this.webglAddon = new WebglAddon();
      this.webglAddon.onContextLoss(() => {
        this.webglAddon?.dispose();
        this.webglAddon = null;
      });
      this.terminal.loadAddon(this.webglAddon);
    } catch {
      this.webglAddon = null;
    }

    // IME composition tracking — suppress input during Korean/CJK composition
    const textareaEl = this.container.querySelector(".xterm-helper-textarea") as HTMLTextAreaElement | null;
    if (textareaEl) {
      textareaEl.addEventListener("compositionstart", () => {
        this.composing = true;
      });
      textareaEl.addEventListener("compositionend", () => {
        this.composing = false;
      });
    }

    this.terminal.onData((data) => {
      if (this.composing) return; // suppress intermediate IME keystrokes
      this.bufferInput(data);
    });

    if (isMobile) {
      requestAnimationFrame(() => this.mobileFixedResize());
      this.setupMobileTouchScroll();
    } else {
      requestAnimationFrame(() => {
        this.fitAddon.fit();
        this.terminal.focus();
      });
      this.setupResizeObserver();
    }

    this.connect();
  }

  sendInput(data: string): void {
    this.send({ type: "input", data });
  }

  /** Buffer rapid keystrokes and flush once per animation frame */
  private bufferInput(data: string): void {
    this.inputBuffer += data;
    if (this.inputTimer === null) {
      this.inputTimer = requestAnimationFrame(() => {
        this.inputTimer = null;
        if (this.inputBuffer) {
          this.send({ type: "input", data: this.inputBuffer });
          this.inputBuffer = "";
        }
      });
    }
  }

  setToken(token: string | null): void {
    this.token = token;
    if (token) {
      sessionStorage.setItem("piRemoteJwt", token);
    } else {
      sessionStorage.removeItem("piRemoteJwt");
    }
  }

  private connect(): void {
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const token = new URLSearchParams(window.location.search).get("token");
    const tokenQuery = token ? `?token=${encodeURIComponent(token)}` : "";
    const wsUrl = `${protocol}//${window.location.host}/ws/terminal${tokenQuery}`;

    this.setConnectionState(this.options.requiresAuth && this.token ? "reconnecting" : "disconnected");
    this.ws = new WebSocket(wsUrl);

    this.ws.onopen = () => {
      this.sendResize();
      if (!this.options.requiresAuth) {
        this.sendResume();
      }
    };

    this.ws.onmessage = (event) => {
      try {
        const message = JSON.parse(String(event.data)) as ServerMessage;
        this.handleServerMessage(message);
      } catch {
        // ignore malformed messages
      }
    };

    this.ws.onclose = (event) => {
      if (this.disposed || !this.container.isConnected) return;

      if (event.code === 4001) {
        this.setToken(null);
        this.setConnectionState("disconnected");
        this.options.onAuthRequired?.("PIN changed. Re-enter the new PIN.");
        return;
      }

      this.scheduleReconnect();
    };

    this.ws.onerror = () => {
      this.setConnectionState("reconnecting");
    };
  }

  private handleServerMessage(message: ServerMessage): void {
    switch (message.type) {
      case "auth_required":
        if (this.token) {
          this.send({ type: "auth_token", token: this.token });
        } else {
          this.setConnectionState("disconnected");
          this.options.onAuthRequired?.();
        }
        break;
      case "auth_ok":
        this.setToken(message.token);
        this.sendResume();
        this.setConnectionState("connected");
        break;
      case "auth_fail":
        this.setToken(null);
        this.setConnectionState("disconnected");
        this.options.onAuthRequired?.(message.reason);
        break;
      case "state":
        if (!message.running && message.exitCode !== null) {
          this.flushWrite();
          this.terminal.write(`\x1b[33mProcess exited (code ${message.exitCode})\x1b[0m\r\n`);
        }
        break;
      case "data":
        this.throttledWrite(message.data);
        if (typeof message.offset === "number") {
          this.lastOffset = message.offset;
        } else {
          this.lastOffset += message.data.length;
        }
        this.setConnectionState("connected");
        break;
      case "exit":
        this.flushWrite();
        this.terminal.write(`\r\n\x1b[33mProcess exited (code ${message.exitCode ?? "?"})\x1b[0m\r\n`);
        break;
      case "ping":
        this.send({ type: "pong" });
        break;
      case "reset":
        this.terminal.reset();
        this.lastOffset = 0;
        break;
    }
  }

  private send(message: BrowserMessage): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(message));
    }
  }

  private sendResize(): void {
    const payload: BrowserMessage = {
      type: "resize",
      cols: this.terminal.cols,
      rows: this.terminal.rows,
      ...(isMobile ? { mobile: true } : {}),
    };
    this.send(payload);
  }

  private sendResume(): void {
    this.send({ type: "resume", lastOffset: this.lastOffset });
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer !== null) return;
    this.setConnectionState("reconnecting");
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = null;
      if (!this.disposed && this.container.isConnected) {
        this.connect();
      }
    }, 2000);
  }

  private setConnectionState(state: ConnectionState): void {
    this.connectionState = state;
    this.options.onConnectionStateChange?.(state);
  }

  private throttledWrite(data: string): void {
    this.writeBuffer += data;
    if (this.writeTimer === null) {
      this.writeTimer = requestAnimationFrame(() => this.flushWrite());
    }
  }

  private flushWrite(): void {
    if (this.writeTimer !== null) {
      cancelAnimationFrame(this.writeTimer);
      this.writeTimer = null;
    }
    if (this.writeBuffer) {
      this.terminal.write(this.writeBuffer);
      this.writeBuffer = "";
    }
  }

  private setupResizeObserver(): void {
    this.resizeObserver = new ResizeObserver(() => {
      try {
        this.fitAddon.fit();
        this.sendResize();
      } catch {
        // ignore resize race
      }
    });
    this.resizeObserver.observe(this.container);
  }

  private mobileFixedResize(): void {
    const cellDims = (this.terminal as Terminal & { _core?: { _renderService?: { dimensions?: { css?: { cell?: { width?: number; height?: number } } } } } })._core?._renderService?.dimensions?.css?.cell;
    if (!cellDims?.width || !cellDims?.height) {
      setTimeout(() => this.mobileFixedResize(), 50);
      return;
    }

    const mobileCols = 80;
    const availableWidth = window.innerWidth - 16;
    const availableHeight = window.innerHeight - 40 - (isMobile ? 52 : 0) - 8;
    const currentFontSize = this.terminal.options.fontSize ?? 11;
    const targetFontSize = Math.floor((currentFontSize * availableWidth) / (mobileCols * cellDims.width) * 10) / 10;

    this.terminal.options.fontSize = targetFontSize;

    requestAnimationFrame(() => {
      const newDims = (this.terminal as Terminal & { _core?: { _renderService?: { dimensions?: { css?: { cell?: { height?: number } } } } } })._core?._renderService?.dimensions?.css?.cell;
      const lineHeight = newDims?.height ?? cellDims.height ?? 15;
      const rows = Math.max(5, Math.min(Math.floor(availableHeight / lineHeight), 100));
      this.terminal.resize(mobileCols, rows);
      this.sendResize();
    });
  }

  private setupMobileTouchScroll(): void {
    const screen = this.container.querySelector(".xterm-screen") as HTMLElement | null;
    if (!screen) return;

    const term = this.terminal;
    const getLineHeight = (): number => {
      const cellDims = (term as Terminal & { _core?: { _renderService?: { dimensions?: { css?: { cell?: { height?: number } } } } } })._core?._renderService?.dimensions?.css?.cell;
      return cellDims?.height ?? 15;
    };

    let lastY = 0;
    let lastTime = 0;
    let momentumRaf: number | null = null;
    let pixelAccum = 0;
    let pendingDy = 0;
    let scrollRaf: number | null = null;
    let velocitySamples: Array<{ v: number; t: number }> = [];

    const stopMomentum = (): void => {
      if (momentumRaf !== null) {
        cancelAnimationFrame(momentumRaf);
        momentumRaf = null;
      }
      if (scrollRaf !== null) {
        cancelAnimationFrame(scrollRaf);
        scrollRaf = null;
      }
      pendingDy = 0;
      pixelAccum = 0;
    };
    this.stopMobileMomentum = stopMomentum;

    const flushScroll = (): void => {
      scrollRaf = null;
      if (pendingDy === 0) return;
      pixelAccum += pendingDy;
      pendingDy = 0;
      const lineHeight = getLineHeight();
      const lines = Math.trunc(pixelAccum / lineHeight);
      if (lines !== 0) {
        term.scrollLines(lines);
        pixelAccum -= lines * lineHeight;
      }
    };

    screen.addEventListener(
      "touchstart",
      (event) => {
        stopMomentum();
        if (event.touches.length !== 1) return;
        lastY = event.touches[0].clientY;
        lastTime = performance.now();
        velocitySamples = [];
      },
      { passive: true },
    );

    screen.addEventListener(
      "touchmove",
      (event) => {
        if (event.touches.length !== 1) return;
        const y = event.touches[0].clientY;
        const now = performance.now();
        const dt = now - lastTime;
        const dy = lastY - y;

        if (dt > 0) {
          const v = (dy / dt) * 16;
          velocitySamples.push({ v, t: now });
          while (velocitySamples.length > 0 && now - velocitySamples[0].t > 100) {
            velocitySamples.shift();
          }
        }

        pendingDy += dy;
        if (scrollRaf === null) {
          scrollRaf = requestAnimationFrame(flushScroll);
        }
        lastY = y;
        lastTime = now;
      },
      { passive: true },
    );

    screen.addEventListener(
      "touchend",
      () => {
        if (scrollRaf !== null) {
          cancelAnimationFrame(scrollRaf);
          scrollRaf = null;
        }
        if (pendingDy !== 0) {
          pixelAccum += pendingDy;
          pendingDy = 0;
          const lineHeight = getLineHeight();
          const lines = Math.trunc(pixelAccum / lineHeight);
          if (lines !== 0) {
            term.scrollLines(lines);
          }
          pixelAccum = 0;
        }

        let velocity = 0;
        if (velocitySamples.length >= 2) {
          let totalWeight = 0;
          let weighted = 0;
          const latest = velocitySamples[velocitySamples.length - 1].t;
          for (const sample of velocitySamples) {
            const weight = Math.max(0, 1 - (latest - sample.t) / 100);
            weighted += sample.v * weight;
            totalWeight += weight;
          }
          velocity = totalWeight > 0 ? weighted / totalWeight : 0;
        }
        velocitySamples = [];

        if (Math.abs(velocity) < 0.5) return;
        const friction = 0.95;
        let momentumAccum = 0;
        const tick = (): void => {
          if (Math.abs(velocity) < 0.3) {
            const lineHeight = getLineHeight();
            const rest = Math.round(momentumAccum / lineHeight);
            if (rest !== 0) {
              term.scrollLines(rest);
            }
            momentumRaf = null;
            return;
          }
          momentumAccum += velocity;
          const lineHeight = getLineHeight();
          const lines = Math.trunc(momentumAccum / lineHeight);
          if (lines !== 0) {
            term.scrollLines(lines);
            momentumAccum -= lines * lineHeight;
          }
          velocity *= friction;
          momentumRaf = requestAnimationFrame(tick);
        };
        momentumRaf = requestAnimationFrame(tick);
      },
      { passive: true },
    );
  }

  dispose(): void {
    this.disposed = true;
    this.stopMobileMomentum?.();
    if (this.writeTimer !== null) {
      cancelAnimationFrame(this.writeTimer);
    }
    if (this.inputTimer !== null) {
      cancelAnimationFrame(this.inputTimer);
    }
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
    }
    this.ws?.close();
    this.resizeObserver?.disconnect();
    this.webglAddon?.dispose();
    this.terminal.dispose();
  }
}
