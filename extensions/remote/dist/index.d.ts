export interface RemoteOptions {
    piPath?: string;
    args?: string[];
    cwd?: string;
    env?: Record<string, string>;
    funnel?: boolean;
    forceLan?: boolean;
}
export declare function startRemote(options?: RemoteOptions): Promise<() => Promise<void>>;
//# sourceMappingURL=index.d.ts.map