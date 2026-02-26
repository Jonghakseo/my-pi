/**
 * Pi Pi style footer (first-line focused)
 *
 * - Replaces the built-in footer via ctx.ui.setFooter()
 * - First line follows the style you requested
 * - Second line (optional) shows extension statuses from ctx.ui.setStatus()
 *
 * ## CJK 폭 오버플로 자동 패치
 *
 * pi 내장 FooterComponent(footer.js)에는 `pwd.length > width` 로 터미널 폭을
 * 검사하는 버그가 있다. 한국어 등 CJK 문자는 터미널에서 2칸을 차지하지만
 * JS string.length 는 1로 세기 때문에 truncation 이 건너뛰어져 TUI 크래시가 발생한다.
 *
 * 평소에는 이 커스텀 footer 가 내장 footer 를 대체하므로 문제가 없지만,
 * `/reload` 실행 시 resetExtensionUI() → setExtensionFooter(undefined) 순서로
 * 커스텀 footer 가 잠깐 제거되고 내장 footer 가 활성화되는 순간 크래시가 터진다.
 *
 * 이 extension 이 로드될 때 footer.js 를 읽어 버그가 있으면 자동 패치한다.
 * pi 업데이트로 footer.js 가 원복되더라도 다음 실행 시 다시 패치된다.
 *
 * @see https://github.com/nickarellano/pi-coding-agent — 근본 수정은 pi 코어에 PR 필요
 */

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";
import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";

/**
 * pi 내장 footer.js 의 CJK 폭 계산 버그를 자동 패치한다.
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
 * ──────────────────────────────────────────────────────────────
 * 패치 내용 (2곳)
 * ──────────────────────────────────────────────────────────────
 * 1. 조건문: `pwd.length > width`  →  `visibleWidth(pwd) > width`
 *    - CJK 더블폭 문자를 올바르게 측정하여 truncation 이 정상 작동하도록 한다.
 *
 * 2. 안전망: lines[] 직전에 `pwd = truncateToWidth(pwd, width)` 삽입
 *    - 내장 footer 의 half-기반 truncation 은 String.slice() 를 쓰므로
 *      CJK 문자 경계를 고려하지 못해 잘린 뒤에도 폭이 초과될 수 있다.
 *    - 이 한 줄이 최종 방어선 역할을 한다.
 *
 * ──────────────────────────────────────────────────────────────
 * 안전성
 * ──────────────────────────────────────────────────────────────
 * - 멱등: `pwd.length > width` 문자열이 없으면 즉시 return (이미 패치됨 or 코어 수정됨).
 * - 실패 무시: resolve/read/write 어디서든 에러나면 catch 로 무시. 패치 없이 원래대로 동작.
 * - 범위 한정: footer.js 의 특정 두 문자열만 치환. 다른 코드에 영향 없음.
 *   - "pwd.length > width"  — footer.js 에서 단 1회 등장
 *   - 'const lines = [theme.fg("dim", pwd)'  — footer.js 에서 단 1회 등장
 * - pi 업데이트 시: footer.js 가 원복 → 다음 pi 실행 시 extension 로드에서 재패치.
 * - pi 가 자체 수정 시: pwd.length 문자열이 사라지므로 패치가 자동으로 비활성화됨.
 */
function patchBuiltInFooterIfNeeded(): void {
	try {
		const require = createRequire(import.meta.url);
		const footerPath = require.resolve(
			"@mariozechner/pi-coding-agent/dist/modes/interactive/components/footer.js",
		);
		let src = readFileSync(footerPath, "utf-8");

		// 이미 패치됐거나 pi 가 자체 수정한 경우 → 아무것도 안 함
		if (!src.includes("pwd.length > width")) return;

		// Fix 1: 조건문 — visibleWidth() 로 CJK 더블폭 올바르게 측정
		src = src.replace("pwd.length > width", "visibleWidth(pwd) > width");

		// Fix 2: 안전망 — 내장 half-기반 truncation 이 CJK 를 잘못 잘라도 최종 방어
		src = src.replace(
			'const lines = [theme.fg("dim", pwd)',
			'pwd = truncateToWidth(pwd, width);\n        const lines = [theme.fg("dim", pwd)',
		);

		writeFileSync(footerPath, src, "utf-8");
	} catch {
		// 패치 실패는 무시 — 최악의 경우 원래 버그가 그대로 남을 뿐, 새 문제는 없음
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
	// Auto-patch built-in footer for CJK width safety (idempotent, best-effort)
	patchBuiltInFooterIfNeeded();

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
