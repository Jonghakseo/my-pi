import { OutputBuffer } from "./session.js";
export interface PtyState {
    running: boolean;
    exitCode: number | null;
}
export interface SpawnOptions {
    command: string;
    args?: string[];
    cwd?: string;
    env?: Record<string, string>;
    cols?: number;
    rows?: number;
    attachLocal?: boolean;
}
export type PtyDataListener = (data: string, offset: number) => void;
export type PtyExitListener = (exitCode: number) => void;
export declare function spawnInPty(options: SpawnOptions): Promise<void>;
export declare function writeToPty(data: string): void;
export declare function resizePty(cols: number, rows: number): void;
export declare function killPty(): void;
export declare function onPtyData(cb: PtyDataListener): () => void;
export declare function onPtyExit(cb: PtyExitListener): () => void;
export declare function getPtyState(): PtyState;
export declare function getPtyOutputBuffer(): OutputBuffer;
//# sourceMappingURL=pty.d.ts.map