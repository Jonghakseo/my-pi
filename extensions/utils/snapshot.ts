import { stat } from "node:fs/promises";

export type SnapshotInfo = {
	snapshotId: string;
	mtimeMs: number;
	size: number;
};

const snapshotCache = new Map<string, SnapshotInfo>();

function formatSnapshotId(absolutePath: string, info: { mtimeMs: number; size: number }): string {
	return `v1|${absolutePath}|${info.mtimeMs}|${info.size}`;
}

export async function getFileSnapshot(absolutePath: string): Promise<SnapshotInfo> {
	const stats = await stat(absolutePath);
	const snapshot: SnapshotInfo = {
		snapshotId: formatSnapshotId(absolutePath, stats),
		mtimeMs: stats.mtimeMs,
		size: stats.size,
	};
	snapshotCache.set(absolutePath, snapshot);
	return snapshot;
}

export function getCachedSnapshot(absolutePath: string): SnapshotInfo | undefined {
	return snapshotCache.get(absolutePath);
}
