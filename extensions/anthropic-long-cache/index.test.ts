import { describe, expect, it } from "vitest";
import { getArgumentCompletions } from "./index.js";

describe("getArgumentCompletions", () => {
	it("suggests on and off for an empty argument", () => {
		expect(getArgumentCompletions("")).toEqual([
			{ value: "on", label: "on" },
			{ value: "off", label: "off" },
		]);
	});

	it("filters suggestions by prefix", () => {
		expect(getArgumentCompletions("o")).toEqual([
			{ value: "on", label: "on" },
			{ value: "off", label: "off" },
		]);
		expect(getArgumentCompletions("on")).toEqual([{ value: "on", label: "on" }]);
		expect(getArgumentCompletions("x")).toBeNull();
	});
});
