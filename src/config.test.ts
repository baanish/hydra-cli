import { describe, expect, test } from "bun:test";

import {
  DEFAULT_BASE_URL,
  loadConfig,
  sanitizeConfigValueForSet,
} from "./config";

describe("config security validation", () => {
  test("loadConfig falls back to the default baseUrl when baseUrl is unset", () => {
    const config = loadConfig({ baseUrl: "" });
    expect(config.baseUrl).toBe(DEFAULT_BASE_URL);
  });

  test("loadConfig throws when configured baseUrl is unsafe", () => {
    expect(() => loadConfig({ baseUrl: "http://example.com/v1" })).toThrow(
      'invalid base-url "http://example.com/v1"',
    );
  });

  test("sanitizeConfigValueForSet rejects unsafe remote http baseUrl values", () => {
    const result = sanitizeConfigValueForSet(
      "baseUrl",
      "http://example.com/v1",
    );
    expect(result.error).toContain("https");
    expect(result.value).toBeUndefined();
  });

  test("sanitizeConfigValueForSet accepts loopback http baseUrl values", () => {
    const result = sanitizeConfigValueForSet(
      "baseUrl",
      "http://127.0.0.1:11434/v1",
    );
    expect(result.error).toBeUndefined();
    expect(result.value).toBe("http://127.0.0.1:11434/v1");
  });
});
