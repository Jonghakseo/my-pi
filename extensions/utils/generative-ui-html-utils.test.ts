import { describe, expect, it } from "vitest";
import { escapeJS, shellHTML, wrapHTML } from "../generative-ui/html-utils.js";

// ─── escapeJS ────────────────────────────────────────────────────────────────

describe("escapeJS", () => {
	it("escapes backslashes", () => {
		expect(escapeJS("a\\b")).toBe("a\\\\b");
	});

	it("escapes single quotes", () => {
		expect(escapeJS("it's")).toBe("it\\'s");
	});

	it("escapes newlines", () => {
		expect(escapeJS("line1\nline2")).toBe("line1\\nline2");
	});

	it("escapes carriage returns", () => {
		expect(escapeJS("line1\rline2")).toBe("line1\\rline2");
	});

	it("escapes </script> tags", () => {
		expect(escapeJS("</script>")).toBe("<\\/script>");
	});

	it("escapes </script> case-insensitively (lowercased in replacement)", () => {
		// The regex uses /gi so it matches any case, but replace preserves matched case for the non-captured part
		const result = escapeJS("</Script>");
		expect(result).toContain("<\\/");
		expect(result).not.toContain("</Script>");
	});

	it("escapes </SCRIPT> variant", () => {
		const result = escapeJS("</SCRIPT>");
		expect(result).toContain("<\\/");
		expect(result).not.toContain("</SCRIPT>");
	});

	it("handles multiple escapes in one string", () => {
		const input = "it's a\\path\nwith </script> tag";
		const result = escapeJS(input);
		expect(result).toBe("it\\'s a\\\\path\\nwith <\\/script> tag");
	});

	it("returns empty string for empty input", () => {
		expect(escapeJS("")).toBe("");
	});

	it("does not touch safe characters", () => {
		const safe = "Hello, world! 123 <div>abc</div>";
		expect(escapeJS(safe)).toBe(safe);
	});

	it("handles consecutive backslashes", () => {
		expect(escapeJS("\\\\")).toBe("\\\\\\\\");
	});

	it("applies escapes in correct order (backslash before quote)", () => {
		// Input: \' → should become \\' (backslash escaped first, then quote)
		expect(escapeJS("\\'")).toBe("\\\\\\'");
	});

	it("handles mixed CRLF line endings", () => {
		expect(escapeJS("a\r\nb")).toBe("a\\r\\nb");
	});
});

// ─── shellHTML ───────────────────────────────────────────────────────────────

describe("shellHTML", () => {
	it("returns a valid HTML document", () => {
		const html = shellHTML();
		expect(html).toContain("<!DOCTYPE html>");
		expect(html).toContain("<html>");
		expect(html).toContain("</html>");
	});

	it("includes charset meta", () => {
		expect(shellHTML()).toContain('<meta charset="utf-8">');
	});

	it("includes viewport meta", () => {
		expect(shellHTML()).toContain("width=device-width");
	});

	it("includes root container div", () => {
		expect(shellHTML()).toContain('<div id="root"></div>');
	});

	it("includes morphdom CDN script", () => {
		expect(shellHTML()).toContain("cdn.jsdelivr.net/npm/morphdom");
	});

	it("includes _setContent function", () => {
		expect(shellHTML()).toContain("window._setContent");
	});

	it("includes _morphReady flag", () => {
		expect(shellHTML()).toContain("window._morphReady = false");
	});

	it("includes _pending queue", () => {
		expect(shellHTML()).toContain("window._pending = null");
	});

	it("defers content application until morphdom is ready", () => {
		const html = shellHTML();
		expect(html).toContain("window._applyPending = function()");
		expect(html).toContain("if (!window._morphReady || !window._pending) return;");
		expect(html).toContain('onload="window._morphReady=true;window._applyPending();"');
	});

	it("includes _fadeIn animation keyframes", () => {
		expect(shellHTML()).toContain("@keyframes _fadeIn");
	});

	it("includes dark background style", () => {
		expect(shellHTML()).toContain("background:#1a1a1a");
	});

	it("includes SVG_STYLES (CSS variables)", () => {
		const html = shellHTML();
		expect(html).toContain("--color-text-primary");
		expect(html).toContain("--color-background-primary");
	});

	it("returns consistent output across calls", () => {
		expect(shellHTML()).toBe(shellHTML());
	});

	it("does not include legacy script re-execution helpers", () => {
		const html = shellHTML();
		expect(html).not.toContain("window._runScripts");
		expect(html).not.toContain("window._pendingRunScripts");
	});
});

// ─── wrapHTML ────────────────────────────────────────────────────────────────

describe("wrapHTML", () => {
	describe("HTML mode (default)", () => {
		it("wraps code in a full HTML document", () => {
			const result = wrapHTML("<h1>Hello</h1>");
			expect(result).toContain("<!DOCTYPE html>");
			expect(result).toContain("<html>");
			expect(result).toContain("</html>");
		});

		it("includes the code in body before keyboard helpers", () => {
			const code = '<div class="test">content</div>';
			const result = wrapHTML(code);
			expect(result).toContain(`<body>${code}`);
			expect(result).toContain("document.execCommand");
		});

		it("includes charset meta", () => {
			expect(wrapHTML("x")).toContain('<meta charset="utf-8">');
		});

		it("includes viewport meta", () => {
			expect(wrapHTML("x")).toContain("width=device-width");
		});

		it("includes box-sizing reset", () => {
			expect(wrapHTML("x")).toContain("box-sizing:border-box");
		});

		it("includes dark background", () => {
			expect(wrapHTML("x")).toContain("background:#1a1a1a");
		});

		it("includes SVG_STYLES", () => {
			const result = wrapHTML("x");
			expect(result).toContain("--color-text-primary");
		});

		it("does NOT include flexbox centering", () => {
			expect(wrapHTML("x")).not.toContain("display:flex");
		});
	});

	describe("SVG mode (isSVG=true)", () => {
		it("wraps SVG code in a full HTML document", () => {
			const svg = '<svg viewBox="0 0 100 100"><circle cx="50" cy="50" r="40"/></svg>';
			const result = wrapHTML(svg, true);
			expect(result).toContain("<!DOCTYPE html>");
			expect(result).toContain(svg);
		});

		it("includes flexbox centering for SVG", () => {
			const result = wrapHTML("<svg></svg>", true);
			expect(result).toContain("display:flex");
			expect(result).toContain("align-items:center");
			expect(result).toContain("justify-content:center");
		});

		it("includes min-height:100vh for SVG", () => {
			expect(wrapHTML("<svg></svg>", true)).toContain("min-height:100vh");
		});

		it("does NOT include viewport meta", () => {
			expect(wrapHTML("<svg></svg>", true)).not.toContain("viewport");
		});

		it("includes SVG_STYLES", () => {
			expect(wrapHTML("<svg></svg>", true)).toContain("--color-text-primary");
		});

		it("includes dark background", () => {
			expect(wrapHTML("<svg></svg>", true)).toContain("background:#1a1a1a");
		});
	});

	describe("edge cases", () => {
		it("handles empty string code", () => {
			const result = wrapHTML("");
			expect(result).toContain("<body><script>");
			expect(result).toContain("document.execCommand");
		});

		it("handles code with special characters", () => {
			const code = '<div data-x="a&b">text</div>';
			expect(wrapHTML(code)).toContain(code);
		});

		it("isSVG defaults to false", () => {
			const htmlResult = wrapHTML("x");
			const explicitResult = wrapHTML("x", false);
			expect(htmlResult).toBe(explicitResult);
		});
	});
});
