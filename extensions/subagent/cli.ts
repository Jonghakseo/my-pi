/**
 * CLI-style command parser for the subagent tool.
 *
 * LLM-facing interface: { command: "subagent ..." }
 */

export type SubagentCliParseResult =
	| { type: "help" }
	| { type: "agents" }
	| { type: "params"; params: Record<string, any> }
	| { type: "error"; message: string };

export const SUBAGENT_CLI_HELP_TEXT = [
	"Subagent CLI (LLM interface)",
	"",
	'Always call this tool with: { command: "..." }',
	"When unsure, run: subagent help",
	"",
	"Commands:",
	"  subagent help",
	"  subagent agents",
	"  subagent run <agent> [--main|--isolated] [--async|--sync] -- <task>",
	"  subagent continue <runId> [--agent <agent>] [--main|--isolated] [--async|--sync] -- <task>",
	"  subagent runs",
	"  subagent status <runId>",
	"  subagent detail <runId>",
	"  subagent abort <runId|runId,runId|all>",
	"  subagent remove <runId|runId,runId|all>",
	"",
	"Examples:",
	"  subagent help",
	"  subagent run planner --main --async -- 로그인 성능 개선 계획 수립",
	"  subagent continue 22 -- 위 계획 기준으로 구현 태스크를 세분화해줘",
	"  subagent runs",
	"  subagent status 22",
	"  subagent abort 22",
	"  subagent remove all",
	"",
	"Notes:",
	"  - Use `--` before task text so spaces/newlines are preserved.",
	"  - Async completion/failure messages arrive automatically; do not poll in tight loops.",
].join("\n");

type TokenizeResult = { tokens: string[] } | { error: string };

function tokenizeCli(input: string): TokenizeResult {
	const tokens: string[] = [];
	let current = "";
	let quote: '"' | "'" | null = null;
	let escaped = false;

	for (let i = 0; i < input.length; i++) {
		const ch = input[i];

		if (escaped) {
			current += ch;
			escaped = false;
			continue;
		}

		if (ch === "\\") {
			escaped = true;
			continue;
		}

		if (quote) {
			if (ch === quote) {
				quote = null;
			} else {
				current += ch;
			}
			continue;
		}

		if (ch === '"' || ch === "'") {
			quote = ch;
			continue;
		}

		if (/\s/.test(ch)) {
			if (current) {
				tokens.push(current);
				current = "";
			}
			continue;
		}

		current += ch;
	}

	if (escaped) {
		current += "\\";
	}

	if (quote) {
		return { error: "Unclosed quote in command." };
	}

	if (current) tokens.push(current);
	return { tokens };
}

function parseInteger(raw: string): number | null {
	if (!/^\d+$/.test(raw)) return null;
	const value = Number.parseInt(raw, 10);
	return Number.isInteger(value) ? value : null;
}

function parseRunTarget(
	raw: string,
	knownRunIds: number[] | undefined,
): { runId: number } | { runIds: number[] } | { error: string } {
	if (!raw) return { error: "Missing run target." };

	if (raw.toLowerCase() === "all") {
		const unique = Array.from(new Set((knownRunIds ?? []).filter((id) => Number.isInteger(id))));
		if (unique.length === 0) {
			return { error: "No runs available for target `all`." };
		}
		return { runIds: unique };
	}

	if (raw.includes(",")) {
		const ids = raw
			.split(",")
			.map((part) => parseInteger(part.trim()))
			.filter((id): id is number => id !== null);
		if (ids.length === 0) return { error: `Invalid run target: ${raw}` };
		const unique = Array.from(new Set(ids));
		return unique.length === 1 ? { runId: unique[0] } : { runIds: unique };
	}

	const runId = parseInteger(raw);
	if (runId === null) return { error: `Invalid runId: ${raw}` };
	return { runId };
}

