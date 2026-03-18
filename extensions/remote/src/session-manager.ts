import { randomUUID } from "node:crypto";
import pty, { type IPty } from "node-pty";
import { WebSocket } from "ws";
import {
  detachLocalStdin,
  fixSpawnHelperPermissions,
  registerLocalStdinListener,
  type PtyDataListener,
  type PtyExitListener,
} from "./pty.js";
import { OutputBuffer } from "./session.js";

export interface SessionInfo {
  id: string;
  name: string;
  state: "running" | "exited";
  exitCode: number | null;
  createdAt: number;
  attachLocal: boolean;
  lastActivity: number;
}

export interface ClientSize {
  cols: number;
  rows: number;
}

export interface CreateSessionOptions {
  name?: string;
  piPath: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  cols?: number;
  rows?: number;
  attachLocal?: boolean;
  fromSessionId?: string;
  sessionFile?: string;
}

interface SessionManagerOptions {
  piPath: string;
  args?: string[];
  cwd: string;
  env?: Record<string, string>;
  cols?: number;
  rows?: number;
  maxSessions?: number;
  sessionTtlMs?: number;
}

type SessionUpdateListener = (session: SessionInfo) => void;
type SessionRemovedListener = (sessionId: string) => void;
type SessionKilledListener = (sessionId: string) => void;
type RunningCountListener = (count: number) => void;

const TITLE_REGEX = /\x1b\]0;(.*?)(\x07|\x1b\\)/g;

function normalizeSessionName(value: string | undefined, fallback: string): string {
  const trimmed = value?.trim();
  return trimmed ? trimmed : fallback;
}

export class Session {
  readonly id: string;
  readonly cwd: string;
  readonly outputBuffer = new OutputBuffer();

  private pty: IPty | null;
  private readonly dataListeners: PtyDataListener[] = [];
  private readonly exitListeners: PtyExitListener[] = [];
  private readonly updateListeners: SessionUpdateListener[] = [];
  private readonly viewers = new Set<WebSocket>();
  private readonly pendingViewers = new Set<WebSocket>();
  private readonly viewerSizes = new Map<WebSocket, ClientSize>();
  private readonly mobileViewers = new Set<WebSocket>();
  private activeViewer: WebSocket | null = null;
  private stdinDataListener: ((data: Buffer) => void) | null = null;
  private name: string;
  private exitCode: number | null = null;
  private readonly createdAt = Date.now();
  private lastActivity = this.createdAt;
  private readonly attachLocal: boolean;

  constructor(id: string, options: CreateSessionOptions, fallbackName: string) {
    this.id = id;
    this.cwd = options.cwd ?? process.cwd();
    this.attachLocal = options.attachLocal ?? false;
    this.name = normalizeSessionName(options.name, fallbackName);

    fixSpawnHelperPermissions();

    this.pty = pty.spawn(options.piPath, options.args ?? [], {
      name: "xterm-256color",
      cols: options.cols ?? 120,
      rows: options.rows ?? 30,
      cwd: this.cwd,
      env: options.env ?? (process.env as Record<string, string>),
    });

    this.pty.onData((data: string) => {
      this.outputBuffer.append(data);
      this.lastActivity = Date.now();

      if (this.attachLocal) {
        process.stdout.write(data);
      }

      let titleChanged = false;
      for (const match of data.matchAll(TITLE_REGEX)) {
        const nextTitle = match[1]?.trim();
        if (nextTitle && nextTitle !== this.name) {
          this.name = nextTitle;
          titleChanged = true;
        }
      }

      const currentOffset = this.outputBuffer.getCurrentOffset();
      for (const listener of this.dataListeners) {
        try {
          listener(data, currentOffset);
        } catch {
          // ignore listener errors
        }
      }

      if (titleChanged) {
        this.emitUpdate();
      }
    });

    this.pty.onExit(({ exitCode }: { exitCode: number }) => {
      this.exitCode = exitCode;
      this.pty = null;
      if (this.attachLocal) {
        this.detachLocalStdin();
      }

      for (const listener of this.exitListeners) {
        try {
          listener(exitCode);
        } catch {
          // ignore listener errors
        }
      }

      this.emitUpdate();
    });

    if (this.attachLocal) {
      this.stdinDataListener = (data: Buffer) => {
        this.pty?.write(data.toString());
      };
      registerLocalStdinListener(this.stdinDataListener);
    }
  }

