/**
 * Pi Pi style footer (first-line focused)
 *
 * - Replaces the built-in footer via ctx.ui.setFooter()
 * - First line follows the style you requested
 * - Second line (optional) shows extension statuses from ctx.ui.setStatus()
 *
 * ## CJK 폭 오버플로 런타임 패치
 *
 * pi 내장 FooterComponent.render() 는 `pwd.length` 로 터미널 폭을 비교하는데,
 * 한국어 등 CJK 문자는 터미널에서 2칸을 차지하지만 JS string.length 는 1로 세므로
 * truncation 을 건너뛰거나, String.slice() 기반 truncation 이 부족해 TUI 크래시가 난다.
 *
 * 평소에는 이 커스텀 footer 가 내장 footer 를 대체하므로 문제가 없지만,
 * `/reload` 시 resetExtensionUI() → setExtensionFooter(undefined) 순서로
 * 커스텀 footer 가 잠깐 제거되고 내장 footer 가 활성화되는 순간 크래시가 터진다.
 *
 * FooterComponent 는 ESM export 되므로, prototype.render 를 monkey-patch 하여
 * 원본 render 의 결과를 truncateToWidth() 로 감싸는 방식으로 **메모리 내 즉시** 수정한다.
 * 파일 I/O 없음, Node 모듈 캐시 문제 없음, 현재 프로세스에서 바로 효과.
 *
 * @see pi 코어에 근본 수정 PR 필요 (FooterComponent 에서 visibleWidth 사용)
 */

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";

/**
 * pi 내장 FooterComponent.prototype.render 를 monkey-patch 한다.
 *
 * ──────────────────────────────────────────────────────────────
 * 왜 필요한가?
 * ──────────────────────────────────────────────────────────────
 * 내장 footer 는 `cwd (branch) • sessionName` 문자열을 만든 뒤
 * `if (pwd.length > width)` 로 truncation 여부를 판단한다.
 *
 *   예) "~/.gwtree/.../fix-email (fix/check-affiliate-email) • 어필리에이트 수식 확인"
 *       pwd.length   = 91  →  91 < 96(터미널 폭)  →  truncation 스킵
 *       visibleWidth = 101  →  101 > 96            →  TUI 크래시!
 *
 * 또한 truncation 이 발동되더라도 String.slice() 기반이라 CJK 문자 경계를
 * 고려하지 못해 잘린 결과도 여전히 폭 초과가 가능하다.
 *
 * ──────────────────────────────────────────────────────────────
 * 패치 방식
 * ──────────────────────────────────────────────────────────────
 * FooterComponent.prototype.render 를 래핑하여 원본 render 가 반환한
 * 모든 라인에 truncateToWidth(line, width) 를 적용한다.
 *
 * - 원본 로직은 그대로 유지 (호환성 최대화)
 * - 단지 반환값에 안전망을 추가할 뿐
 *
 * ──────────────────────────────────────────────────────────────
 * 안전성
 * ──────────────────────────────────────────────────────────────
 * - 즉시 적용: ESM 모듈 캐시의 같은 클래스를 패치하므로 import 즉시 효과.
 * - 멱등: __cjkPatched 플래그로 중복 패치 방지.
 * - 실패 무시: import 실패 시 catch 로 무시. 패치 없이 원래대로 동작.
 * - pi 자체 수정 시: render 시그니처가 바뀌지 않는 한 호환됨.
 *   만약 바뀌더라도 원본 render 가 에러 없이 실행되면 래핑도 문제없음.
 * - pi 업데이트 시: 새 프로세스에서 다시 import & 패치 (메모리 패치라 자동).
 */
async function patchFooterPrototype(): Promise<void> {
	try {
		const mod = await import(
			"@mariozechner/pi-coding-agent/dist/modes/interactive/components/footer.js"
		);
		const proto = mod.FooterComponent?.prototype;
		if (!proto?.render || (proto as any).__cjkPatched) return;

		const originalRender = proto.render;
		proto.render = function patchedRender(width: number): string[] {
			const lines: string[] = originalRender.call(this, width);
			return lines.map((line: string) =>
				visibleWidth(line) > width ? truncateToWidth(line, width) : line,
			);
		};
		(proto as any).__cjkPatched = true;
	} catch {
		// import 실패 시 무시 — 최악의 경우 원래 버그가 그대로 남을 뿐
	}
}

const BAR_WIDTH = 10;

function clamp(n: number, min: number, max: number): number {
	return Math.max(min, Math.min(max, n));
}

function getFolderName(cwd: string): string {
	const parts = cwd.split(/[\\/]/).filter(Boolean);
	return parts.length > 0 ? parts[parts.length - 1] : cwd || "unknown";
}

function installFooter(ctx: ExtensionContext) {
	if (!ctx.hasUI) return;

	ctx.ui.setFooter((tui, theme, footerData) => ({
		dispose: footerData.onBranchChange(() => tui.requestRender()),
		invalidate() {},
		render(width: number): string[] {
			const model = ctx.model?.id || "no-model";
			const usage = ctx.getContextUsage();
			const pct = clamp(Math.round(usage?.percent ?? 0), 0, 100);
			const filled = Math.round((pct / 100) * BAR_WIDTH);
			const bar = "#".repeat(filled) + "-".repeat(BAR_WIDTH - filled);

			const statuses = Array.from(footerData.getExtensionStatuses().values()).filter(Boolean);
			const active = statuses.filter((s) => /research(ing)?/i.test(s)).length;
			const done = statuses.filter((s) => /(^|\s)(done|✓)(\s|$)/i.test(s)).length;

			const folder = getFolderName(ctx.sessionManager.getCwd());
			const branch = footerData.getGitBranch();
			const projectRef = branch ? `${folder} - ${branch}` : `${folder} - no-branch`;

			const left =
				theme.fg("dim", ` ${model}`) +
				theme.fg("muted", " · ") +
				theme.fg("accent", projectRef);

			const mid =
				active > 0
					? theme.fg("accent", ` ◉ ${active} researching`)
					: done > 0
						? theme.fg("success", ` ✓ ${done} done`)
						: "";

			const remaining = 100 - pct;
			const barColor = remaining <= 15 ? "error" : remaining <= 40 ? "warning" : "dim";
			const right = theme.fg(barColor, `[${bar}] ${pct}% `);
			const pad = " ".repeat(Math.max(1, width - visibleWidth(left) - visibleWidth(mid) - visibleWidth(right)));

			const lines = [truncateToWidth(left + mid + pad + right, width)];

			if (statuses.length > 0) {
				const statusLine = truncateToWidth(` ${statuses.join(" · ")}`, width);
				lines.push(statusLine);
			}

			return lines;
		},
	}));
}

export default function (pi: ExtensionAPI) {
	// 내장 FooterComponent.prototype.render 를 래핑하여 CJK 폭 오버플로 방지
	// extension 로드 시 즉시 실행 (async 이지만 fire-and-forget — 보통 즉시 완료)
	patchFooterPrototype();

	pi.on("session_start", async (_event, ctx) => {
		installFooter(ctx);
	});

	pi.on("session_switch", async (_event, ctx) => {
		installFooter(ctx);
	});

	pi.on("session_fork", async (_event, ctx) => {
		installFooter(ctx);
	});

	pi.on("session_tree", async (_event, ctx) => {
		installFooter(ctx);
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		if (!ctx.hasUI) return;
		ctx.ui.setFooter(undefined);
	});
}
