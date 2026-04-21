import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

export default async function loadPiDesktopUi(pi: ExtensionAPI) {
	const moduleUrl = new URL("../../vendor/pi-desktop-ui/index.ts", import.meta.url).href;
	const mod = (await import(moduleUrl)) as { default: (api: ExtensionAPI) => unknown | Promise<unknown> };
	return mod.default(pi);
}
