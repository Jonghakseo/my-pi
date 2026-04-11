import { describe, expect, it, vi } from "vitest";
import openPrExtension, {
	createOpenPrHandler,
	formatPrLookupError,
	parsePrViewUrl,
	resolveBrowserOpenCommand,
} from "../open-pr.js";

describe("open-pr extension", () => {
	it("registers the /open-pr command", () => {
		const registerCommand = vi.fn();
		openPrExtension({ registerCommand } as never);

		expect(registerCommand).toHaveBeenCalledWith(
			"open-pr",
			expect.objectContaining({
				description: expect.stringContaining("pull request"),
				handler: expect.any(Function),
			}),
		);
	});

	it("opens the current branch pull request in the browser", async () => {
		const url = "https://github.com/owner/repo/pull/42";
		const exec = vi
			.fn()
			.mockResolvedValueOnce({ code: 0, stdout: "/repo\n" })
			.mockResolvedValueOnce({ code: 0, stdout: "feature/footer\n" })
			.mockResolvedValueOnce({ code: 0, stdout: JSON.stringify({ url }) })
			.mockResolvedValueOnce({ code: 0, stdout: "" });
		const notify = vi.fn();
		const handler = createOpenPrHandler({ exec } as never);
		const browser = resolveBrowserOpenCommand(process.platform, url);

		await handler("", {
			cwd: "/repo/extensions",
			hasUI: true,
			ui: { notify },
		} as never);

		expect(exec).toHaveBeenNthCalledWith(1, "git", ["rev-parse", "--show-toplevel"], { cwd: "/repo/extensions" });
		expect(exec).toHaveBeenNthCalledWith(2, "git", ["branch", "--show-current"], { cwd: "/repo" });
		expect(exec).toHaveBeenNthCalledWith(3, "gh", ["pr", "view", "--json", "url"], { cwd: "/repo" });
		expect(exec).toHaveBeenNthCalledWith(4, browser.command, browser.args, { cwd: "/repo" });
		expect(notify).toHaveBeenCalledWith(`Opened PR for feature/footer: ${url}`, "info");
	});

	it("shows a clear error when the current branch has no pull request", async () => {
		const exec = vi
			.fn()
			.mockResolvedValueOnce({ code: 0, stdout: "/repo\n" })
			.mockResolvedValueOnce({ code: 0, stdout: "feature/footer\n" })
			.mockResolvedValueOnce({ code: 1, stderr: 'no pull requests found for branch "feature/footer"' });
		const notify = vi.fn();
		const handler = createOpenPrHandler({ exec } as never);

		await handler("", {
			cwd: "/repo/extensions",
			hasUI: true,
			ui: { notify },
		} as never);

		expect(exec).toHaveBeenCalledTimes(3);
		expect(notify).toHaveBeenCalledWith("No pull request found for the current branch (feature/footer).", "error");
	});
});

describe("open-pr helpers", () => {
	it("parses a PR URL from gh JSON output", () => {
		expect(parsePrViewUrl('{"url":"https://github.com/owner/repo/pull/42"}')).toBe(
			"https://github.com/owner/repo/pull/42",
		);
		expect(parsePrViewUrl("not-json")).toBeNull();
	});

	it("maps browser commands by platform", () => {
		expect(resolveBrowserOpenCommand("darwin", "https://example.com")).toEqual({
			command: "open",
			args: ["https://example.com"],
		});
		expect(resolveBrowserOpenCommand("win32", "https://example.com")).toEqual({
			command: "cmd",
			args: ["/c", "start", "", "https://example.com"],
		});
		expect(resolveBrowserOpenCommand("linux", "https://example.com")).toEqual({
			command: "xdg-open",
			args: ["https://example.com"],
		});
	});

	it("classifies common gh PR lookup errors", () => {
		expect(formatPrLookupError("no pull requests found", "feature/footer")).toBe(
			"No pull request found for the current branch (feature/footer).",
		);
		expect(formatPrLookupError("not logged into any GitHub hosts", "feature/footer")).toContain(
			"GitHub CLI authentication failed:",
		);
		expect(formatPrLookupError("could not resolve to a repository", "feature/footer")).toContain(
			"GitHub repository lookup failed:",
		);
	});
});
