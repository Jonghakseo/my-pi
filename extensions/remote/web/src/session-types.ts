export interface SessionInfo {
  id: string;
  name: string;
  state: "running" | "exited";
  exitCode: number | null;
  createdAt: number;
  attachLocal: boolean;
  lastActivity: number;
}

export type ConnectionState = "connected" | "reconnecting" | "disconnected";

export type BrowserMessage =
  | { type: "input"; data: string; sessionId: string }
  | { type: "resize"; cols: number; rows: number; sessionId: string; mobile?: boolean }
  | { type: "auth_token"; token: string }
  | { type: "resume"; lastOffset: number; sessionId: string }
  | { type: "session_create"; name?: string; cols?: number; rows?: number; fromSessionId?: string }
  | { type: "session_kill"; sessionId: string }
  | { type: "session_title"; sessionId: string; title: string }
  | { type: "session_list" }
  | { type: "pong" };

export type ServerMessage =
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
