export type ResolvedMode = "lan" | "tailscale" | "funnel";
export interface TailscaleInfo {
    installed: boolean;
    running: boolean;
    ip: string | null;
    certDomains: string[];
    funnelAvailable: boolean;
    reason?: string;
}
export interface TailscaleCert {
    certPath: string;
    keyPath: string;
}
export interface ResolveModeOptions {
    forceLan?: boolean;
    funnel?: boolean;
}
export interface ResolveModeResult {
    mode: ResolvedMode;
    reason?: string;
    hostname?: string;
    cert?: TailscaleCert;
    tailscale: TailscaleInfo;
}
export declare function getTailscaleInfo(): Promise<TailscaleInfo>;
export declare function ensureCert(hostname: string): Promise<TailscaleCert>;
export declare function startFunnel(port: number): Promise<string>;
export declare function stopFunnel(port: number): Promise<void>;
export declare function resolveMode(options: ResolveModeOptions): Promise<ResolveModeResult>;
//# sourceMappingURL=tailscale.d.ts.map