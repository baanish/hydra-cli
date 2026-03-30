import { describe, expect, test } from "vitest";

import { normalizeArgvForBareRun, truncateQuery } from "./index.js";

describe("index helpers", () => {
	test("truncateQuery normalizes repeated whitespace", () => {
		expect(truncateQuery("  hello\n\n   world\t\tfrom   hydra  ")).toBe(
			"hello world from hydra",
		);
	});

	test("truncateQuery clips long content and appends ellipsis", () => {
		const output = truncateQuery("a".repeat(80), 10);
		expect(output).toBe("aaaaaaaaa…");
	});

	test("normalizeArgvForBareRun rewrites single bare query", () => {
		expect(
			normalizeArgvForBareRun(["node", "dist/index.js", "climate"]),
		).toEqual(["node", "dist/index.js", "run", "climate"]);
	});

	test("normalizeArgvForBareRun keeps likely root-command typos", () => {
		expect(
			normalizeArgvForBareRun(["node", "dist/index.js", "histroy"]),
		).toEqual(["node", "dist/index.js", "histroy"]);
	});

	test("normalizeArgvForBareRun lowercases known root command", () => {
		expect(normalizeArgvForBareRun(["node", "dist/index.js", "Help"])).toEqual([
			"node",
			"dist/index.js",
			"help",
		]);
	});

	test("normalizeArgvForBareRun supports compact short options", () => {
		expect(
			normalizeArgvForBareRun([
				"node",
				"dist/index.js",
				"query",
				"-a5",
				"--json",
			]),
		).toEqual(["node", "dist/index.js", "run", "query", "-a5", "--json"]);
	});

	test("normalizeArgvForBareRun rejects bare rewrite when extra positional args are present", () => {
		expect(
			normalizeArgvForBareRun(["node", "dist/index.js", "query", "extra"]),
		).toEqual(["node", "dist/index.js", "query", "extra"]);
	});
});
