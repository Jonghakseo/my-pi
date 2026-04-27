import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { PENDING_AFTER_MS, STATE_ROOT, STATUS_KEY, WIDGET_KEY, WIDGET_REFRESH_MS } from "./constants.js";
import { displayPath, findSetupPath, repoKeyFor, resolveSetupContext } from "./context.js";
import { cancelSetup, createWrapperScript, startSetup } from "./runner.js";
import { finalizeRunIfNeeded } from "./state.js";
import type { SetupContext, StartMode, StartResult } from "./types.js";
import { formatDuration, shellQuote, stripAnsi } from "./utils.js";
import {
	formatSnapshotLine,
	installWidget,
	refreshWatcher,
	renderWidgetLine,
	showStatus,
	stopWatcher,
	type Watcher,
} from "./widget.js";

function commandHelp(): string {
	return [
		"/setup-sh [status|rerun|cancel|clear]",
		"- 인자 없음: 현재 폴더의 setup.sh 실행 또는 실행 상태 표시",
		"- status: 상세 상태와 로그 tail 표시",
		"- rerun: 성공/실패 상태와 무관하게 재실행",
		"- cancel: 실행 중인 setup.sh 종료",
		"- clear: 현재 세션의 setup widget 숨김",
	].join("\n");
}

async function notifyStartResult(ctx: ExtensionContext, result: StartResult): Promise<void> {
	if (result.kind === "started") {
		ctx.ui.notify(`setup.sh 실행 시작: ${displayPath(result.context.repoRoot)}`, "info");
		return;
	}
	if (result.kind === "running") {
		ctx.ui.notify(`setup.sh가 이미 실행 중입니다: ${displayPath(result.context.repoRoot)}`, "info");
		return;
	}
	if (result.kind === "skipped") {
		ctx.ui.notify(result.reason, "info");
		return;
	}
	if (result.kind === "failed") {
		ctx.ui.notify(result.reason, "error");
	}
}

export const __test__ = {
	STATE_ROOT,
	PENDING_AFTER_MS,
	displayPath,
	findSetupPath,
	formatDuration,
	formatSnapshotLine,
	repoKeyFor,
	renderWidgetLine,
	resolveSetupContext,
	createWrapperScript,
	shellQuote,
	stripAnsi,
};

export default function setupShExtension(pi: ExtensionAPI): void {
	let watcher: Watcher | null = null;
	const hiddenRepoKeys = new Set<string>();

	async function watch(ctx: ExtensionContext, context: SetupContext): Promise<void> {
		if (!ctx.hasUI || hiddenRepoKeys.has(context.repoKey)) return;
		stopWatcher(ctx, watcher);
		watcher = {
			context,
			interval: setInterval(() => {
				if (watcher) void refreshWatcher(ctx, watcher);
			}, WIDGET_REFRESH_MS),
			snapshot: null,
			tui: null,
			disposed: false,
		};
		installWidget(ctx, watcher);
		await refreshWatcher(ctx, watcher);
	}

	async function runOrAttach(ctx: ExtensionContext, mode: StartMode): Promise<StartResult> {
		const result = await startSetup(ctx.cwd, mode);
		if (result.kind !== "no-setup" && result.kind !== "failed") {
			hiddenRepoKeys.delete(result.context.repoKey);
			await watch(ctx, result.context);
		}
		return result;
	}

	pi.on("session_start", async (event, ctx) => {
		const context = resolveSetupContext(ctx.cwd);
		if (!context) {
			if (ctx.hasUI) {
				ctx.ui.setWidget(WIDGET_KEY, undefined);
				ctx.ui.setStatus(STATUS_KEY, undefined);
			}
			return;
		}

		if (event.reason === "reload") {
			await finalizeRunIfNeeded(context);
			await watch(ctx, context);
			return;
		}

		const result = await runOrAttach(ctx, "auto");
		if (!ctx.hasUI) return;
		if (result.kind === "started") {
			ctx.ui.notify(`setup.sh 자동 실행 시작: ${displayPath(result.context.repoRoot)}`, "info");
		}
		if (result.kind === "running") ctx.ui.notify(`setup.sh 실행 중: ${displayPath(result.context.repoRoot)}`, "info");
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		stopWatcher(ctx, watcher);
		watcher = null;
	});

	pi.registerCommand("setup-sh", {
		description: "Run or inspect ./setup.sh for the current folder",
		getArgumentCompletions: (prefix: string) => {
			const values = ["status", "rerun", "cancel", "clear", "help"];
			return values
				.filter((value) => value.startsWith(prefix.trim()))
				.map((value) => ({ value, label: value, description: `/setup-sh ${value}` }));
		},
		handler: async (args, ctx) => {
			const action = args.trim() || "run";
			const context = resolveSetupContext(ctx.cwd);
			if (action === "help") {
				ctx.ui.notify(commandHelp(), "info");
				return;
			}
			if (!context) {
				ctx.ui.notify("현재 폴더 또는 상위 폴더에서 setup.sh를 찾지 못했습니다.", "warning");
				return;
			}

			if (action === "clear") {
				hiddenRepoKeys.add(context.repoKey);
				stopWatcher(ctx, watcher);
				watcher = null;
				ctx.ui.notify("setup.sh widget을 숨겼습니다.", "info");
				return;
			}

			if (action === "status") {
				hiddenRepoKeys.delete(context.repoKey);
				await watch(ctx, context);
				await showStatus(ctx, context);
				return;
			}

			if (action === "cancel") {
				const message = await cancelSetup(context);
				hiddenRepoKeys.delete(context.repoKey);
				await watch(ctx, context);
				ctx.ui.notify(message, "warning");
				return;
			}

			if (action !== "run" && action !== "rerun") {
				ctx.ui.notify(commandHelp(), "warning");
				return;
			}

			const mode: StartMode = action === "rerun" ? "rerun" : "manual";
			await notifyStartResult(ctx, await runOrAttach(ctx, mode));
		},
	});
}
