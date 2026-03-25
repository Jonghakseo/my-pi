import { describe, expect, it } from "vitest";
import { SVG_STYLES } from "../generative-ui/svg-styles.js";

describe("SVG_STYLES", () => {
	it("is a non-empty string", () => {
		expect(typeof SVG_STYLES).toBe("string");
		expect(SVG_STYLES.length).toBeGreaterThan(0);
	});

	describe("CSS custom properties", () => {
		it("defines primary text color shorthand", () => {
			expect(SVG_STYLES).toContain("--p:");
		});

		it("defines secondary text color shorthand", () => {
			expect(SVG_STYLES).toContain("--s:");
		});

		it("defines tertiary text color shorthand", () => {
			expect(SVG_STYLES).toContain("--t:");
		});

		it("defines background secondary shorthand", () => {
			expect(SVG_STYLES).toContain("--bg2:");
		});

		it("defines border shorthand", () => {
			expect(SVG_STYLES).toContain("--b:");
		});

		it("defines full semantic color variables", () => {
			const vars = [
				"--color-text-primary",
				"--color-text-secondary",
				"--color-text-tertiary",
				"--color-text-info",
				"--color-text-danger",
				"--color-text-success",
				"--color-text-warning",
				"--color-background-primary",
				"--color-background-secondary",
				"--color-background-tertiary",
				"--color-background-info",
				"--color-background-danger",
				"--color-background-success",
				"--color-background-warning",
				"--color-border-primary",
				"--color-border-secondary",
				"--color-border-tertiary",
				"--color-border-info",
				"--color-border-danger",
				"--color-border-success",
				"--color-border-warning",
			];
			for (const v of vars) {
				expect(SVG_STYLES).toContain(v);
			}
		});

		it("defines font family variables", () => {
			expect(SVG_STYLES).toContain("--font-sans:");
			expect(SVG_STYLES).toContain("--font-serif:");
			expect(SVG_STYLES).toContain("--font-mono:");
		});

		it("defines border radius variables", () => {
			expect(SVG_STYLES).toContain("--border-radius-md:");
			expect(SVG_STYLES).toContain("--border-radius-lg:");
			expect(SVG_STYLES).toContain("--border-radius-xl:");
		});
	});

	describe("SVG text classes", () => {
		it("defines .t class (primary text 14px)", () => {
			expect(SVG_STYLES).toContain("svg .t");
			expect(SVG_STYLES).toContain("font-size: 14px");
		});

		it("defines .ts class (secondary text 12px)", () => {
			expect(SVG_STYLES).toContain("svg .ts");
			expect(SVG_STYLES).toContain("font-size: 12px");
		});

		it("defines .th class (heading text 14px 500)", () => {
			expect(SVG_STYLES).toContain("svg .th");
			expect(SVG_STYLES).toContain("font-weight: 500");
		});
	});

	describe("SVG shape classes", () => {
		it("defines .box class for neutral boxes", () => {
			expect(SVG_STYLES).toContain("svg .box");
		});

		it("defines .node class with cursor pointer", () => {
			expect(SVG_STYLES).toContain("svg .node");
			expect(SVG_STYLES).toContain("cursor: pointer");
		});

		it("defines .node hover effect", () => {
			expect(SVG_STYLES).toContain("svg .node:hover");
		});

		it("defines .arr class for arrows", () => {
			expect(SVG_STYLES).toContain("svg .arr");
			expect(SVG_STYLES).toContain("stroke-width: 1.5");
		});

		it("defines .leader class for leader lines", () => {
			expect(SVG_STYLES).toContain("svg .leader");
			expect(SVG_STYLES).toContain("stroke-dasharray:");
		});
	});

	describe("color ramp classes", () => {
		const ramps = ["purple", "teal", "coral", "pink", "gray", "blue", "green", "amber", "red"];

		for (const ramp of ramps) {
			it(`defines c-${ramp} class for rect/circle/ellipse`, () => {
				expect(SVG_STYLES).toContain(`svg .c-${ramp} > rect`);
				expect(SVG_STYLES).toContain(`svg .c-${ramp} > circle`);
				expect(SVG_STYLES).toContain(`svg .c-${ramp} > ellipse`);
			});

			it(`defines c-${ramp} text overrides`, () => {
				expect(SVG_STYLES).toContain(`svg .c-${ramp} > .th`);
				expect(SVG_STYLES).toContain(`svg .c-${ramp} > .ts`);
			});

			it(`defines c-${ramp} direct shape application`, () => {
				expect(SVG_STYLES).toContain(`svg rect.c-${ramp}`);
				expect(SVG_STYLES).toContain(`svg circle.c-${ramp}`);
				expect(SVG_STYLES).toContain(`svg ellipse.c-${ramp}`);
			});
		}

		it("has all 9 color ramps", () => {
			for (const ramp of ramps) {
				expect(SVG_STYLES).toContain(`.c-${ramp}`);
			}
		});
	});

	describe("pre-styled form elements", () => {
		it("styles button element", () => {
			expect(SVG_STYLES).toMatch(/button\s*\{/);
			expect(SVG_STYLES).toContain("cursor: pointer");
		});

		it("styles button hover state", () => {
			expect(SVG_STYLES).toContain("button:hover");
		});

		it("styles button active state", () => {
			expect(SVG_STYLES).toContain("button:active");
			expect(SVG_STYLES).toContain("scale(0.98)");
		});

		it("styles range input", () => {
			expect(SVG_STYLES).toContain('input[type="range"]');
		});

		it("styles range input thumb", () => {
			expect(SVG_STYLES).toContain("::-webkit-slider-thumb");
		});

		it("styles text inputs", () => {
			expect(SVG_STYLES).toContain('input[type="text"]');
			expect(SVG_STYLES).toContain('input[type="number"]');
		});

		it("styles textarea and select", () => {
			expect(SVG_STYLES).toContain("textarea");
			expect(SVG_STYLES).toContain("select");
		});

		it("includes focus styles with box-shadow", () => {
			expect(SVG_STYLES).toContain(":focus");
			expect(SVG_STYLES).toContain("box-shadow:");
		});
	});
});
