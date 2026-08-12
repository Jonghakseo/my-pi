import { describe, expect, it } from "vitest";
import bashToolOverride from "./index.ts";

function makeBashTool() {
	let tool: any;
	bashToolOverride({
		registerTool(definition: any) {
			tool = definition;
		},
	} as any);
	return tool;
}

const theme = {
	fg: (_token: string, text: string) => text,
	bold: (text: string) => text,
};

function renderCommand(command: string, cwd: string, expanded: boolean): string {
	const tool = makeBashTool();
	return tool
		.renderCall({ command, title: "상태 확인" }, theme, {
			cwd,
			expanded,
		})
		.render(160)
		.join("\n");
}

describe("bash tool command preview", () => {
	it("abbreviates a leading cd to the session cwd in collapsed mode", () => {
		const cwd = "/Users/example/.worktrees/project/temp-20260812-061136";
		const rendered = renderCommand(`cd ${cwd} && git status --short`, cwd, false);

		expect(rendered).toContain("$ cd <cwd> && git status --short");
		expect(rendered).not.toContain(cwd);
	});

	it("keeps the full cwd in expanded mode", () => {
		const cwd = "/Users/example/project";
		const rendered = renderCommand(`cd ${cwd} && git status --short`, cwd, true);

		expect(rendered).toContain(`$ cd ${cwd} && git status --short`);
	});

	it("does not abbreviate a cd to a different directory", () => {
		const rendered = renderCommand("cd /Users/example/other && git status --short", "/Users/example/project", false);

		expect(rendered).toContain("$ cd /Users/example/other && git status --short");
	});
});
