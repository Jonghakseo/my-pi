export class OutputBuffer {
    maxSize;
    chunks = [];
    totalLength = 0;
    bufferStartOffset = 0;
    constructor(maxSize = 1_000_000) {
        this.maxSize = maxSize;
    }
    append(data) {
        if (!data)
            return;
        this.chunks.push(data);
        this.totalLength += data.length;
        this.trimIfNeeded();
    }
    getFrom(offset) {
        if (offset < this.bufferStartOffset || offset > this.getCurrentOffset()) {
            return null;
        }
        if (offset === this.getCurrentOffset()) {
            return { data: "", newOffset: offset };
        }
        const relativeOffset = offset - this.bufferStartOffset;
        const data = this.joinFromRelativeOffset(relativeOffset);
        return {
            data,
            newOffset: this.getCurrentOffset(),
        };
    }
    getAll() {
        return {
            data: this.chunks.join(""),
            offset: this.getCurrentOffset(),
        };
    }
    getCurrentOffset() {
        return this.bufferStartOffset + this.totalLength;
    }
    trimIfNeeded() {
        while (this.totalLength > this.maxSize && this.chunks.length > 0) {
            const overflow = this.totalLength - this.maxSize;
            const firstChunk = this.chunks[0] ?? "";
            if (firstChunk.length <= overflow) {
                this.chunks.shift();
                this.totalLength -= firstChunk.length;
                this.bufferStartOffset += firstChunk.length;
                continue;
            }
            this.chunks[0] = firstChunk.slice(overflow);
            this.totalLength -= overflow;
            this.bufferStartOffset += overflow;
        }
    }
    joinFromRelativeOffset(relativeOffset) {
        if (relativeOffset <= 0) {
            return this.chunks.join("");
        }
        let remaining = relativeOffset;
        const result = [];
        for (const chunk of this.chunks) {
            if (remaining >= chunk.length) {
                remaining -= chunk.length;
                continue;
            }
            if (remaining > 0) {
                result.push(chunk.slice(remaining));
                remaining = 0;
            }
            else {
                result.push(chunk);
            }
        }
        return result.join("");
    }
}
//# sourceMappingURL=session.js.map