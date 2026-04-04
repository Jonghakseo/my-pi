import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import type { BrowserMessage, ConnectionState, ServerMessage, SessionInfo } from "./session-types.js";

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

interface TerminalViewOptions {
	requiresAuth: boolean;
	initialToken?: string;
	onConnectionStateChange?: (state: ConnectionState) => void;
	onAuthRequired?: (reason?: string) => void;
	onSessionList?: (sessions: SessionInfo[]) => void;
	onSessionCreated?: (session: SessionInfo, shouldAutoSelect: boolean) => void;
	onSessionUpdated?: (session: SessionInfo) => void;
	onSessionKilled?: (sessionId: string) => void;
	onSessionRemoved?: (sessionId: string) => void;
	onSessionError?: (reason: string, sessionId?: string) => void;
	onActiveSessionEnded?: (sessionId: string) => void;
}

type ResumeMode = "switch" | "reconnect";

export class TerminalView {
	activeSessionId: string | null = null;

	private readonly terminal: Terminal;
	private readonly fitAddon: FitAddon;
	private webglAddon: WebglAddon | null = null;
	private ws: WebSocket | null = null;
	private resizeObserver: ResizeObserver | null = null;
	private readonly root: HTMLElement;
	private readonly terminalHost: HTMLElement;
	private readonly blankState: HTMLElement;
	private writeBuffer = "";
	private writeTimer: number | null = null;
	private stopMobileMomentum: (() => void) | null = null;
	private inputBuffer = "";
	private inputTimer: number | null = null;
	private composing = false;
	private reconnectTimer: number | null = null;
	private token: string | null;
	private readonly lastOffsets = new Map<string, number>();
	private disposed = false;
	private activeResumeId: number | null = null;
	private pendingResumeMode: ResumeMode | null = null;
	private pendingCreateSelect = false;
	private pendingExitCodeBySession = new Map<string, number | null>();

