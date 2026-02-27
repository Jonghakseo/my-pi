/**
 * Shared time formatting helpers.
 *
 * Standard duration format: 시/분/초 (e.g. "1시간 2분 3초", "4분 5초", "12초").
 */

function toSafeMs(value: number): number {
	if (!Number.isFinite(value)) return 0;
	return Math.max(0, Math.floor(value));
}

export function formatDuration(ms: number): string {
	const totalSeconds = Math.floor(toSafeMs(ms) / 1000);
	const hours = Math.floor(totalSeconds / 3600);
	const minutes = Math.floor((totalSeconds % 3600) / 60);
	const seconds = totalSeconds % 60;

	if (hours > 0) return `${hours}시간 ${minutes}분 ${seconds}초`;
	if (minutes > 0) return `${minutes}분 ${seconds}초`;
	return `${seconds}초`;
}

export function formatDurationBetween(start: Date | number, end: Date | number): string {
	const startMs = start instanceof Date ? start.getTime() : start;
	const endMs = end instanceof Date ? end.getTime() : end;
	return formatDuration(toSafeMs(endMs - startMs));
}

export function formatElapsedSince(startedAt: number, now = Date.now()): string {
	return formatDuration(toSafeMs(now - startedAt));
}
