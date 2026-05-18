import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerReadTool } from "../utils/read-tool-ui.ts";

export default function readToolOverride(pi: ExtensionAPI) {
	registerReadTool(pi);
}
