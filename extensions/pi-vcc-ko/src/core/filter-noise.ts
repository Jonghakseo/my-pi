import type { NormalizedBlock } from "../types.ts";
import { type DenoiseRules, builtinRules } from "./rules.ts";

const NOISE_TOOLS = new Set([
	"TodoWrite",
	"TodoRead",
	"ToolSearch",
	"WebSearch",
	"AskUser",
	"ExitSpecMode",
	"GenerateDroid",
]);

const XML_WRAPPER_RE = /<(system-reminder|ide_opened_file|command-message|context-window-usage)[^>]*>[\s\S]*?<\/\1>/g;

const isNoiseUserBlock = (text: string, rules: DenoiseRules): boolean => {
	const trimmed = text.trim();
	if (rules.agentNotices.some((re) => re.test(trimmed))) return true;
	const stripped = trimmed.replace(XML_WRAPPER_RE, "").trim();
	return stripped.length === 0;
};

const cleanUserText = (text: string): string => text.replace(XML_WRAPPER_RE, "").trim();

export const filterNoise = (blocks: NormalizedBlock[], rules: DenoiseRules = builtinRules()): NormalizedBlock[] => {
	const out: NormalizedBlock[] = [];
	for (const b of blocks) {
		if (b.kind === "tool_call" && NOISE_TOOLS.has(b.name)) continue;
		if (b.kind === "tool_result" && NOISE_TOOLS.has(b.name)) continue;
		if (b.kind === "user") {
			if (isNoiseUserBlock(b.text, rules)) continue;
			const cleaned = cleanUserText(b.text);
			if (!cleaned) continue;
			out.push({ ...b, text: cleaned });
			continue;
		}
		out.push(b);
	}
	return out;
};
