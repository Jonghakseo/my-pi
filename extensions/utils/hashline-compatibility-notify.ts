import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";

type SessionState = {
	compatibilityCount: number;
};

function getSessionKey(ctx: ExtensionContext): string {
	const sessionFile = ctx.sessionManager?.getSessionFile?.();
	if (sessionFile) {
		return sessionFile;
	}

	const sessionId = (ctx as { sessionId?: string }).sessionId;
	if (sessionId) {
		return sessionId;
	}

	return "__default_session__";
}

export function registerCompatibilityNotifications(pi: ExtensionAPI): void {
	const sessionStates = new Map<string, SessionState>();

	pi.on("turn_start", async (_event, ctx) => {
		const sessionKey = getSessionKey(ctx);
		sessionStates.set(sessionKey, { compatibilityCount: 0 });
	});

	pi.on("tool_result", async (event, ctx) => {
		if (event.toolName !== "edit" || event.isError) {
			return;
		}

		const details = event.details as
			| {
					compatibility?: {
						used?: boolean;
					};
			  }
			| undefined;

		if (!details?.compatibility?.used) {
			return;
		}

		const sessionKey = getSessionKey(ctx);
		const state = sessionStates.get(sessionKey);
		if (state) {
			state.compatibilityCount += 1;
		} else {
			sessionStates.set(sessionKey, { compatibilityCount: 1 });
		}
	});

	pi.on("turn_end", async (_event, ctx) => {
		const sessionKey = getSessionKey(ctx);
		const state = sessionStates.get(sessionKey);
		const compatibilityCount = state?.compatibilityCount ?? 0;

		if (!ctx.hasUI || compatibilityCount === 0) {
			sessionStates.delete(sessionKey);
			return;
		}

		ctx.ui.notify(`Edit compatibility mode used for ${compatibilityCount} edit(s)`, "warning");
		sessionStates.delete(sessionKey);
	});
}
