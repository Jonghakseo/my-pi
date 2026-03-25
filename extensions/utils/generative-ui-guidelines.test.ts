import { describe, expect, it } from "vitest";
import { AVAILABLE_MODULES, getGuidelines } from "../generative-ui/guidelines.js";

// ─── AVAILABLE_MODULES ───────────────────────────────────────────────────────

describe("AVAILABLE_MODULES", () => {
	it("contains all 5 expected modules", () => {
		expect(AVAILABLE_MODULES).toEqual(expect.arrayContaining(["art", "mockup", "interactive", "chart", "diagram"]));
		expect(AVAILABLE_MODULES).toHaveLength(5);
	});

	it("is a plain string array", () => {
		for (const mod of AVAILABLE_MODULES) {
			expect(typeof mod).toBe("string");
		}
	});
});

// ─── getGuidelines ──────────────────────────────────────────────────────────

describe("getGuidelines", () => {
	describe("core content", () => {
		it("always includes core guidelines even with empty modules", () => {
			const result = getGuidelines([]);
			expect(result).toContain("Visual Creation Suite");
			expect(result).toContain("Core Design System");
		});

		it("ends with a trailing newline", () => {
			expect(getGuidelines([])).toMatch(/\n$/);
		});
	});

	describe("module-specific content", () => {
		it("includes art & illustration section for 'art'", () => {
			const result = getGuidelines(["art"]);
			expect(result).toContain("Art and illustration");
			expect(result).toContain("SVG setup");
		});

		it("includes UI components section for 'mockup'", () => {
			const result = getGuidelines(["mockup"]);
			expect(result).toContain("UI components");
			expect(result).toContain("Color palette");
		});

		it("includes UI components section for 'interactive'", () => {
			const result = getGuidelines(["interactive"]);
			expect(result).toContain("UI components");
			expect(result).toContain("Color palette");
		});

		it("includes Chart.js section for 'chart'", () => {
			const result = getGuidelines(["chart"]);
			expect(result).toContain("Charts (Chart.js)");
			expect(result).toContain("UI components");
			expect(result).toContain("Color palette");
		});

		it("includes diagram types section for 'diagram'", () => {
			const result = getGuidelines(["diagram"]);
			expect(result).toContain("Diagram types");
			expect(result).toContain("SVG setup");
			expect(result).toContain("Color palette");
		});
	});

	describe("deduplication", () => {
		it("does not duplicate shared sections across modules", () => {
			// mockup and interactive both include UI_COMPONENTS and COLOR_PALETTE
			const result = getGuidelines(["mockup", "interactive"]);
			const colorPaletteCount = (result.match(/## Color palette/g) || []).length;
			const uiComponentsCount = (result.match(/## UI components/g) || []).length;
			expect(colorPaletteCount).toBe(1);
			expect(uiComponentsCount).toBe(1);
		});

		it("does not duplicate SVG setup across art and diagram", () => {
			const result = getGuidelines(["art", "diagram"]);
			const svgSetupCount = (result.match(/## SVG setup/g) || []).length;
			expect(svgSetupCount).toBe(1);
		});

		it("does not duplicate color palette across chart and diagram", () => {
			const result = getGuidelines(["chart", "diagram"]);
			const colorPaletteCount = (result.match(/## Color palette/g) || []).length;
			expect(colorPaletteCount).toBe(1);
		});
	});

	describe("all modules combined", () => {
		it("includes all sections when all modules requested", () => {
			const result = getGuidelines(AVAILABLE_MODULES);
			expect(result).toContain("Art and illustration");
			expect(result).toContain("UI components");
			expect(result).toContain("Charts (Chart.js)");
			expect(result).toContain("Diagram types");
			expect(result).toContain("SVG setup");
			expect(result).toContain("Color palette");
		});

		it("produces longer output than core alone", () => {
			const coreOnly = getGuidelines([]);
			const allModules = getGuidelines(AVAILABLE_MODULES);
			expect(allModules.length).toBeGreaterThan(coreOnly.length);
		});
	});

	describe("edge cases", () => {
		it("ignores unknown module names", () => {
			const known = getGuidelines([]);
			const withUnknown = getGuidelines(["nonexistent_module"]);
			expect(withUnknown).toBe(known);
		});

		it("handles duplicate module names in input", () => {
			const single = getGuidelines(["chart"]);
			const double = getGuidelines(["chart", "chart"]);
			expect(double).toBe(single);
		});

		it("returns consistent output for same input", () => {
			const a = getGuidelines(["diagram", "art"]);
			const b = getGuidelines(["diagram", "art"]);
			expect(a).toBe(b);
		});

		it("order of modules affects section order", () => {
			const artFirst = getGuidelines(["art", "chart"]);
			const chartFirst = getGuidelines(["chart", "art"]);
			// Both should contain the same content, but section order may differ
			// art first → SVG_SETUP comes before UI_COMPONENTS
			// chart first → UI_COMPONENTS comes before SVG_SETUP
			const artSvgIdx = artFirst.indexOf("## SVG setup");
			const artUiIdx = artFirst.indexOf("## UI components");
			const chartSvgIdx = chartFirst.indexOf("## SVG setup");
			const chartUiIdx = chartFirst.indexOf("## UI components");
			// art: SVG setup before UI components
			expect(artSvgIdx).toBeLessThan(artUiIdx);
			// chart: UI components before SVG setup
			expect(chartUiIdx).toBeLessThan(chartSvgIdx);
		});
	});
});
