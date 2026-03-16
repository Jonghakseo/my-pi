import type { IncomingMessage, ServerResponse } from "node:http";
export type ServerMode = "lan" | "tailscale" | "funnel";
interface AuthInitOptions {
    mode: ServerMode;
    onAuthRevoke?: (reason: string) => void;
    onPinChange?: (pin: string, reason: string) => void;
}
interface AuthFailure {
    ok: false;
    reason: string;
    statusCode?: number;
}
interface AuthSuccess {
    ok: true;
    token?: string;
}
export type AuthResult = AuthFailure | AuthSuccess;
export declare function initializeAuth(options: AuthInitOptions): void;
export declare function registerAuthRevokeHandler(cb: (reason: string) => void): void;
export declare function getLanToken(): string;
export declare function getCurrentPin(): string | undefined;
export declare function getPinLength(): number;
export declare function generatePin(mode: "tailscale" | "funnel"): string;
export declare function createJwt(): Promise<string>;
export declare function verifyJwt(token: string): Promise<boolean>;
export declare function verifyPin(pin: string, remoteIp: string): AuthResult;
export declare function wsAuthCheck(req: IncomingMessage): Promise<AuthResult>;
export declare function httpAuthMiddleware(req: IncomingMessage, res: ServerResponse): Promise<boolean>;
export declare function handleAuthRequest(req: IncomingMessage, res: ServerResponse): Promise<void>;
export declare function resetPinAndSessions(reason: string): {
    newPin: string;
    revoked: true;
} | null;
export {};
//# sourceMappingURL=auth.d.ts.map