/**
 * Tests for TruncatedText and width-aware tool rendering.
 *
 * Validates the fix for: "Rendered line exceeds terminal width"
 * — all tool renderResult methods must return components whose render(width)
 *   never produces lines wider than the given width.
 */
import { visibleWidth } from "@mariozechner/pi-tui";
import { describe, expect, it } from "vitest";
import overrideBuiltinTools from "../override-builtin-tools.ts";

// ── Test helpers ───────────────────────────────────────────────────────────

type TestTheme = {
	fg: (color: string, text: string) => string;
	bold: (text: string) => string;
};

/** Identity theme — no ANSI codes, simplifies assertions. */
function plainTheme(): TestTheme {
	return {
		fg: (_color, text) => text,
		bold: (text) => text,
	};
}

/** Theme that wraps text in real ANSI color codes (like the actual runtime). */
function ansiTheme(): TestTheme {
	return {
		fg: (_color, text) => `\x1b[38;2;213;188;255m${text}\x1b[39m`,
		bold: (text) => `\x1b[1m${text}\x1b[22m`,
	};
}

interface WidthAwareComponent {
	render(width: number): string[];
	invalidate?(): void;
}

interface TextComponent {
	text?: string;
}

type RenderResult = WidthAwareComponent | TextComponent;

interface RegisteredTool {
	name: string;
	renderCall?: (args: Record<string, unknown>, theme: TestTheme) => RenderResult;
	renderResult?: (
		result: { content: Array<{ type: string; text?: string }>; details?: unknown },
		options: { expanded: boolean; isPartial?: boolean },
		theme: TestTheme,
	) => RenderResult;
}

function registerAllTools(): Map<string, RegisteredTool> {
	const tools = new Map<string, RegisteredTool>();
	overrideBuiltinTools({
		on: () => {},
		registerTool: (tool: RegisteredTool) => {
			tools.set(tool.name, tool);
		},
	} as never);
	return tools;
}

function getTool(name: string): RegisteredTool {
	const tools = registerAllTools();
	const tool = tools.get(name);
	if (!tool) throw new Error(`${name} tool not registered`);
	return tool;
}

function isWidthAware(obj: RenderResult): obj is WidthAwareComponent {
	return typeof (obj as WidthAwareComponent).render === "function";
}

/** Render a component at the given width and return lines. */
function renderAt(component: RenderResult, width: number): string[] {
	if (isWidthAware(component)) return component.render(width);
	const text = (component as TextComponent).text ?? "";
	return text.split("\n");
}

/** Assert every rendered line fits within the given width. */
function assertAllLinesFit(component: RenderResult, width: number, label = "") {
	const lines = renderAt(component, width);
	for (let i = 0; i < lines.length; i++) {
		const vw = visibleWidth(lines[i]);
		expect(vw, `${label}line ${i} visible width ${vw} > ${width}: "${lines[i]}"`).toBeLessThanOrEqual(width);
	}
	return lines;
}

// ── Fixtures ───────────────────────────────────────────────────────────────

/** A line that is definitely wider than any reasonable terminal. */
const LONG_ASCII = "x".repeat(300);

/** Long path — mimics the crash scenario (long ESLint file paths). */
const LONG_PATH =
	"/Users/creatrip/product/.worktrees/temp/frontend/apps/web/domain/travel/subdomain/spot/detail/subdomain/generalSpot/generalSpotDetailOption/SpotDetailSelectedOptionItemDesktopBottomSheet.tsx";

/** Multi-line bash output with some very long lines (like the crash). */
const LINT_OUTPUT = [
	`${LONG_PATH}`,
	"  707:5   warning  [크리에이트립 ESLint 규칙]",
	`translations 필드(SpotTrans 타입)에 id가 누락되었습니다.`,
	`Apollo Client 캐시 정규화를 위해 id 필드를 추가하세요                      @creatrip/graphql-require-id-field`,
	"",
	`${LONG_PATH.replace("Desktop", "MobileAndTablet")}`,
	"  55:9  warning  [크리에이트립 ESLint 규칙]",
	`작성된 fragment 인자의 올바른 이름은 spot 입니다.`,
	`fragment 네이밍 규칙은 \`\${Component/function 이름}_\${props/argument 이름}\`입니다  @creatrip/fragment-name`,
	"",
	"✖ 8 problems (0 errors, 8 warnings)",
].join("\n");