  write(data: string, viewer: WebSocket): void {
    if (!this.pty) return;
    this.activeViewer = viewer;
    this.applyPreferredSize(viewer);
    this.pty.write(data);
  }

  resize(ws: WebSocket, cols: number, rows: number, mobile = false): void {
    this.viewerSizes.set(ws, { cols, rows });
    if (mobile) {
      this.mobileViewers.add(ws);
    } else {
      this.mobileViewers.delete(ws);
    }
    this.applyEffectiveSize();
  }

  attachViewer(ws: WebSocket): void {
    this.pendingViewers.add(ws);
    this.viewers.delete(ws);
  }

  activateViewer(ws: WebSocket): void {
    this.pendingViewers.delete(ws);
    this.viewers.add(ws);
    this.activeViewer = ws;
    this.applyPreferredSize(ws);
  }

  detachViewer(ws: WebSocket): void {
    this.pendingViewers.delete(ws);
    this.viewers.delete(ws);
    this.viewerSizes.delete(ws);
    this.mobileViewers.delete(ws);

    if (this.activeViewer === ws) {
      this.activeViewer = this.findFirstOpenViewer();
      this.applyEffectiveSize();
    }
  }

  getLiveViewers(): WebSocket[] {
    return [...this.viewers].filter((viewer) => viewer.readyState === WebSocket.OPEN);
  }

  kill(): void {
    if (this.attachLocal) {
      this.detachLocalStdin();
    }
    if (!this.pty) return;
    try {
      this.pty.kill();
    } catch {
      // ignore
    }
    this.pty = null;
  }

  getState(): SessionInfo {
    return {
      id: this.id,
      name: this.name,
      state: this.pty ? "running" : "exited",
      exitCode: this.exitCode,
      createdAt: this.createdAt,
      attachLocal: this.attachLocal,
      lastActivity: this.lastActivity,
    };
  }

  setTitle(title: string): boolean {
    const next = title.trim();
    if (!next || next === this.name) {
      return false;
    }

    this.name = next;
    this.emitUpdate();
    return true;
  }

  onData(cb: PtyDataListener): () => void {
    this.dataListeners.push(cb);
    return () => {
      const index = this.dataListeners.indexOf(cb);
      if (index >= 0) {
        this.dataListeners.splice(index, 1);
      }
    };
  }

  onExit(cb: PtyExitListener): () => void {
    this.exitListeners.push(cb);
    return () => {
      const index = this.exitListeners.indexOf(cb);
      if (index >= 0) {
        this.exitListeners.splice(index, 1);
      }
    };
  }

  onUpdate(cb: SessionUpdateListener): () => void {
    this.updateListeners.push(cb);
    return () => {
      const index = this.updateListeners.indexOf(cb);
      if (index >= 0) {
        this.updateListeners.splice(index, 1);
      }
    };
  }

  private emitUpdate(): void {
    const state = this.getState();
    for (const listener of this.updateListeners) {
      try {
        listener(state);
      } catch {
        // ignore listener errors
      }
    }
  }

  private detachLocalStdin(): void {
    if (!this.stdinDataListener) {
      detachLocalStdin();
      return;
    }

    if (process.stdin.isTTY) {
      process.stdin.off("data", this.stdinDataListener);
    }
    this.stdinDataListener = null;
    detachLocalStdin();
  }

  private applyPreferredSize(preferredViewer?: WebSocket | null): void {
    const effective = this.getEffectiveSize(preferredViewer ?? this.activeViewer);
    if (!effective || !this.pty) return;

    try {
      this.pty.resize(effective.cols, effective.rows);
    } catch {
      // ignore resize failures while exiting
    }
  }

  private applyEffectiveSize(): void {
    this.applyPreferredSize(this.activeViewer);
  }

