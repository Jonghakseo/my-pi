import { describe, expect, it } from "vitest";

import { createAzureDeepSeekProviderConfig } from "./index.js";

describe("createAzureDeepSeekProviderConfig", () => {
	it("does not register without both endpoint and deployment configuration", () => {
		expect(createAzureDeepSeekProviderConfig({})).toBeUndefined();
		expect(
			createAzureDeepSeekProviderConfig({
				AZURE_DEEPSEEK_ENDPOINT: "https://example.services.ai.azure.com/openai/v1",
			}),
		).toBeUndefined();
	});

	it("uses environment variables for the endpoint and deployment", () => {
		const config = createAzureDeepSeekProviderConfig({
			AZURE_DEEPSEEK_ENDPOINT: "https://example.services.ai.azure.com/openai/v1/ ",
			AZURE_DEEPSEEK_DEPLOYMENT: " deepseek-v4-pro ",
		});

		expect(config).toMatchObject({
			baseUrl: "https://example.services.ai.azure.com/openai/v1",
			apiKey: "$AZURE_DEEPSEEK_API_KEY",
			api: "openai-completions",
		});
		expect(config?.models?.[0]).toMatchObject({
			id: "deepseek-v4-pro",
			reasoning: true,
			input: ["text"],
			compat: { supportsReasoningEffort: true },
		});
		expect("thinkingFormat" in (config?.models?.[0]?.compat ?? {})).toBe(false);
	});
});
