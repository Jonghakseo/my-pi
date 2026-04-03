/**
 * Pure shell/command utilities extracted from various extensions.
 *
 * All functions are deterministic and side-effect free.
 */

// ─── rm -rf detection (from damage-control-rmrf.ts) ────────────────────────

/** Detect if a shell command contains `rm -rf` (recursive + force). */
export function hasRmRf(command: string): boolean {
	const rmSegments = command.match(/\brm\b[^\n;|&]*/g) ?? [];

	for (const segment of rmSegments) {
		const hasLongRecursive = /--recursive\b/.test(segment);
		const hasLongForce = /--force\b/.test(segment);

		let hasRecursive = hasLongRecursive;
		let hasForce = hasLongForce;

		const shortFlags = [...segment.matchAll(/(^|\s)-([A-Za-z]+)/g)].map((m) => m[2]);
		for (const flags of shortFlags) {
			if (/[rR]/.test(flags)) hasRecursive = true;
			if (/f/.test(flags)) hasForce = true;
		}

		if (hasRecursive && hasForce) return true;
	}

	return false;
}

// ─── Recorder args ─────────────────────────────────────────────────────────

/** Build command-line arguments for the audio recorder (sox/rec). */
export function buildRecorderArgs(bin: string, wavPath: string): string[] {
	const lower = bin.toLowerCase();
	if (lower.includes("rec")) {
		return ["-q", "-r", "16000", "-c", "1", "-b", "16", wavPath];
	}

	return ["-q", "-d", "-r", "16000", "-c", "1", "-b", "16", wavPath];
}
