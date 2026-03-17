export interface BufferSnapshot {
  data: string;
  offset: number;
}

export interface BufferDelta {
  data: string;
  newOffset: number;
}

export class OutputBuffer {
  private chunks: string[] = [];
  private totalLength = 0;
  private bufferStartOffset = 0;

  constructor(private readonly maxSize = 1_000_000) {}

  append(data: string): void {
    if (!data) return;

    this.chunks.push(data);
    this.totalLength += data.length;
    this.trimIfNeeded();
  }

  getFrom(offset: number): BufferDelta | null {
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

  getAll(): BufferSnapshot {
    return {
      data: this.chunks.join(""),
      offset: this.getCurrentOffset(),
    };
  }

  getLastN(maxBytes: number): BufferSnapshot {
    if (maxBytes <= 0) {
      return { data: "", offset: this.getCurrentOffset() };
    }

    const full = this.chunks.join("");
    const data = full.slice(-maxBytes);
    return {
      data,
      offset: this.getCurrentOffset(),
    };
  }

  getCurrentOffset(): number {
    return this.bufferStartOffset + this.totalLength;
  }

  private trimIfNeeded(): void {
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

  private joinFromRelativeOffset(relativeOffset: number): string {
    if (relativeOffset <= 0) {
      return this.chunks.join("");
    }

    let remaining = relativeOffset;
    const result: string[] = [];

    for (const chunk of this.chunks) {
      if (remaining >= chunk.length) {
        remaining -= chunk.length;
        continue;
      }

      if (remaining > 0) {
        result.push(chunk.slice(remaining));
        remaining = 0;
      } else {
        result.push(chunk);
      }
    }

    return result.join("");
  }
}
