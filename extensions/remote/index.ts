/** biome-ignore-all lint/suspicious/noExplicitAny: remote command/session hooks use dynamic interactive-mode context objects. */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { writeCloseRequest } from "./src/close-request.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));

interface PendingRemoteLaunch {
	sessionFile?: string;
	funnel: boolean;
	lan: boolean;
}

function resolveLauncherPath(): string {
	const launcherPath = join(__dirname, "dist", "cli.js");
	if (!existsSync(launcherPath)) {
		throw new Error(`Remote launcher not found: ${launcherPath}`);
	}
	return launcherPath;
}

function buildWidgetLines(): string[] {
	const remoteUrl = process.env.PI_REMOTE_URL;
	if (!remoteUrl) return [];

	const mode = process.env.PI_REMOTE_MODE ?? "lan";
	const pin = process.env.PI_REMOTE_PIN;

	const lines = [`Remote (${mode}): ${remoteUrl}`];
	if (pin) {
		lines.push(`PIN: ${pin} (runtime 중 변경될 수 있음)`);
	}
	return lines;
}

export default function (pi: ExtensionAPI) {
	let pendingLaunch: PendingRemoteLaunch | null = null;

	const remoteHandler = async (variant: { funnel: boolean; lan: boolean }, ctx: any) => {
		if (!ctx.hasUI) {
			process.stdout.write("/remote is only available in interactive mode.\n");
			return;
		}

		await ctx.waitForIdle();

		pendingLaunch = {
			sessionFile: ctx.sessionManager.getSessionFile() ?? undefined,
			funnel: variant.funnel,
			lan: variant.lan,
		};

		const modeLabel = variant.lan ? "LAN" : variant.funnel ? "Funnel" : "auto";
		ctx.ui.notify(`Starting remote mode (${modeLabel})...`, "info");
		ctx.shutdown();
	};

	pi.registerCommand("remote", {
		description: "Start remote access (auto: Tailscale HTTPS if available, else LAN)",
		handler: async (_args, ctx) => remoteHandler({ funnel: false, lan: false }, ctx),
	});

	pi.registerCommand("remote:lan", {
		description: "Start remote access in LAN-only mode",
		handler: async (_args, ctx) => remoteHandler({ funnel: false, lan: true }, ctx),
	});

	pi.registerCommand("remote:funnel", {
		description: "Start remote access via Tailscale Funnel (public URL)",
		handler: async (_args, ctx) => remoteHandler({ funnel: true, lan: false }, ctx),
	});

	pi.registerCommand("remote:close", {
		description: "Exit remote mode and return to normal pi (⚠ initial session: shuts down entire server)",
		handler: async (_args, ctx) => {
			if (!process.env.PI_REMOTE_URL) {
				ctx.ui.notify("Not in remote mode.", "error");
				return;
			}

			const sessionId = process.env.PI_REMOTE_SESSION_ID;
			const isInitial = process.env.PI_REMOTE_ATTACH_LOCAL === "1";

			if (sessionId) {
				const action = isInitial ? "shutdown-server" : "return-local";
				try {
					writeCloseRequest(sessionId, action);
				} catch {
					ctx.ui.notify("Failed to write close request. Session will exit without local relaunch.", "error");
				}
			}

			if (isInitial) {
				ctx.ui.notify("⚠ Shutting down remote server and all sessions. Returning to local pi...", "warning");
			} else {
				ctx.ui.notify("Exiting remote session and returning to local pi...", "info");
			}
			ctx.shutdown();
		},
	});

	pi.on("session_shutdown", async () => {
		if (!pendingLaunch) return;

		const current = pendingLaunch;
		pendingLaunch = null;

		const launcherPath = resolveLauncherPath();
		const extensionPath = join(__dirname, "index.ts");
		const launcherArgs = [launcherPath];

		if (current.sessionFile) {
			launcherArgs.push("--session", current.sessionFile);
		}
		if (current.funnel) {
			launcherArgs.push("--funnel");
		}
		if (current.lan) {
			launcherArgs.push("--lan");
		}

		launcherArgs.push("--", "-e", extensionPath);

		const originalExit = process.exit;
		process.exit = ((code?: number) => {
			process.exit = originalExit;
			const result = spawnSync(process.execPath, launcherArgs, {
				stdio: "inherit",
				cwd: process.cwd(),
				env: process.env as Record<string, string>,
			});
			originalExit(result.status ?? code ?? 1);
		}) as typeof process.exit;
	});

	const syncWidget = async (_event: unknown, ctx: any) => {
		if (!ctx.hasUI) return;
		const lines = buildWidgetLines();
		if (lines.length === 0) {
			ctx.ui.setWidget("remote-url", undefined);
			return;
		}
		ctx.ui.setWidget("remote-url", lines, { placement: "belowEditor" });
	};

	pi.on("session_start", async (_event: unknown, ctx: any) => {
		await syncWidget(_event, ctx);

		if (process.env.PI_REMOTE_URL && ctx.hasUI) {
			const remoteUrl = process.env.PI_REMOTE_URL;
			const mode = process.env.PI_REMOTE_MODE ?? "lan";
			const pin = process.env.PI_REMOTE_PIN;
			const parts = [`Remote (${mode}): ${remoteUrl}`];
			if (pin) parts.push(`PIN: ${pin}`);
			ctx.ui.notify(parts.join(" | "), "info");
		}
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		if (!ctx.hasUI) return;
		ctx.ui.setWidget("remote-url", undefined);
	});
}
