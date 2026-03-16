import { type Server as HttpServer } from "node:http";
import { type Server as HttpsServer } from "node:https";
export type ServerMode = "lan" | "tailscale" | "funnel";
export interface ServerOptions {
    mode: ServerMode;
    reason?: string;
    port?: number;
    certPath?: string;
    keyPath?: string;
    hostname?: string;
    bindHost?: string;
}
export interface ServerResult {
    server: HttpServer | HttpsServer;
    url: string;
    port: number;
    pin?: string;
    cleanup: () => Promise<void>;
}
export declare function setPublicUrl(url: string | null): void;
export declare function startServer(options: ServerOptions): Promise<ServerResult>;
//# sourceMappingURL=server.d.ts.map