import { describe, expect, it, vi } from "vitest";
import toHtml from "./index.ts";

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((nextResolve) => {
		resolve = nextResolve;
	});
	return { promise, resolve };
}

describe("to-html", () => {
	it("returns from the command while the headless widget generation is still running", async () => {
		const generation = deferred<{ code: number; stdout: string; stderr: string }>();
		const commands = new Map<string, { handler: (args: string, ctx: any) => Promise<void> }>();
		const pi = {
			registerCommand: vi.fn((name: string, command: { handler: (args: string, ctx: any) => Promise<void> }) => {
				commands.set(name, command);
			}),
			exec: vi.fn(() => generation.promise),
		};
		const notify = vi.fn();
		const ctx = {
			cwd: "/project",
			waitForIdle: vi.fn().mockResolvedValue(undefined),
			sessionManager: {
				getBranch: vi.fn(() => [
					{
						type: "message",
						message: { role: "assistant", content: [{ type: "text", text: "Source response" }] },
					},
				]),
			},
			ui: { notify },
		};

		toHtml(pi as any);
		const command = commands.get("to-html");
		expect(command).toBeDefined();
		if (!command) throw new Error("to-html command was not registered");

		let handlerFinished = false;
		const handlerPromise = command.handler("", ctx).then(() => {
			handlerFinished = true;
		});
		await Promise.resolve();
		await Promise.resolve();

		expect(pi.exec).toHaveBeenCalledOnce();
		expect(handlerFinished).toBe(true);

		generation.resolve({ code: 0, stdout: "", stderr: "" });
		await handlerPromise;
		await Promise.resolve();
		expect(notify).toHaveBeenLastCalledWith("✅ HTML 위젯 생성 요청이 완료되었습니다.", "info");
	});
});