/** Exact crash-shaped git pull output captured from pi-crash.log. */
const GIT_PULL_OUTPUT = [
	"From https://github.com/creatrip/product",
	"   64378a1345d..e0681ce2639  development -> origin/development",
	"   199cc0ced91..ca69ab49782  feature/admin-save-shortcut -> origin/feature/admin-save-shortcut",
	"   b76f6249415..578fade20db  fix/open-date-notification-error-boundary -> origin/fix/open-date-notification-error-boundary",
	"Already up to date.",
].join("\n");

/** CJK-heavy text (Korean) — each char is 2 columns wide. */
const CJK_LONG = "한글테스트문자열".repeat(30); // 8 * 30 = 240 chars → 480 columns

/** Content with mixed ASCII + CJK. */
const MIXED_CONTENT = `const msg = "안녕하세요 이것은 매우 긴 메시지입니다 ${"가나다라마바사".repeat(20)}";\nconsole.log(msg);`;

// ── TruncatedText (tested via tool renderResult) ───────────────────────────

describe("TruncatedText via tool renderResult", () => {
	const WIDTHS = [40, 80, 127, 200];

	describe("bash tool", () => {
		const bash = getTool("bash");

		it("expanded renderResult returns a width-aware component", () => {
			const result = bash.renderResult!(
				{ content: [{ type: "text", text: "hello world" }] },
				{ expanded: true },
				plainTheme(),
			);
			expect(isWidthAware(result)).toBe(true);
		});

		it("collapsed renderResult returns a width-aware component", () => {
			const result = bash.renderResult!(
				{ content: [{ type: "text", text: "hello world" }] },
				{ expanded: false },
				plainTheme(),
			);
			expect(isWidthAware(result)).toBe(true);
		});

		for (const width of WIDTHS) {
			it(`expanded: all lines fit within width=${width} (long ASCII)`, () => {
				const result = bash.renderResult!(
					{ content: [{ type: "text", text: LONG_ASCII }] },
					{ expanded: true },
					plainTheme(),
				);
				assertAllLinesFit(result, width, `bash expanded w=${width} `);
			});

			it(`expanded: all lines fit within width=${width} (lint output)`, () => {
				const result = bash.renderResult!(
					{ content: [{ type: "text", text: LINT_OUTPUT }] },
					{ expanded: true },
					plainTheme(),
				);
				assertAllLinesFit(result, width, `bash expanded lint w=${width} `);
			});

			it(`collapsed: all lines fit within width=${width} (lint output)`, () => {
				const result = bash.renderResult!(
					{ content: [{ type: "text", text: LINT_OUTPUT }] },
					{ expanded: false },
					plainTheme(),
				);
				assertAllLinesFit(result, width, `bash collapsed lint w=${width} `);
			});
		}

		it("expanded: truncates CJK lines correctly", () => {
			const result = bash.renderResult!(
				{ content: [{ type: "text", text: CJK_LONG }] },
				{ expanded: true },
				plainTheme(),
			);
			assertAllLinesFit(result, 80, "bash CJK ");
		});

		it("expanded: handles ANSI-colored long lines", () => {
			const result = bash.renderResult!(
				{ content: [{ type: "text", text: LINT_OUTPUT }] },
				{ expanded: true },
				ansiTheme(),
			);
			assertAllLinesFit(result, 127, "bash ANSI ");
		});

		it("collapsed: handles ANSI-colored long lines", () => {
			const result = bash.renderResult!(
				{ content: [{ type: "text", text: LINT_OUTPUT }] },
				{ expanded: false },
				ansiTheme(),
			);
			assertAllLinesFit(result, 127, "bash collapsed ANSI ");
		});

		it("expanded: reproduces the narrow split-panel git pull crash shape safely at width=75", () => {
			const result = bash.renderResult!(
				{ content: [{ type: "text", text: GIT_PULL_OUTPUT }] },
				{ expanded: true },
				ansiTheme(),
			);
			const lines = assertAllLinesFit(result, 75, "bash git-pull crash repro ");
			expect(lines.join("\n")).toContain("fix/open-date-notification-error-boundary");
		});

		it("expanded: preserves content (does not lose text)", () => {
			const result = bash.renderResult!(
				{ content: [{ type: "text", text: "line1\nline2\nline3" }] },
				{ expanded: true },
				plainTheme(),
			);
			const lines = renderAt(result, 200);
			const joined = lines.join("\n");
			expect(joined).toContain("line1");
			expect(joined).toContain("line2");
			expect(joined).toContain("line3");
		});

		it("collapsed: shows preview with remaining count", () => {
			const manyLines = Array.from({ length: 20 }, (_, i) => `line-${i}`).join("\n");
			const result = bash.renderResult!(
				{ content: [{ type: "text", text: manyLines }] },
				{ expanded: false },
				plainTheme(),
			);
			const lines = renderAt(result, 200);
			const joined = lines.join("\n");
			expect(joined).toContain("line-0");
			expect(joined).toContain("+");
		});

		it("empty content returns empty", () => {
			const result = bash.renderResult!(
				{ content: [{ type: "text", text: "" }] },
				{ expanded: true },
				plainTheme(),
			);
			const lines = renderAt(result, 80);
			expect(lines.every((l) => l.trim() === "")).toBe(true);
		});

		it("no text content renders to empty", () => {
			const result = bash.renderResult!({ content: [] }, { expanded: true }, plainTheme());
			const lines = renderAt(result, 200);
			expect(lines.every((l) => l === "")).toBe(true);
		});
	});

	describe("read tool", () => {
		const read = getTool("read");

		it("expanded renderResult returns a width-aware component", () => {
			const result = read.renderResult!(
				{ content: [{ type: "text", text: "file contents" }] },
				{ expanded: true },
				plainTheme(),
			);
			expect(isWidthAware(result)).toBe(true);
		});

		it("collapsed renderResult returns a width-aware component", () => {
			const result = read.renderResult!(
				{ content: [{ type: "text", text: "file contents" }] },
				{ expanded: false },
				plainTheme(),
			);
			expect(isWidthAware(result)).toBe(true);
		});

		for (const width of WIDTHS) {
			it(`expanded: all lines fit within width=${width} (long path content)`, () => {
				const content = `${LONG_PATH}\n${"=".repeat(300)}\nsome content`;
				const result = read.renderResult!(
					{ content: [{ type: "text", text: content }] },
					{ expanded: true },
					plainTheme(),
				);
				assertAllLinesFit(result, width, `read expanded w=${width} `);
			});

			it(`collapsed: all lines fit within width=${width}`, () => {
				const content = `${LONG_PATH}\n${"=".repeat(300)}\nsome content`;
				const result = read.renderResult!(
					{ content: [{ type: "text", text: content }] },
					{ expanded: false },
					plainTheme(),
				);
				assertAllLinesFit(result, width, `read collapsed w=${width} `);
			});
		}

		it("expanded: handles mixed ASCII + CJK", () => {
			const result = read.renderResult!(
				{ content: [{ type: "text", text: MIXED_CONTENT }] },
				{ expanded: true },
				plainTheme(),
			);
			assertAllLinesFit(result, 80, "read mixed ");
		});
	});

	describe("write tool", () => {
		const write = getTool("write");

		it("collapsed renderResult returns a width-aware component", () => {
			const result = write.renderResult!(
				{
					content: [{ type: "text", text: "OK" }],
					details: { path: "test.ts", lineCount: 1, byteCount: 4, preview: "test" },
				},
				{ expanded: false },
				plainTheme(),
			);
			expect(isWidthAware(result)).toBe(true);
		});

		it("expanded renderResult returns a width-aware component", () => {
			const result = write.renderResult!(
				{
					content: [{ type: "text", text: "Successfully wrote file." }],
					details: { path: "test.ts", lineCount: 3, byteCount: 100, preview: "a\nb\nc" },
				},
				{ expanded: true },
				plainTheme(),
			);
			expect(isWidthAware(result)).toBe(true);
		});

		for (const width of WIDTHS) {
			it(`expanded: all lines fit within width=${width} (long content)`, () => {
				const preview = `const x = "${LONG_ASCII}";\n${CJK_LONG}`;
				const result = write.renderResult!(
					{
						content: [{ type: "text", text: "Successfully wrote file." }],
						details: { path: "test.ts", lineCount: 2, byteCount: preview.length, preview },
					},
					{ expanded: true },
					plainTheme(),
				);
				assertAllLinesFit(result, width, `write expanded w=${width} `);
			});
		}

		it("expanded: includes preview and summary", () => {
			const result = write.renderResult!(
				{
					content: [{ type: "text", text: "Successfully wrote file." }],
					details: { path: "test.ts", lineCount: 3, byteCount: 15, preview: "first\nsecond\nthird" },
				},
				{ expanded: true },
				plainTheme(),
			);
			const lines = renderAt(result, 200);
			const joined = lines.join("\n");
			expect(joined).toContain("first");
			expect(joined).toContain("second");
			expect(joined).toContain("third");
			expect(joined).toContain("Successfully wrote file.");
		});

		it("collapsed: summary only, no preview content", () => {
			const result = write.renderResult!(
				{
					content: [],
					details: { path: "test.ts", lineCount: 3, byteCount: 15, preview: "first\nsecond\nthird" },
				},
				{ expanded: false },
				plainTheme(),
			);
			const lines = renderAt(result, 200);
			const joined = lines.join("\n");
			expect(joined).not.toContain("first");
		});

		it("expanded with ANSI theme: all lines fit", () => {
			const preview = `${LONG_PATH}\n${"=".repeat(300)}`;
			const result = write.renderResult!(
				{
					content: [{ type: "text", text: "OK" }],
					details: { path: "test.ts", lineCount: 2, byteCount: preview.length, preview },
				},
				{ expanded: true },
				ansiTheme(),
			);
			assertAllLinesFit(result, 127, "write ANSI ");
		});
	});

	describe("find tool", () => {
		const find = getTool("find");

		it("expanded renderResult returns a width-aware component", () => {
			const result = find.renderResult!(
				{ content: [{ type: "text", text: "a.ts\nb.ts" }] },
				{ expanded: true },
				plainTheme(),
			);
			expect(isWidthAware(result)).toBe(true);
		});

		it("collapsed renderResult returns Text (short summary)", () => {
			const result = find.renderResult!(
				{ content: [{ type: "text", text: "a.ts\nb.ts" }] },
				{ expanded: false },
				plainTheme(),
			);
			// Collapsed find returns a short summary like "→ 2 files"
			// which is already safe, so it can be either type
			const lines = renderAt(result, 127);
			for (const line of lines) {
				expect(visibleWidth(line)).toBeLessThanOrEqual(127);
			}
		});

		for (const width of WIDTHS) {
			it(`expanded: all lines fit within width=${width} (long paths)`, () => {
				const paths = Array.from({ length: 10 }, (_, i) => `${LONG_PATH.replace(".tsx", `${i}.tsx`)}`).join("\n");
				const result = find.renderResult!(
					{ content: [{ type: "text", text: paths }] },
					{ expanded: true },
					plainTheme(),
				);
				assertAllLinesFit(result, width, `find expanded w=${width} `);
			});
		}
	});

	describe("grep tool", () => {
		const grep = getTool("grep");

		it("expanded renderResult returns a width-aware component", () => {
			const result = grep.renderResult!(
				{ content: [{ type: "text", text: "file.ts:10:match" }] },
				{ expanded: true },
				plainTheme(),
			);
			expect(isWidthAware(result)).toBe(true);
		});

		for (const width of WIDTHS) {
			it(`expanded: all lines fit within width=${width}`, () => {
				const lines = Array.from({ length: 5 }, (_, i) => `${LONG_PATH}:${i}:${LONG_ASCII}`).join("\n");
				const result = grep.renderResult!(
					{ content: [{ type: "text", text: lines }] },
					{ expanded: true },
					plainTheme(),
				);
				assertAllLinesFit(result, width, `grep expanded w=${width} `);
			});
		}
	});

	describe("ls tool", () => {
		const ls = getTool("ls");

		it("expanded renderResult returns a width-aware component", () => {
			const result = ls.renderResult!(
				{ content: [{ type: "text", text: "file1.ts  4KB\nfile2.ts  8KB" }] },
				{ expanded: true },
				plainTheme(),
			);
			expect(isWidthAware(result)).toBe(true);
		});

		for (const width of WIDTHS) {
			it(`expanded: all lines fit within width=${width}`, () => {
				const entries = Array.from({ length: 10 }, (_, i) => `${"deep/nested/".repeat(20)}file${i}.ts  4KB`).join(
					"\n",
				);
				const result = ls.renderResult!(
					{ content: [{ type: "text", text: entries }] },
					{ expanded: true },
					plainTheme(),
				);
				assertAllLinesFit(result, width, `ls expanded w=${width} `);
			});
		}
	});
});

