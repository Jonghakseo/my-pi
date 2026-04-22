import { visibleWidth } from "@mariozechner/pi-tui";
import { describe, expect, it } from "vitest";
import { buildSettingsPanelTitle } from "../pi-supervisor/src/ui/settings-panel.ts";

const theme = {
	fg: (_color: string, text: string) => text,
	bold: (text: string) => text,
};

describe("buildSettingsPanelTitle", () => {
	it("truncates the active title to the terminal width", () => {
		const rendered = buildSettingsPanelTitle(theme, true, 12);
		expect(visibleWidth(rendered)).toBeLessThanOrEqual(12);
	});

	it("truncates the inactive title to the terminal width", () => {
		const rendered = buildSettingsPanelTitle(theme, false, 8);
		expect(visibleWidth(rendered)).toBeLessThanOrEqual(8);
	});
});
