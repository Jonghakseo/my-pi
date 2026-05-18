import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerEditTool } from "../utils/edit-tool-ui.ts";

export default function editToolOverride(pi: ExtensionAPI) {
	registerEditTool(pi);
}
