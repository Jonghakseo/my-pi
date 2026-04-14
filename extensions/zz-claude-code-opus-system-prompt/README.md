# zz-claude-code-opus-system-prompt

Test extension.

## Behavior

- If the selected model ID starts with `claude-opus-`, the extension replaces pi's system prompt with a curated Claude Code prompt assembled from vendored prompt fragments extracted from:
  - https://github.com/Piebald-AI/claude-code-system-prompts
- The original pi system prompt is wrapped in `<system-reminder>...</system-reminder>` and injected once as a persistent custom message.

## Notes

- This is intentionally experimental and prompt-fidelity is only approximate.
- The folder name starts with `zz-` so the extension tends to load late during auto-discovery.
- Vendored source files live under `vendor/system-prompts/`.
