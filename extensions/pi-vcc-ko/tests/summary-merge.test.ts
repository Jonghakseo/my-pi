import { describe, expect, it } from "vitest";
import { RECALL_NOTE, TUI_SAFE_LINE_CHARS, wrapLongLines } from "../src/core/format.ts";
import { type CompactionState, compileRanked, compileRankedWithState } from "../src/core/summarize.ts";
import { assistantText, assistantWithToolCall, userMsg } from "./fixtures.ts";

const LEGACY_NOTE =
	"Use `vcc_recall` to search for prior work, decisions, and context from before this summary. Do not redo work already completed.";

const countNotes = (s: string) =>
	s.split("to recover details from before this summary").length - 1 + (s.split("to search for prior work").length - 1);

const filesSection = (s: string) => s.match(/\[Files And Changes\]\n([\s\S]*?)(?=\n\n|$)/)?.[1] ?? "";

const editWindow = (label: string, paths: string[]) => [
	userMsg(`${label} 작업을 수정해줘`),
	...paths.map((p) => assistantWithToolCall("edit", { path: p, edits: [{ oldText: "a", newText: "b" }] })),
	assistantText(`${label} 완료`),
];

describe("merging with the previous summary", () => {
	it("keeps the recall note within the TUI line width so it is never wrapped", () => {
		expect(RECALL_NOTE.length).toBeLessThanOrEqual(TUI_SAFE_LINE_CHARS);
		expect(wrapLongLines(RECALL_NOTE)).toBe(RECALL_NOTE);
	});

	it("leaves exactly one recall note, removing wrapped legacy notes embedded mid-brief", () => {
		const legacy = wrapLongLines(
			`[Session Goal]\n- 기존 목표\n\n---\n\n[user]\n옛 요청\n\n---\n\n${LEGACY_NOTE}\n\n[assistant]\n옛 답변\n\n---\n\n${LEGACY_NOTE}`,
		);
		let summary = compileRanked({ messages: editWindow("첫", ["/repo/a.ts"]), previousSummary: legacy });
		for (let i = 0; i < 3; i++) {
			summary = compileRanked({ messages: editWindow(`반복 ${i}`, [`/repo/r${i}.ts`]), previousSummary: summary });
		}
		expect(countNotes(summary)).toBe(1);
		expect(summary).not.toContain("to search for prior work");
		expect(summary.trimEnd().endsWith(RECALL_NOTE)).toBe(true);
		// The legacy brief content itself survives the cleanup.
		expect(summary).toContain("옛 답변");
	});

	it("accumulates modified files across compactions, showing the newest and counting the rest", () => {
		let state: CompactionState | undefined;
		let summary = "";
		for (let w = 0; w < 4; w++) {
			const paths = Array.from({ length: 5 }, (_, i) => `/repo/src/w${w}/file-${i}.ts`);
			const out = compileRankedWithState({
				messages: editWindow(`창 ${w}`, paths),
				previousSummary: summary || undefined,
				previousState: state,
				pathDisplay: { root: "/repo" },
			});
			state = out.state;
			summary = out.summary;
		}
		expect(state?.files.modified).toHaveLength(20);
		const files = filesSection(summary).replace(/\n\s+/g, " ");
		expect(files).toContain("src/w3/file-4.ts");
		expect(files).toContain("src/w2/file-0.ts");
		expect(files).not.toContain("src/w0/file-0.ts");
		expect(files).toContain("(+10 earlier)");
	});

	it("recovers every file of a wrapped legacy [Files And Changes] section when no state exists", () => {
		const legacyPaths = Array.from({ length: 8 }, (_, i) => `module-${i}/component-file-${i}.ts`);
		const legacy = wrapLongLines(
			`[Files And Changes]\n- Modified: ${legacyPaths.join(", ")}\n\n---\n\n[user]\n옛 요청\n\n---\n\n${LEGACY_NOTE}`,
		);
		expect(legacy.split("\n").filter((l) => l.startsWith("  ")).length).toBeGreaterThan(0);
		const { state } = compileRankedWithState({
			messages: editWindow("새", ["/repo/new.ts"]),
			previousSummary: legacy,
		});
		for (const p of legacyPaths) expect(state.files.modified).toContain(p);
		expect(state.files.modified.at(-1)).toBe("/repo/new.ts");
	});

	it("merges a legacy trimmed path with the same file seen again as an absolute path", () => {
		const legacy = "[Files And Changes]\n- Modified: src/auth.ts, src/other.ts\n\n---\n\n[user]\n옛 요청";
		const { state } = compileRankedWithState({
			messages: editWindow("재수정", ["/repo/src/auth.ts"]),
			previousSummary: legacy,
		});
		expect(state.files.modified).toEqual(["src/other.ts", "/repo/src/auth.ts"]);
	});

	it("keeps the brief of a previous summary that had no header sections", () => {
		const previousSummary = `[user]\n헤더 없는 옛 요청\n\n[assistant]\n헤더 없는 옛 답변\n\n---\n\n${RECALL_NOTE}`;
		const summary = compileRanked({ messages: editWindow("새", ["/repo/x.ts"]), previousSummary });
		expect(summary).toContain("헤더 없는 옛 답변");
	});

	it("renders paths below cwd relative, below home with ~/, and others absolute", () => {
		const { summary } = compileRankedWithState({
			messages: editWindow("경로", ["/work/proj/src/a.ts", "/home/me/.config/tool.json", "/tmp/scratch.txt"]),
			pathDisplay: { root: "/work/proj", home: "/home/me" },
		});
		const files = filesSection(summary);
		expect(files).toContain("src/a.ts");
		expect(files).not.toContain("/work/proj/src/a.ts");
		expect(files).toContain("~/.config/tool.json");
		expect(files).toContain("/tmp/scratch.txt");
	});
});