	constructor(
		container: HTMLElement,
		private readonly options: TerminalViewOptions,
	) {
		this.token = options.initialToken ?? sessionStorage.getItem("piRemoteJwt");

		this.root = document.createElement("div");
		this.root.className = "terminal-shell";
		this.terminalHost = document.createElement("div");
		this.terminalHost.className = "terminal-host";
		this.blankState = document.createElement("div");
		this.blankState.className = "terminal-blank hidden";
		this.blankState.textContent = "Select a session from the list.";
		this.root.append(this.terminalHost, this.blankState);
		container.replaceChildren(this.root);

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
		this.terminal.open(this.terminalHost);

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

		const textareaEl = this.root.querySelector(".xterm-helper-textarea") as HTMLTextAreaElement | null;
		if (textareaEl) {
			textareaEl.addEventListener("compositionstart", () => {
				this.composing = true;
			});
			textareaEl.addEventListener("compositionend", () => {
				this.composing = false;
			});
		}

		this.terminal.onData((data: string) => {
			if (this.composing) return;
			this.bufferInput(data);
		});

		this.terminal.onTitleChange((title: string) => {
			if (!this.activeSessionId) return;
			this.send({ type: "session_title", sessionId: this.activeSessionId, title });
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
		if (!this.activeSessionId || !this.blankState.classList.contains("hidden")) return;
		this.send({ type: "input", data, sessionId: this.activeSessionId });
	}

	requestSessionList(): void {
		this.send({ type: "session_list" });
	}

	createSession(fromSessionId?: string): void {
		this.pendingCreateSelect = true;
		this.send({
			type: "session_create",
			cols: this.terminal.cols,
			rows: this.terminal.rows,
			fromSessionId,
		});
	}

	killSession(sessionId: string): void {
		this.send({ type: "session_kill", sessionId });
	}

	switchSession(sessionId: string): void {
		this.flushWrite();
		this.hideBlankState();
		this.terminal.reset();
		this.activeSessionId = sessionId;
		this.lastOffsets.set(sessionId, 0);
		this.activeResumeId = null;
		this.pendingResumeMode = "switch";
		this.sendResize();
		this.send({ type: "resume", sessionId, lastOffset: 0 });
	}

	show(): void {
		this.root.style.display = "";
		requestAnimationFrame(() => {
			// Refresh renderer after display:none → visible transition
			this.terminal.refresh(0, this.terminal.rows - 1);
			if (isMobile) {
				this.mobileFixedResize();
			} else {
				try {
					this.fitAddon.fit();
					this.sendResize();
				} catch {
					// ignore resize race
				}
			}
		});
	}

	hide(): void {
		this.root.style.display = "none";
	}

	mobileFixedResizePublic(): void {
		this.mobileFixedResize();
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
		this.pendingCreateSelect = false;
		const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
		const token = new URLSearchParams(window.location.search).get("token");
		const tokenQuery = token ? `?token=${encodeURIComponent(token)}` : "";
		const wsUrl = `${protocol}//${window.location.host}/ws/terminal${tokenQuery}`;

		this.setConnectionState(this.options.requiresAuth && this.token ? "reconnecting" : "disconnected");
		this.ws = new WebSocket(wsUrl);

		this.ws.onopen = () => {
			if (!this.options.requiresAuth) {
				this.afterAuthenticatedOpen();
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
			if (this.disposed || !this.root.isConnected) return;

			if (event.code === 4001) {
				this.setToken(null);
				this.setConnectionState("disconnected");
				this.options.onAuthRequired?.("PIN changed. Re-enter the new PIN.");
				return;
			}

			if (event.code === 4003) {
				this.scheduleReconnect();
				return;
			}

			this.scheduleReconnect();
		};

		this.ws.onerror = () => {
			this.setConnectionState("reconnecting");
		};
	}

	private afterAuthenticatedOpen(): void {
		this.requestSessionList();
		if (this.activeSessionId) {
			this.activeResumeId = null;
			this.pendingResumeMode = "reconnect";
			this.sendResize();
			this.send({
				type: "resume",
				sessionId: this.activeSessionId,
				lastOffset: this.lastOffsets.get(this.activeSessionId) ?? 0,
			});
		}
	}

	private handleServerMessage(message: ServerMessage): void {
		switch (message.type) {
			case "auth_required":
				this.handleAuthRequired();
				return;
			case "auth_ok":
				this.handleAuthOk(message.token);
				return;
			case "auth_fail":
				this.handleAuthFail(message.reason);
				return;
			case "session_list":
				this.options.onSessionList?.(message.sessions);
				return;
			case "session_created":
				this.handleSessionCreated(message.session);
				return;
			case "session_updated":
				this.options.onSessionUpdated?.(message.session);
				return;
			case "session_killed":
				this.handleSessionEndedMessage(message.sessionId, this.options.onSessionKilled);
				return;
			case "session_removed":
				this.handleSessionEndedMessage(message.sessionId, this.options.onSessionRemoved);
				return;
			case "session_error":
				this.handleSessionErrorMessage(message.reason, message.sessionId);
				return;
			case "state":
				this.handleStateMessage(message.sessionId, message.running, message.exitCode);
				return;
			case "reset":
				this.handleResetMessage(message.sessionId, message.resumeId);
				return;
			case "data":
				this.handleDataMessage(message.sessionId, message.data, message.offset, message.resumeId);
				return;
			case "replay_complete":
				this.handleReplayCompleteMessage(message.sessionId, message.resumeId);
				return;
			case "exit":
				this.handleExitMessage(message.sessionId, message.exitCode);
				return;
			case "ping":
				this.send({ type: "pong" });
				return;
		}
	}

	private handleAuthRequired(): void {
		if (this.token) {
			this.send({ type: "auth_token", token: this.token });
			return;
		}
		this.setConnectionState("disconnected");
		this.options.onAuthRequired?.();
	}

	private handleAuthOk(token: string): void {
		this.setToken(token);
		this.setConnectionState("connected");
		this.afterAuthenticatedOpen();
	}

	private handleAuthFail(reason: string): void {
		this.setToken(null);
		this.setConnectionState("disconnected");
		this.options.onAuthRequired?.(reason);
	}

	private handleSessionCreated(session: SessionInfo): void {
		const shouldAutoSelect = this.pendingCreateSelect;
		if (shouldAutoSelect) {
			this.pendingCreateSelect = false;
		}
		this.options.onSessionCreated?.(session, shouldAutoSelect);
	}

	private handleSessionEndedMessage(sessionId: string, callback?: (sessionId: string) => void): void {
		this.handleActiveSessionEnded(sessionId);
		callback?.(sessionId);
	}

	private handleSessionErrorMessage(reason: string, sessionId?: string): void {
		if (!sessionId) {
			this.pendingCreateSelect = false;
		}
		if (reason === "session_not_found" && sessionId === this.activeSessionId) {
			this.handleActiveSessionEnded(sessionId);
		}
		this.options.onSessionError?.(reason, sessionId);
	}

	private handleStateMessage(sessionId: string, running: boolean, exitCode: number | null): void {
		if (sessionId !== this.activeSessionId) {
			return;
		}
		if (!running) {
			this.pendingExitCodeBySession.set(sessionId, exitCode);
			return;
		}
		this.pendingExitCodeBySession.delete(sessionId);
	}

	private isActiveReplayMessage(sessionId: string, resumeId: number): boolean {
		if (sessionId !== this.activeSessionId) {
			return false;
		}
		if (this.activeResumeId === null) {
			this.activeResumeId = resumeId;
		}
		return resumeId === this.activeResumeId;
	}

	private handleResetMessage(sessionId: string, resumeId: number): void {
		if (this.pendingResumeMode !== "switch" && this.pendingResumeMode !== "reconnect") {
			return;
		}
		if (!this.isActiveReplayMessage(sessionId, resumeId)) {
			return;
		}
		this.flushWrite();
		this.terminal.reset();
		this.hideBlankState();
		this.lastOffsets.set(sessionId, 0);
	}

	private handleDataMessage(sessionId: string, data: string, offset?: number, resumeId?: number): void {
		if (!this.shouldRenderData(sessionId, resumeId)) {
			return;
		}
		this.hideBlankState();
		this.throttledWrite(data);
		if (typeof offset === "number") {
			this.lastOffsets.set(sessionId, offset);
		} else {
			const prev = this.lastOffsets.get(sessionId) ?? 0;
			this.lastOffsets.set(sessionId, prev + data.length);
		}
		this.setConnectionState("connected");
	}

	private handleReplayCompleteMessage(sessionId: string, resumeId: number): void {
		if (!this.isActiveReplayMessage(sessionId, resumeId)) {
			return;
		}
		this.pendingResumeMode = null;
		this.hideBlankState();
		const pendingExitCode = this.pendingExitCodeBySession.get(sessionId);
		if (this.pendingExitCodeBySession.has(sessionId)) {
			this.flushWrite();
			this.terminal.write(`\r\n\x1b[33mProcess exited (code ${pendingExitCode ?? "?"})\x1b[0m\r\n`);
			this.pendingExitCodeBySession.delete(sessionId);
		}
	}

	private handleExitMessage(sessionId: string, exitCode: number | null): void {
		if (sessionId !== this.activeSessionId) {
			return;
		}
		if (this.pendingResumeMode !== null) {
			this.pendingExitCodeBySession.set(sessionId, exitCode);
			return;
		}
		this.pendingExitCodeBySession.delete(sessionId);
		this.flushWrite();
		this.terminal.write(`\r\n\x1b[33mProcess exited (code ${exitCode ?? "?"})\x1b[0m\r\n`);
	}

	private shouldRenderData(sessionId: string, resumeId?: number): boolean {
		if (sessionId !== this.activeSessionId) {
			return false;
		}

		if (typeof resumeId !== "number") {
			return this.pendingResumeMode === null;
		}

		if (this.pendingResumeMode === "switch") {
			if (this.activeResumeId === null) {
				return false;
			}
			return resumeId === this.activeResumeId;
		}

		if (this.activeResumeId === null) {
			this.activeResumeId = resumeId;
		}

		return resumeId === this.activeResumeId;
	}

	private handleActiveSessionEnded(sessionId: string): void {
		if (this.activeSessionId !== sessionId) return;
		this.activeSessionId = null;
		this.activeResumeId = null;
		this.pendingResumeMode = null;
		this.pendingExitCodeBySession.delete(sessionId);
		this.lastOffsets.delete(sessionId);
		this.showBlankState("Session ended. Select a session from the list.");
		this.options.onActiveSessionEnded?.(sessionId);
	}

	private send(message: BrowserMessage): void {
		if (this.ws?.readyState === WebSocket.OPEN) {
			this.ws.send(JSON.stringify(message));
		}
	}

	private sendResize(): void {
		if (!this.activeSessionId) return;
		const payload: BrowserMessage = {
			type: "resize",
			sessionId: this.activeSessionId,
			cols: this.terminal.cols,
			rows: this.terminal.rows,
			...(isMobile ? { mobile: true } : {}),
		};
		this.send(payload);
	}

	private scheduleReconnect(): void {
		if (this.reconnectTimer !== null) return;
		this.setConnectionState("reconnecting");
		this.reconnectTimer = window.setTimeout(() => {
			this.reconnectTimer = null;
			if (!this.disposed && this.root.isConnected) {
				this.connect();
			}
		}, 2000);
	}

	private setConnectionState(state: ConnectionState): void {
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

	private showBlankState(message: string): void {
		this.flushWrite();
		this.blankState.textContent = message;
		this.blankState.classList.remove("hidden");
	}

	private hideBlankState(): void {
		this.blankState.classList.add("hidden");
	}

	private bufferInput(data: string): void {
		this.inputBuffer += data;
		if (this.inputTimer === null) {
			this.inputTimer = requestAnimationFrame(() => {
				this.inputTimer = null;
				if (this.inputBuffer) {
					this.sendInput(this.inputBuffer);
					this.inputBuffer = "";
				}
			});
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
		this.resizeObserver.observe(this.root);
	}

	private mobileFixedResize(): void {
		const cellDims = (
			this.terminal as Terminal & {
				_core?: { _renderService?: { dimensions?: { css?: { cell?: { width?: number; height?: number } } } } };
			}
		)._core?._renderService?.dimensions?.css?.cell;
		if (!cellDims?.width || !cellDims?.height) {
			setTimeout(() => this.mobileFixedResize(), 50);
			return;
		}

		const mobileCols = 80;
		const availableWidth = window.innerWidth - 16;
		const availableHeight = window.innerHeight - 40 - (isMobile ? 52 : 0) - 8;
		const currentFontSize = this.terminal.options.fontSize ?? 11;
		const targetFontSize = Math.floor(((currentFontSize * availableWidth) / (mobileCols * cellDims.width)) * 10) / 10;

		this.terminal.options.fontSize = targetFontSize;

		requestAnimationFrame(() => {
			const newDims = (
				this.terminal as Terminal & {
					_core?: { _renderService?: { dimensions?: { css?: { cell?: { height?: number } } } } };
				}
			)._core?._renderService?.dimensions?.css?.cell;
			const lineHeight = newDims?.height ?? cellDims.height ?? 15;
			const rows = Math.max(5, Math.min(Math.floor(availableHeight / lineHeight), 100));
			this.terminal.resize(mobileCols, rows);
			this.sendResize();
		});
	}

	private setupMobileTouchScroll(): void {
		const screen = this.root.querySelector(".xterm-screen") as HTMLElement | null;
		if (!screen) return;

		const term = this.terminal;
		const getLineHeight = (): number => {
			const cellDims = (
				term as Terminal & {
					_core?: { _renderService?: { dimensions?: { css?: { cell?: { height?: number } } } } };
				}
			)._core?._renderService?.dimensions?.css?.cell;
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
