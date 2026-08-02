# Azure AI Foundry DeepSeek provider

Registers an OpenAI Chat Completions-compatible Azure AI Foundry DeepSeek deployment as Pi's `azure-deepseek` provider.

## Configuration

Set these variables in the environment that starts Pi (for example, your shell profile). For local Pi reloads, the extension also loads `extensions/.env` without overwriting already-exported variables. The extension does not register until the endpoint and deployment are both present.

```sh
export AZURE_DEEPSEEK_ENDPOINT='https://creatrip-foundry-models-us2.services.ai.azure.com/openai/v1'
export AZURE_DEEPSEEK_DEPLOYMENT='deepseek-v4-pro'
export AZURE_DEEPSEEK_API_KEY='...'
```

Reload Pi after changing the variables, then select `azure-deepseek/deepseek-v4-pro` with `/model`.

- `AZURE_DEEPSEEK_ENDPOINT`: Azure AI Foundry OpenAI v1 base URL; a trailing slash is accepted.
- `AZURE_DEEPSEEK_DEPLOYMENT`: Azure deployment/model name passed as `model` to Chat Completions.
- `AZURE_DEEPSEEK_API_KEY`: resolved by Pi per request and passed to the OpenAI-compatible client as its API key. Never commit this value.

The extension uses Pi's `openai-completions` API adapter and DeepSeek reasoning compatibility settings. It sets costs to zero because Azure pricing varies by agreement.

## Image input

`deepseek-v4-pro` is registered as text-only. Pi already serializes image attachments as OpenAI-compatible `image_url` data URIs, but this Azure deployment accepts the request without reliably processing visual content. Advertising image support makes the model hallucinate image details, so this extension intentionally prevents `read` from attaching images. Use a separate vision-capable deployment (for example, GPT-4.1 or GPT-4o) to analyze images, then pass its text output to DeepSeek.

## References

- [Pi custom providers](https://github.com/earendil-works/pi/blob/v0.82.1/packages/coding-agent/docs/custom-provider.md)
- [Microsoft Foundry OpenAI v1 API](https://learn.microsoft.com/en-us/azure/foundry/openai/api-version-lifecycle)
