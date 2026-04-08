/**
 * User-facing UI strings for the interactive-shell extension.
 *
 * All strings the user sees in the overlay, widget, or terminal are defined here.
 * Agent-facing messages (notification-utils.ts, index.ts) remain in English
 * because LLMs parse them for state detection.
 */

// ── Overlay header hints ──

export function handsFreeHint(elapsed: string): string {
	return `🤖 자동 모드 (${elapsed}) • 아무 키나 누르면 직접 제어`;
}

export function tookOverHint(reason?: string): string {
	return reason ? `직접 제어 중 • ${reason} • Ctrl+B 백그라운드` : "직접 제어 중 • Ctrl+B 백그라운드";
}

export function defaultHint(reason?: string): string {
	return reason ? `Ctrl+B 백그라운드 • ${reason}` : "Ctrl+B 백그라운드";
}

export function reattachedHint(reason?: string): string {
	return reason ? `재연결됨 • ${reason} • Ctrl+B 백그라운드` : "재연결됨 • Ctrl+B 백그라운드";
}

// ── Overlay footer ──

export const FOOTER_HANDS_FREE = "🤖 에이전트 제어 중 • 아무 키로 전환 • Ctrl+T 전송 • Ctrl+B 백그라운드";
export const FOOTER_RUNNING = "Ctrl+T 전송 • Ctrl+B 백그라운드 • Ctrl+Q 메뉴 • Shift+↑↓ 스크롤";

export function exitSuccess(): string {
	return "✓ 정상 종료";
}

export function exitWithCode(code: number | null): string {
	return `✗ 코드 ${code}(으)로 종료`;
}

export function closingCountdown(seconds: number): string {
	return `${seconds}초 후 닫힘… (아무 키나 누르면 닫기)`;
}

// ── Detach dialog (Ctrl+Q) ──

export const DIALOG_TITLE = "세션 동작:";

export const DIALOG_OPTIONS = {
	transfer: "출력을 에이전트에 전송",
	background: "백그라운드로 실행",
	kill: "프로세스 종료",
	cancel: "취소 (세션으로 돌아가기)",
} as const;

export const DIALOG_HINT = "↑↓ 선택 • Enter 확인 • Esc 취소";

// ── Scroll indicator ──

export const SCROLL_HINT = "── ↑ 스크롤됨 (Shift+Down) ──";
export const SCROLL_HINT_SHORT = "── ↑ 스크롤됨 ──";

// ── Background widget status ──

export const STATUS_EXITED = "종료됨";
export const STATUS_RUNNING = "실행 중";

// ── PTY exit message ──

export function processExited(exitCode: number, signal?: string): string {
	const sig = signal ? ` (시그널: ${signal})` : "";
	return `\n[프로세스 종료: 코드 ${exitCode}${sig}]\n`;
}
