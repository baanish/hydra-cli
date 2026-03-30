import { spawnSync } from "node:child_process";

import { describe, expect, test } from "vitest";

function npmCommand(): string {
	return process.platform === "win32" ? "npm.cmd" : "npm";
}

describe("compiled cli smoke test", () => {
	test("node dist/index.js --help prints commander help", () => {
		const build = spawnSync(npmCommand(), ["run", "build"], {
			cwd: process.cwd(),
			encoding: "utf8",
		});

		expect(build.status, build.stderr).toBe(0);

		const result = spawnSync(process.execPath, ["dist/index.js", "--help"], {
			cwd: process.cwd(),
			encoding: "utf8",
		});

		expect(result.status, result.stderr).toBe(0);
		expect(result.stdout).toContain("Usage: hydra");
	});
});
