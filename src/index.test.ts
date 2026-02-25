import { describe, expect, test } from "bun:test";

import { normalizeArgvForBareRun, truncateQuery } from "./index";

describe("index helpers", () => {
  test("truncateQuery normalizes repeated whitespace", () => {
    expect(truncateQuery("  hello\n\n   world\t\tfrom   hydra  ")).toBe("hello world from hydra");
  });

  test("truncateQuery clips long content and appends ellipsis", () => {
    const output = truncateQuery("a".repeat(80), 10);
    expect(output).toBe("aaaaaaaaa…");
  });

  test("normalizeArgvForBareRun rewrites single bare query", () => {
    expect(normalizeArgvForBareRun(["bun", "src/index.ts", "climate"]))
      .toEqual(["bun", "src/index.ts", "run", "climate"]);
  });

  test("normalizeArgvForBareRun keeps likely root-command typos", () => {
    expect(normalizeArgvForBareRun(["bun", "src/index.ts", "histroy"]))
      .toEqual(["bun", "src/index.ts", "histroy"]);
  });

  test("normalizeArgvForBareRun lowercases known root command", () => {
    expect(normalizeArgvForBareRun(["bun", "src/index.ts", "Help"]))
      .toEqual(["bun", "src/index.ts", "help"]);
  });

  test("normalizeArgvForBareRun supports compact short options", () => {
    expect(normalizeArgvForBareRun(["bun", "src/index.ts", "query", "-a5", "--json"]))
      .toEqual(["bun", "src/index.ts", "run", "query", "-a5", "--json"]);
  });

  test("normalizeArgvForBareRun rejects bare rewrite when extra positional args are present", () => {
    expect(normalizeArgvForBareRun(["bun", "src/index.ts", "query", "extra"]))
      .toEqual(["bun", "src/index.ts", "query", "extra"]);
  });
});
