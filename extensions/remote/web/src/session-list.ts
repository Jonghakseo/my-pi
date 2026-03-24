import type { SessionInfo } from "./session-types.js";

interface SessionListOptions {
	onSelect: (sessionId: string) => void;
	onCreate: () => void;
	onKill: (sessionId: string) => void;
}

const LONG_PRESS_MS = 450;

export class SessionListView {
	private readonly sessions = new Map<string, SessionInfo>();
	private activeSessionId: string | null = null;
	private readonly root: HTMLElement;
	private readonly list: HTMLElement;
	private readonly newButton: HTMLButtonElement;

	constructor(
		private readonly container: HTMLElement,
		private readonly options: SessionListOptions,
	) {
		this.root = document.createElement("div");
		this.root.className = "session-list";

		const header = document.createElement("div");
		header.className = "session-list-header";
		header.textContent = "Sessions";

		this.list = document.createElement("div");
		this.list.className = "session-list-items";

		this.newButton = document.createElement("button");
		this.newButton.className = "session-list-create";
		this.newButton.textContent = "+ New";
		this.newButton.addEventListener("click", () => {
			this.options.onCreate();
		});

		this.root.append(header, this.list, this.newButton);
		this.container.replaceChildren(this.root);
	}

	updateSessions(sessions: SessionInfo[]): void {
		this.sessions.clear();
		for (const session of sessions) {
			this.sessions.set(session.id, session);
		}
		this.render();
	}

	upsertSession(session: SessionInfo): void {
		this.sessions.set(session.id, session);
		this.render();
	}

	removeSession(sessionId: string): void {
		this.sessions.delete(sessionId);
		if (this.activeSessionId === sessionId) {
			this.activeSessionId = null;
		}
		this.render();
	}

	setActiveSession(sessionId: string | null): void {
		this.activeSessionId = sessionId;
		this.render();
	}

	getSession(sessionId: string): SessionInfo | undefined {
		return this.sessions.get(sessionId);
	}

	getSessions(): SessionInfo[] {
		return [...this.sessions.values()].sort((left, right) => left.createdAt - right.createdAt);
	}

	dispose(): void {
		this.container.replaceChildren();
	}

	private render(): void {
		const ordered = this.getSessions();
		this.list.replaceChildren();

		for (const session of ordered) {
			const item = document.createElement("button");
			item.type = "button";
			item.className = "session-item";
			if (session.id === this.activeSessionId) {
				item.classList.add("active");
			}

			const status = document.createElement("span");
			status.className = "session-item-status";
			status.textContent = getStatusIcon(session);

			const content = document.createElement("span");
			content.className = "session-item-content";

			const name = document.createElement("span");
			name.className = "session-item-name";
			name.textContent = session.name;

			const meta = document.createElement("span");
			meta.className = "session-item-meta";
			meta.textContent = formatLastActivity(session);

			content.append(name, meta);
			item.append(status, content);

			item.addEventListener("click", () => {
				this.options.onSelect(session.id);
			});

			item.addEventListener("contextmenu", (event) => {
				event.preventDefault();
				this.options.onKill(session.id);
			});

			let longPressTimer: number | null = null;
			item.addEventListener(
				"touchstart",
				() => {
					longPressTimer = window.setTimeout(() => {
						longPressTimer = null;
						this.options.onKill(session.id);
					}, LONG_PRESS_MS);
				},
				{ passive: true },
			);

			const clearLongPress = (): void => {
				if (longPressTimer !== null) {
					clearTimeout(longPressTimer);
					longPressTimer = null;
				}
			};

			item.addEventListener("touchend", clearLongPress, { passive: true });
			item.addEventListener("touchcancel", clearLongPress, { passive: true });
			item.addEventListener("touchmove", clearLongPress, { passive: true });

			this.list.appendChild(item);
		}
	}
}

function getStatusIcon(session: SessionInfo): string {
	if (session.state === "exited") {
		return "✕";
	}

	const idleForMs = Date.now() - session.lastActivity;
	return idleForMs > 5_000 ? "○" : "●";
}

function formatLastActivity(session: SessionInfo): string {
	if (session.state === "exited") {
		return session.exitCode === null ? "ended" : `exit ${session.exitCode}`;
	}

	const diffMs = Math.max(0, Date.now() - session.lastActivity);
	if (diffMs < 5_000) return "active now";
	if (diffMs < 60_000) return `${Math.floor(diffMs / 1000)}s ago`;
	if (diffMs < 3_600_000) return `${Math.floor(diffMs / 60_000)}m ago`;
	return new Date(session.lastActivity).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}
