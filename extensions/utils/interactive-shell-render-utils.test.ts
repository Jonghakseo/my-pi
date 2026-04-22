import { visibleWidth } from "@mariozechner/pi-tui";
import { describe, expect, it } from "vitest";
import { centerOverlayText, fitOverlayRowContent } from "../interactive-shell/render-utils.ts";

describe("fitOverlayRowContent", () => {
	it("truncates long overlay rows to the available width", () => {
		const rendered = fitOverlayRowContent("🤖 에이전트 제어 중 • 아무 키로 전환 • Ctrl+T 전송", 12);
		expect(visibleWidth(rendered)).toBe(12);
	});

	it("pads shorter overlay rows to the available width", () => {
		const rendered = fitOverlayRowContent("ok", 5);
		expect(rendered).toBe("ok   ");
		expect(visibleWidth(rendered)).toBe(5);
	});
});

describe("centerOverlayText", () => {
	it("centers text without exceeding width", () => {
		const rendered = centerOverlayText("── ↑ 스크롤됨 (Shift+Down) ──", 10);
		expect(visibleWidth(rendered)).toBe(10);
	});

	it("pads centered output when there is extra space", () => {
		const rendered = centerOverlayText("hint", 8);
		expect(rendered).toBe("  hint  ");
		expect(visibleWidth(rendered)).toBe(8);
	});
});
