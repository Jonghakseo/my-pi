import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { registerCompatibilityNotifications } from "./utils/hashline-compatibility-notify.ts";
import { registerEditTool } from "./utils/hashline-edit.ts";

export default function editToolOverride(pi: ExtensionAPI) {
	registerEditTool(pi);
	registerCompatibilityNotifications(pi);
}
