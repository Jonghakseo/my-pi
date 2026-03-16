export interface BufferSnapshot {
    data: string;
    offset: number;
}
export interface BufferDelta {
    data: string;
    newOffset: number;
}
export declare class OutputBuffer {
    private readonly maxSize;
    private chunks;
    private totalLength;
    private bufferStartOffset;
    constructor(maxSize?: number);
    append(data: string): void;
    getFrom(offset: number): BufferDelta | null;
    getAll(): BufferSnapshot;
    getCurrentOffset(): number;
    private trimIfNeeded;
    private joinFromRelativeOffset;
}
//# sourceMappingURL=session.d.ts.map