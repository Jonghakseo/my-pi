import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { registerReadTool } from "./utils/hashline-read.ts";

export default function readToolOverride(pi: ExtensionAPI) {
	registerReadTool(pi);
}