// ── Caching & invalidation ─────────────────────────────────────────────────

describe("TruncatedText caching behavior", () => {
	const bash = getTool("bash");

	it("render() at same width returns identical array reference (cached)", () => {
		const result = bash.renderResult!(
			{ content: [{ type: "text", text: LINT_OUTPUT }] },
			{ expanded: true },
			plainTheme(),
		);
		if (!isWidthAware(result)) throw new Error("expected width-aware");

		const first = result.render(100);
		const second = result.render(100);
		expect(first).toBe(second); // same reference
	});

	it("render() at different width returns different result", () => {
		const result = bash.renderResult!(
			{ content: [{ type: "text", text: LONG_ASCII }] },
			{ expanded: true },
			plainTheme(),
		);
		if (!isWidthAware(result)) throw new Error("expected width-aware");

		const narrow = result.render(40);
		const wide = result.render(200);
		expect(narrow).not.toBe(wide);

		// Narrow lines should be shorter
		for (const line of narrow) {
			expect(visibleWidth(line)).toBeLessThanOrEqual(40);
		}
		for (const line of wide) {
			expect(visibleWidth(line)).toBeLessThanOrEqual(200);
		}
	});

	it("invalidate() clears cache so next render recomputes", () => {
		const result = bash.renderResult!(
			{ content: [{ type: "text", text: "short" }] },
			{ expanded: true },
			plainTheme(),
		);
		if (!isWidthAware(result)) throw new Error("expected width-aware");

		const first = result.render(100);
		result.invalidate!();
		const second = result.render(100);
		expect(first).not.toBe(second); // different reference after invalidation
		expect(first).toEqual(second); // but same content
	});
});

