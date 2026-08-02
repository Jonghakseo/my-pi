import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ProviderConfig } from "@earendil-works/pi-coding-agent";

const LOCAL_ENV_PATH = fileURLToPath(new URL("../.env", import.meta.url));

export function loadLocalEnvironment(env: NodeJS.ProcessEnv = process.env): void {
	try {
		const contents = readFileSync(LOCAL_ENV_PATH, "utf8");
		for (const line of contents.split(/\r?\n/)) {
			const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
			if (!match) continue;
			const [, name, rawValue] = match;
			if (env[name] !== undefined) continue;
			env[name] = rawValue.replace(/^(['"])(.*)\1$/, "$2");
		}
	} catch (error) {
		if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
	}
}

function optionalEnv(env: NodeJS.ProcessEnv, name: string): string | undefined {
	const value = env[name]?.trim();
	return value || undefined;
}

function trimTrailingSlashes(url: string): string {
	return url.replace(/\/+$/, "");
}

/**
 * Returns undefined until the endpoint and deployment name are configured.
 * The API key itself is resolved by Pi per request from AZURE_DEEPSEEK_API_KEY.
 */
export function createAzureDeepSeekProviderConfig(env: NodeJS.ProcessEnv = process.env): ProviderConfig | undefined {
	const endpoint = optionalEnv(env, "AZURE_DEEPSEEK_ENDPOINT");
	const deploymentName = optionalEnv(env, "AZURE_DEEPSEEK_DEPLOYMENT");
	if (!endpoint || !deploymentName) return undefined;

	return {
		name: "Azure AI Foundry DeepSeek",
		baseUrl: trimTrailingSlashes(endpoint),
		apiKey: "$AZURE_DEEPSEEK_API_KEY",
		api: "openai-completions",
		models: [
			{
				id: deploymentName,
				name: `DeepSeek ${deploymentName.replace(/^deepseek-/i, "").replaceAll("-", " ")}`,
				reasoning: true,
				thinkingLevelMap: {
					minimal: null,
					low: null,
					medium: null,
					high: "high",
					max: "max",
				},
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 1_000_000,
				maxTokens: 384_000,
				compat: {
					supportsStore: false,
					supportsDeveloperRole: false,
					supportsReasoningEffort: true,
					requiresReasoningContentOnAssistantMessages: true,
				},
			},
		],
	};
}

export default function (pi: ExtensionAPI): void {
	loadLocalEnvironment();
	const config = createAzureDeepSeekProviderConfig();
	if (config) pi.registerProvider("azure-deepseek", config);
}