  private getEffectiveSize(preferredViewer?: WebSocket | null): ClientSize | null {
    const mobileSize = this.getOpenMobileSize();
    if (mobileSize) {
      return mobileSize;
    }

    if (preferredViewer && preferredViewer.readyState === WebSocket.OPEN) {
      const preferredSize = this.viewerSizes.get(preferredViewer);
      if (preferredSize) return preferredSize;
    }

    if (this.activeViewer && this.activeViewer.readyState === WebSocket.OPEN) {
      const activeSize = this.viewerSizes.get(this.activeViewer);
      if (activeSize) return activeSize;
    }

    for (const viewer of this.viewers) {
      if (viewer.readyState !== WebSocket.OPEN) continue;
      const size = this.viewerSizes.get(viewer);
      if (size) return size;
    }

    for (const viewer of this.pendingViewers) {
      if (viewer.readyState !== WebSocket.OPEN) continue;
      const size = this.viewerSizes.get(viewer);
      if (size) return size;
    }

    return null;
  }

  private getOpenMobileSize(): ClientSize | null {
    for (const viewer of this.mobileViewers) {
      if (viewer.readyState !== WebSocket.OPEN) continue;
      const size = this.viewerSizes.get(viewer);
      if (size) return size;
    }
    return null;
  }

  private findFirstOpenViewer(): WebSocket | null {
    for (const viewer of this.viewers) {
      if (viewer.readyState === WebSocket.OPEN) {
        return viewer;
      }
    }
    return null;
  }
}

export class SessionManager {
  private readonly sessions = new Map<string, Session>();
  private readonly removalTimers = new Map<string, NodeJS.Timeout>();
  private readonly updateListeners: SessionUpdateListener[] = [];
  private readonly createdListeners: SessionUpdateListener[] = [];
  private readonly removedListeners: SessionRemovedListener[] = [];
  private readonly killedListeners: SessionKilledListener[] = [];
  private readonly runningCountListeners: RunningCountListener[] = [];
  private nextFallbackIndex = 1;
  private readonly maxSessions: number;
  private readonly sessionTtlMs: number;

  constructor(private readonly options: SessionManagerOptions) {
    const envMaxSessions = Number.parseInt(process.env.PI_REMOTE_MAX_SESSIONS ?? "3", 10);
    const envSessionTtl = Number.parseInt(process.env.PI_REMOTE_SESSION_TTL ?? `${5 * 60 * 1000}`, 10);

    this.maxSessions = options.maxSessions ?? (Number.isFinite(envMaxSessions) ? envMaxSessions : 3);
    this.sessionTtlMs = options.sessionTtlMs ?? (Number.isFinite(envSessionTtl) ? envSessionTtl : 5 * 60 * 1000);
  }

  create(options: Partial<CreateSessionOptions> = {}): Session {
    if (this.runningCount() >= this.maxSessions) {
      throw new Error(`session_limit_exceeded:${this.maxSessions}`);
    }

    if (options.attachLocal && [...this.sessions.values()].some((session) => session.getState().attachLocal)) {
      throw new Error("attach_local_conflict");
    }

    const id = randomUUID().slice(0, 8);
    const fromSession = options.fromSessionId ? this.sessions.get(options.fromSessionId) : undefined;
    if (options.fromSessionId && !fromSession) {
      throw new Error("from_session_not_found");
    }
    const fallbackName = `session-${this.nextFallbackIndex}`;
    this.nextFallbackIndex += 1;

    const baseArgs = [...(options.args ?? this.options.args ?? [])];
    if (options.sessionFile) {
      // Replace existing --session with the new one
      for (let index = baseArgs.indexOf("--session"); index !== -1; index = baseArgs.indexOf("--session")) {
        baseArgs.splice(index, 2);
      }
      baseArgs.push("--session", options.sessionFile);
    } else if (!options.attachLocal) {
      // Web-created sessions must NOT inherit the launcher's --session file
      for (let index = baseArgs.indexOf("--session"); index !== -1; index = baseArgs.indexOf("--session")) {
        baseArgs.splice(index, 2);
      }
    }

    const merged: CreateSessionOptions = {
      piPath: options.piPath ?? this.options.piPath,
      args: baseArgs,
      cwd: fromSession?.cwd ?? options.cwd ?? this.options.cwd,
      env: {
        ...(this.options.env ?? (process.env as Record<string, string>)),
        ...(options.env ?? {}),
        PI_REMOTE_SESSION_ID: id,
        PI_REMOTE_ATTACH_LOCAL: options.attachLocal ? "1" : "0",
      },
      cols: options.cols ?? this.options.cols ?? 80,
      rows: options.rows ?? this.options.rows ?? 24,
      attachLocal: options.attachLocal ?? false,
      name: options.name,
      fromSessionId: options.fromSessionId,
    };

    const session = new Session(id, merged, fallbackName);
    this.sessions.set(id, session);
    this.clearRemovalTimer(id);

    session.onUpdate((state) => {
      this.emitUpdated(state);
    });

    session.onExit(() => {
      this.scheduleRemoval(id);
      this.emitRunningCount();
    });

    this.emitCreated(session.getState());
    this.emitRunningCount();
    return session;
  }