function parseRunLike(verb: "run" | "continue", args: string[]): { params: Record<string, any> } | { error: string } {
	const sepIndex = args.indexOf("--");
	if (sepIndex === -1) {
		return { error: `${verb} requires task separator \`--\`. Example: subagent ${verb} ... -- <task>` };
	}

	const head = args.slice(0, sepIndex);
	const task = args
		.slice(sepIndex + 1)
		.join(" ")
		.trim();
	if (!task) return { error: `${verb} requires non-empty task after \`--\`.` };

	let runId: number | undefined;
	let agent: string | undefined;
	let contextMode: "main" | "isolated" | undefined;
	let runAsync: boolean | undefined;

	for (let i = 0; i < head.length; i++) {
		const token = head[i];

		if (token === "--main") {
			contextMode = "main";
			continue;
		}
		if (token === "--isolated") {
			contextMode = "isolated";
			continue;
		}
		if (token === "--async") {
			runAsync = true;
			continue;
		}
		if (token === "--sync") {
			runAsync = false;
			continue;
		}
		if (token === "--agent") {
			const value = head[i + 1];
			if (!value) return { error: "--agent requires a value." };
			agent = value;
			i++;
			continue;
		}
		if (token.startsWith("--agent=")) {
			agent = token.slice("--agent=".length);
			continue;
		}

		if (token.startsWith("--")) {
			return { error: `Unknown option: ${token}` };
		}

		if (verb === "continue") {
			if (runId === undefined) {
				const parsed = parseInteger(token);
				if (parsed === null) return { error: `continue requires numeric runId. Got: ${token}` };
				runId = parsed;
				continue;
			}
			return { error: `Unexpected argument: ${token}` };
		}

		// run
		if (!agent) {
			agent = token;
			continue;
		}
		return { error: `Unexpected argument: ${token}` };
	}

	if (verb === "continue" && runId === undefined) {
		return { error: "continue requires <runId>." };
	}

	const params: Record<string, any> = { task };
	if (verb === "continue") {
		params.runId = runId;
		if (agent) params.agent = agent;
	} else {
		params.agent = agent ?? "worker";
	}
	if (contextMode) params.contextMode = contextMode;
	if (runAsync !== undefined) params.runAsync = runAsync;

	return { params };
}

function extractVerb(tokens: string[]): { verb: string; args: string[] } {
	if (tokens.length === 0) return { verb: "help", args: [] };
	if (tokens[0] === "subagent") {
		if (tokens.length === 1) return { verb: "help", args: [] };
		return { verb: tokens[1], args: tokens.slice(2) };
	}
	return { verb: tokens[0], args: tokens.slice(1) };
}

export function parseSubagentCommandVerb(command: unknown): string | null {
	if (typeof command !== "string") return null;
	const trimmed = command.trim();
	if (!trimmed) return null;
	const tokenized = tokenizeCli(trimmed);
	if ("error" in tokenized) return null;
	return extractVerb(tokenized.tokens).verb;
}

export function isSubagentAsyncLaunchCommand(command: unknown): boolean {
	if (typeof command !== "string") return false;
	const trimmed = command.trim();
	if (!trimmed) return false;
	const tokenized = tokenizeCli(trimmed);
	if ("error" in tokenized) return false;
	const { verb, args } = extractVerb(tokenized.tokens);
	if (verb !== "run" && verb !== "continue") return false;

	const sepIndex = args.indexOf("--");
	const head = sepIndex === -1 ? args : args.slice(0, sepIndex);
	if (head.includes("--sync")) return false;
	if (head.includes("--async")) return true;
	return true;
}

export function parseSubagentToolCommand(
	command: unknown,
	options: { knownRunIds?: number[] } = {},
): SubagentCliParseResult {
	if (typeof command !== "string") {
		return { type: "error", message: "Missing required string parameter `command`. Try `subagent help`." };
	}

	const trimmed = command.trim();
	if (!trimmed) {
		return { type: "error", message: "Empty command. Try `subagent help`." };
	}

	const tokenized = tokenizeCli(trimmed);
	if ("error" in tokenized) {
		return { type: "error", message: tokenized.error };
	}

	const { verb, args } = extractVerb(tokenized.tokens);

	switch (verb) {
		case "help":
			return { type: "help" };

		case "agents":
			return { type: "agents" };

		case "runs":
			return { type: "params", params: { asyncAction: "list" } };

		case "status": {
			const runIdRaw = args[0];
			if (!runIdRaw) return { type: "error", message: "status requires <runId>." };
			const runId = parseInteger(runIdRaw);
			if (runId === null) return { type: "error", message: `Invalid runId: ${runIdRaw}` };
			return { type: "params", params: { asyncAction: "status", runId } };
		}

		case "detail": {
			const runIdRaw = args[0];
			if (!runIdRaw) return { type: "error", message: "detail requires <runId>." };
			const runId = parseInteger(runIdRaw);
			if (runId === null) return { type: "error", message: `Invalid runId: ${runIdRaw}` };
			return { type: "params", params: { asyncAction: "detail", runId } };
		}

		case "abort":
		case "remove": {
			const target = args[0];
			if (!target) return { type: "error", message: `${verb} requires <runId|runId,runId|all>.` };
			const parsedTarget = parseRunTarget(target, options.knownRunIds);
			if ("error" in parsedTarget) return { type: "error", message: parsedTarget.error };
			return {
				type: "params",
				params: {
					asyncAction: verb,
					...parsedTarget,
				},
			};
		}

		case "run": {
			const parsed = parseRunLike("run", args);
			if ("error" in parsed) return { type: "error", message: parsed.error };
			return { type: "params", params: parsed.params };
		}

		case "continue": {
			const parsed = parseRunLike("continue", args);
			if ("error" in parsed) return { type: "error", message: parsed.error };
			return { type: "params", params: parsed.params };
		}

		default:
			return {
				type: "error",
				message: `Unknown subcommand: ${verb}`,
			};
	}
}
