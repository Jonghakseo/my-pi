import type { Server } from "node:http";
export type ServerMode = "lan" | "tailscale" | "funnel";
export declare function setupTerminalWebSocket(httpServer: Server, mode: ServerMode): () => Promise<void>;
//# sourceMappingURL=ws.d.ts.map