// ── Exact crash scenario reproduction ──────────────────────────────────────

describe("crash scenario: pnpm lint output at terminal width 127", () => {
	const TERMINAL_WIDTH = 127;

	/** Exact pattern from pi-crash.log — lint output with long file paths. */
	const CRASH_OUTPUT = [
		"/Users/creatrip/product/.worktrees/temp-20260308-085007/frontend/apps/web/domain/travel/subdomain/spot/detail/subdomain/generalSpot/GeneralSpotDetailContents.tsx",
		"  707:5   warning  [크리에이트립 ESLint 규칙]",
		"translations 필드(SpotTrans 타입)에 id가 누락되었습니다.",
		"Apollo Client 캐시 정규화를 위해 id 필드를 추가하세요                      @creatrip/graphql-require-id-field",
		"",
		"/Users/creatrip/product/.worktrees/temp-20260308-085007/frontend/apps/web/domain/travel/subdomain/spot/detail/subdomain/generalSpot/generalSpotDetailOption/SpotDetailSelectedOptionItemDesktopBottomSheet.tsx",
		"  55:9  warning  [크리에이트립 Eslint 규칙]",
		"작성된 fragment 인자의 올바른 이름은 spot 입니다.",
		"fragment 네이밍 규칙은 `${Component/function 이름}_${props/argument 이름}`입니다  @creatrip/fragment-name",
		"",
		"/Users/creatrip/product/.worktrees/temp-20260308-085007/frontend/apps/web/domain/travel/subdomain/spot/detail/subdomain/generalSpot/generalSpotDetailOption/SpotDetailSelectedOptionItemMobileAndTabletBottomSheet.tsx",
		"  92:9  warning  [크리에이트립 Eslint 규칙]",
		"작성된 fragment 인자의 올바른 이름은 spot 입니다.",
		"fragment 네이밍 규칙은 `${Component/function 이름}_${props/argument 이름}`입니다  @creatrip/fragment-name",
		"",
		"✖ 8 problems (0 errors, 8 warnings)",
	].join("\n");

	it("bash expanded: no line exceeds terminal width 127 (plain theme)", () => {
		const bash = getTool("bash");
		const result = bash.renderResult!(
			{ content: [{ type: "text", text: CRASH_OUTPUT }] },
			{ expanded: true },
			plainTheme(),
		);
		assertAllLinesFit(result, TERMINAL_WIDTH, "crash-repro plain ");
	});

	it("bash expanded: no line exceeds terminal width 127 (ANSI theme)", () => {
		const bash = getTool("bash");
		const result = bash.renderResult!(
			{ content: [{ type: "text", text: CRASH_OUTPUT }] },
			{ expanded: true },
			ansiTheme(),
		);
		assertAllLinesFit(result, TERMINAL_WIDTH, "crash-repro ANSI ");
	});

	it("bash collapsed: no line exceeds terminal width 127 (ANSI theme)", () => {
		const bash = getTool("bash");
		const result = bash.renderResult!(
			{ content: [{ type: "text", text: CRASH_OUTPUT }] },
			{ expanded: false },
			ansiTheme(),
		);
		assertAllLinesFit(result, TERMINAL_WIDTH, "crash-repro collapsed ANSI ");
	});

	it("lines are actually truncated (not just short to begin with)", () => {
		const bash = getTool("bash");
		const result = bash.renderResult!(
			{ content: [{ type: "text", text: CRASH_OUTPUT }] },
			{ expanded: true },
			plainTheme(),
		);
		if (!isWidthAware(result)) throw new Error("expected width-aware");

		// At very wide width, some lines should be longer than 127
		const wideLines = result.render(500);
		const hasLongLine = wideLines.some((l) => visibleWidth(l) > TERMINAL_WIDTH);
		expect(hasLongLine).toBe(true);

		// At terminal width, none should exceed
		const narrowLines = result.render(TERMINAL_WIDTH);
		const allFit = narrowLines.every((l) => visibleWidth(l) <= TERMINAL_WIDTH);
		expect(allFit).toBe(true);
	});
});

