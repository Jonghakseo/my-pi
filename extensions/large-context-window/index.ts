import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";

const TARGET_CONTEXT_WINDOW = 922_000;
const TARGET_MODELS = ["gpt-5.4", "gpt-5.5"];

function isTarget(ctx: ExtensionContext): boolean {
	const id = ctx.model?.id;
	if (!id) return false;
	return TARGET_MODELS.some((m) => id.startsWith(m));
}

async function applyLargeContext(pi: ExtensionAPI, ctx: ExtensionContext) {
	const model = ctx.model;
	if (!model || model.contextWindow >= TARGET_CONTEXT_WINDOW) return;
	if (!isTarget(ctx)) return;

	const updated = { ...model, contextWindow: TARGET_CONTEXT_WINDOW };
	const ok = await pi.setModel(updated);
	if (ok && ctx.hasUI) {
		ctx.ui.notify(
			`${model.id} context window: ${(model.contextWindow / 1000).toFixed(0)}K → ${(TARGET_CONTEXT_WINDOW / 1000).toFixed(0)}K`,
			"info",
		);
	}
}

export default function (pi: ExtensionAPI) {
	pi.on("model_select", async (_event, ctx) => {
		await applyLargeContext(pi, ctx);
	});

	pi.on("session_start", async (_event, ctx) => {
		await applyLargeContext(pi, ctx);
	});
}
