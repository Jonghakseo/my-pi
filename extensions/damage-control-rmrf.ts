import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { isToolCallEventType } from "@mariozechner/pi-coding-agent";

function hasRmRf(command: string): boolean {
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

export default function damageControlRmRf(pi: ExtensionAPI) {
	pi.on("tool_call", async (event, ctx) => {
		if (!isToolCallEventType("bash", event)) return;
		if (!hasRmRf(event.input.command)) return;

		if (!ctx.hasUI) {
			return {
				block: true,
				reason: "Blocked: rm -rf requires explicit human approval, but no interactive UI is available.",
			};
		}

		const ok = await ctx.ui.confirm(
			"Human-in-the-loop: rm -rf 감지",
			`다음 명령을 실행할까요?\n\n${event.input.command}`,
			{ timeout: 30000 },
		);

		if (!ok) {
			return {
				block: true,
				reason:
					"Blocked by Damage-Control: rm -rf command was denied by user. Do not retry alternative destructive variants.",
			};
		}

		return { block: false };
	});
}
