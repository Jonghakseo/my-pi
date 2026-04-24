import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { registerEditTool } from "../utils/edit-tool-ui.ts";

export default function editToolOverride(pi: ExtensionAPI) {
	registerEditTool(pi);
}
