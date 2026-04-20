import { open as fsOpen, stat as fsStat } from "node:fs/promises";
import { fileTypeFromBuffer } from "file-type";

const IMAGE_MIME_TYPES = new Set<string>(["image/jpeg", "image/png", "image/gif", "image/webp"]);
const FILE_TYPE_SNIFF_BYTES = 8192;

export type FileKind =
	| { kind: "directory" }
	| { kind: "image"; mimeType: string }
	| { kind: "text" }
	| { kind: "binary"; description: string };

export type LoadedFile =
	| { kind: "directory" }
	| { kind: "image"; mimeType: string }
	| { kind: "text"; text: string }
	| { kind: "binary"; description: string };

function hasNullByte(buffer: Uint8Array): boolean {
	return buffer.includes(0);
}

function decodeUtf8Chunk(decoder: TextDecoder, buffer: Uint8Array): string | null {
	try {
		return decoder.decode(buffer, { stream: true });
	} catch (error: unknown) {
		if (error instanceof TypeError) {
			return null;
		}
		throw error;
	}
}

function finishUtf8(decoder: TextDecoder): string | null {
	try {
		return decoder.decode();
	} catch (error: unknown) {
		if (error instanceof TypeError) {
			return null;
		}
		throw error;
	}
}

export async function loadFileKindAndText(filePath: string): Promise<LoadedFile> {
	const pathStat = await fsStat(filePath);
	if (pathStat.isDirectory()) {
		return { kind: "directory" };
	}
	if (!pathStat.isFile()) {
		return {
			kind: "binary",
			description: "unsupported file type",
		};
	}

	const fileHandle = await fsOpen(filePath, "r");
	try {
		const buffer = Buffer.alloc(FILE_TYPE_SNIFF_BYTES);
		const { bytesRead } = await fileHandle.read(buffer, 0, FILE_TYPE_SNIFF_BYTES, 0);
		if (bytesRead === 0) {
			return { kind: "text", text: "" };
		}

		const sample = buffer.subarray(0, bytesRead);
		const fileType = await fileTypeFromBuffer(sample);
		if (fileType) {
			if (IMAGE_MIME_TYPES.has(fileType.mime)) {
				return { kind: "image", mimeType: fileType.mime };
			}
			return {
				kind: "binary",
				description: fileType.mime,
			};
		}

		if (hasNullByte(sample)) {
			return {
				kind: "binary",
				description: "null bytes detected",
			};
		}

		const decoder = new TextDecoder("utf-8", { fatal: true });
		const parts: string[] = [];
		const sampleText = decodeUtf8Chunk(decoder, sample);
		if (sampleText === null) {
			return {
				kind: "binary",
				description: "invalid UTF-8",
			};
		}
		parts.push(sampleText);

		let position = bytesRead;
		while (true) {
			const { bytesRead: chunkBytesRead } = await fileHandle.read(buffer, 0, FILE_TYPE_SNIFF_BYTES, position);
			if (chunkBytesRead === 0) {
				break;
			}

			const chunk = buffer.subarray(0, chunkBytesRead);
			if (hasNullByte(chunk)) {
				return {
					kind: "binary",
					description: "null bytes detected",
				};
			}
			const chunkText = decodeUtf8Chunk(decoder, chunk);
			if (chunkText === null) {
				return {
					kind: "binary",
					description: "invalid UTF-8",
				};
			}
			parts.push(chunkText);
			position += chunkBytesRead;
		}

		const tail = finishUtf8(decoder);
		if (tail === null) {
			return {
				kind: "binary",
				description: "invalid UTF-8",
			};
		}
		parts.push(tail);

		return { kind: "text", text: parts.join("") };
	} finally {
		await fileHandle.close();
	}
}

export async function classifyFileKind(filePath: string): Promise<FileKind> {
	const loaded = await loadFileKindAndText(filePath);
	switch (loaded.kind) {
		case "directory":
			return loaded;
		case "image":
			return loaded;
		case "binary":
			return loaded;
		case "text":
			return { kind: "text" };
	}
}