  get(id: string): Session | undefined {
    return this.sessions.get(id);
  }

  kill(id: string): void {
    const session = this.sessions.get(id);
    if (!session) return;
    session.kill();
    this.emitKilled(id);
  }

  list(): SessionInfo[] {
    return [...this.sessions.values()]
      .map((session) => session.getState())
      .sort((left, right) => left.createdAt - right.createdAt);
  }

  runningCount(): number {
    return [...this.sessions.values()].filter((session) => session.getState().state === "running").length;
  }

  killAll(): void {
    const sessions = [...this.sessions.values()];
    for (const session of sessions.filter((entry) => !entry.getState().attachLocal)) {
      session.kill();
    }
    for (const session of sessions.filter((entry) => entry.getState().attachLocal)) {
      session.kill();
    }
  }

  onCreated(cb: SessionUpdateListener): () => void {
    this.createdListeners.push(cb);
    return () => this.removeListener(this.createdListeners, cb);
  }

  onUpdated(cb: SessionUpdateListener): () => void {
    this.updateListeners.push(cb);
    return () => this.removeListener(this.updateListeners, cb);
  }

  onRemoved(cb: SessionRemovedListener): () => void {
    this.removedListeners.push(cb);
    return () => this.removeListener(this.removedListeners, cb);
  }

  onKilled(cb: SessionKilledListener): () => void {
    this.killedListeners.push(cb);
    return () => this.removeListener(this.killedListeners, cb);
  }

  onRunningCountChange(cb: RunningCountListener): () => void {
    this.runningCountListeners.push(cb);
    return () => this.removeListener(this.runningCountListeners, cb);
  }

  private emitCreated(session: SessionInfo): void {
    for (const listener of this.createdListeners) {
      try {
        listener(session);
      } catch {
        // ignore listener errors
      }
    }
  }

  private emitUpdated(session: SessionInfo): void {
    for (const listener of this.updateListeners) {
      try {
        listener(session);
      } catch {
        // ignore listener errors
      }
    }
  }

  private emitRemoved(sessionId: string): void {
    for (const listener of this.removedListeners) {
      try {
        listener(sessionId);
      } catch {
        // ignore listener errors
      }
    }
  }

  private emitKilled(sessionId: string): void {
    for (const listener of this.killedListeners) {
      try {
        listener(sessionId);
      } catch {
        // ignore listener errors
      }
    }
  }

  private emitRunningCount(): void {
    const count = this.runningCount();
    for (const listener of this.runningCountListeners) {
      try {
        listener(count);
      } catch {
        // ignore listener errors
      }
    }
  }

  private scheduleRemoval(sessionId: string): void {
    this.clearRemovalTimer(sessionId);
    const timer = setTimeout(() => {
      this.removalTimers.delete(sessionId);
      this.sessions.delete(sessionId);
      this.emitRemoved(sessionId);
    }, this.sessionTtlMs);
    this.removalTimers.set(sessionId, timer);
  }

  private clearRemovalTimer(sessionId: string): void {
    const timer = this.removalTimers.get(sessionId);
    if (timer) {
      clearTimeout(timer);
      this.removalTimers.delete(sessionId);
    }
  }

  private removeListener<T>(listeners: T[], listener: T): void {
    const index = listeners.indexOf(listener);
    if (index >= 0) {
      listeners.splice(index, 1);
    }
  }
}
