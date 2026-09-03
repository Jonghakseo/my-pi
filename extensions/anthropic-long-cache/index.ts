import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AutocompleteItem } from "@earendil-works/pi-tui";
import { overrideAnthropicCacheTtl } from "./payload.js";
import { isAnthropicLongCacheEnabled, setAnthropicLongCacheEnabled } from "./state.js";

const STATUS_KEY = "anthropic-long-cache";
const COMMAND = "anthropic-long-cahce";
const COMMAND_ALIAS = "anthropic-long-cache";
const COMMAND_ARGUMENTS = ["on", "off"];

export function getArgumentCompletions(prefix: string): AutocompleteItem[] | null {
	const normalized = prefix.trim().toLowerCase();
	const matches = COMMAND_ARGUMENTS.filter((value) => value.startsWith(normalized));
	return matches.length > 0 ? matches.map((value) => ({ value, label: value })) : null;
}

function sessionId(ctx: ExtensionContext): string {
	try {
		return ctx.sessionManager.getSessionId() || "";
	} catch {
		return "";
	}
}

function refreshStatus(ctx: ExtensionContext): void {
	if (!ctx.hasUI) return;
	const enabled = isAnthropicLongCacheEnabled(sessionId(ctx));
	ctx.ui.setStatus(STATUS_KEY, enabled ? ctx.ui.theme.fg("accent", "Anthropic cache: 1h") : undefined);
}

async function handleCommand(args: string, ctx: ExtensionContext): Promise<void> {
	const enabled = args.trim().toLowerCase();
	if (enabled !== "on" && enabled !== "off") {
		ctx.ui.notify(`사용법: /${COMMAND} on 또는 /${COMMAND} off`, "error");
		return;
	}

	const id = sessionId(ctx);
	if (!id) {
		ctx.ui.notify("세션 ID를 확인할 수 없어 캐시 TTL을 바꿀 수 없어.", "error");
		return;
	}

	const nextEnabled = enabled === "on";
	if (isAnthropicLongCacheEnabled(id) === nextEnabled) {
		ctx.ui.notify(`Anthropic 1시간 캐시는 이미 ${nextEnabled ? "켜져" : "꺼져"} 있어.`, "info");
		return;
	}

	setAnthropicLongCacheEnabled(id, nextEnabled);
	refreshStatus(ctx);
	ctx.ui.notify(`이 세션의 Anthropic 프롬프트 캐시 TTL을 ${nextEnabled ? "1시간" : "기본 5분"}으로 설정했어.`, "info");
}

export default function anthropicLongCache(pi: ExtensionAPI): void {
	for (const name of [COMMAND, COMMAND_ALIAS]) {
		pi.registerCommand(name, {
			description: "현재 세션의 Anthropic 프롬프트 캐시 TTL 설정 (on|off)",
			getArgumentCompletions,
			handler: (args, ctx) => handleCommand(args, ctx),
		});
	}

	pi.on("before_provider_request", (event, ctx) => {
		if (ctx.model?.provider !== "anthropic") return;
		const ttl = isAnthropicLongCacheEnabled(sessionId(ctx)) ? "1h" : undefined;
		return overrideAnthropicCacheTtl(event.payload, ttl);
	});

	pi.on("session_start", async (_event, ctx) => {
		refreshStatus(ctx);
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		if (ctx.hasUI) ctx.ui.setStatus(STATUS_KEY, undefined);
	});
}