// ── Edge cases ─────────────────────────────────────────────────────────────

describe("edge cases", () => {
	const bash = getTool("bash");

	it("width=1: does not crash, all lines fit", () => {
		const result = bash.renderResult!(
			{ content: [{ type: "text", text: "hello\nworld" }] },
			{ expanded: true },
			plainTheme(),
		);
		assertAllLinesFit(result, 1, "width=1 ");
	});

	it("single very long line (no newlines)", () => {
		const result = bash.renderResult!(
			{ content: [{ type: "text", text: "A".repeat(1000) }] },
			{ expanded: true },
			plainTheme(),
		);
		assertAllLinesFit(result, 80, "single long ");
	});

	it("empty lines are preserved as blank visual rows", () => {
		const result = bash.renderResult!(
			{ content: [{ type: "text", text: "a\n\nb\n\nc" }] },
			{ expanded: true },
			plainTheme(),
		);
		const lines = renderAt(result, 200);
		const blankRows = lines.filter((l) => l.trim() === "").length;
		expect(blankRows).toBeGreaterThanOrEqual(2);
	});

	it("mixed CJK + ASCII + ANSI within same line", () => {
		const text = `파일: ${"path/to/deep/nested/".repeat(10)}component.tsx 에서 에러 발생`;
		const result = bash.renderResult!(
			{ content: [{ type: "text", text }] },
			{ expanded: true },
			ansiTheme(),
		);
		assertAllLinesFit(result, 80, "mixed CJK+ASCII+ANSI ");
	});

	it("trailing whitespace in long lines is truncated", () => {
		const text = `short text${"  ".repeat(200)}`;
		const result = bash.renderResult!(
			{ content: [{ type: "text", text }] },
			{ expanded: true },
			plainTheme(),
		);
		assertAllLinesFit(result, 80, "trailing spaces ");
	});

	it("tab characters are handled without overflow", () => {
		const text = `${"	".repeat(50)}value`;
		const result = bash.renderResult!(
			{ content: [{ type: "text", text }] },
			{ expanded: true },
			plainTheme(),
		);
		assertAllLinesFit(result, 80, "tabs ");
	});
});

// ── All tools register width-aware results ─────────────────────────────────

describe("all overridden tools return width-aware renderResult", () => {
	const toolNames = ["read", "bash", "write", "find", "grep", "ls"];

	for (const name of toolNames) {
		it(`${name}: expanded renderResult for long content is width-aware`, () => {
			const tool = getTool(name);
			const details =
				name === "write"
					? { path: "test.ts", lineCount: 1, byteCount: 300, preview: LONG_ASCII }
					: undefined;

			const result = tool.renderResult!(
				{ content: [{ type: "text", text: LONG_ASCII }], details },
				{ expanded: true },
				plainTheme(),
			);

			// Must either be width-aware OR be safe (short enough)
			if (isWidthAware(result)) {
				assertAllLinesFit(result, 80, `${name} `);
			} else {
				const text = (result as TextComponent).text ?? "";
				for (const line of text.split("\n")) {
					expect(visibleWidth(line)).toBeLessThanOrEqual(80);
				}
			}
		});
	}
});
