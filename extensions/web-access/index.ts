import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import initializeWebAccess from "./runtime.js";

export {
	normalizeCuratorTimeoutSeconds,
	normalizeProviderInput,
	normalizeQueryList,
	resolveWorkflow,
} from "./config-runtime.js";

export default function (pi: ExtensionAPI): void {
	initializeWebAccess(pi);
}
