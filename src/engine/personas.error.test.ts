import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { PersonaConfig } from "../types";

const realFs = await import("node:fs");
const { mkdtempSync, rmSync, writeFileSync: realWriteFileSync } = await import("node:fs");

mock.module("node:fs", () => ({
  ...realFs,
  writeFileSync: () => {
    throw new Error("mocked write failure");
  },
}));

const {
  addCustomPersona,
  getPersonasFile,
  removeCustomPersona,
  setPersonasFile,
} = await import("./personas");

const DEFAULT_PERSONAS_FILE = getPersonasFile();

describe("personas persistence failures", () => {
  let tempDir = "";
  let tempPersonasFile = "";

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "hydra-personas-mock-write-"));
    tempPersonasFile = join(tempDir, "personas.json");
    setPersonasFile(tempPersonasFile);
  });

  afterEach(() => {
    setPersonasFile(DEFAULT_PERSONAS_FILE);
    rmSync(tempDir, { recursive: true, force: true });
  });

  test("addCustomPersona returns persistence error when save fails", () => {
    const result = addCustomPersona({
      id: "custom-persist-fail",
      name: "Custom Persona",
      description: "Description",
      methodology: "Method",
    } as PersonaConfig);

    expect(result).toEqual({ error: "failed to persist custom personas" });
  });

  test("removeCustomPersona returns false when save fails", () => {
    const persisted: PersonaConfig = {
      id: "custom-persist-fail",
      name: "Custom Persona",
      description: "Description",
      methodology: "Method",
    };
    realWriteFileSync(
      tempPersonasFile,
      JSON.stringify([persisted], null, 2),
      "utf8",
    );

    const removed = removeCustomPersona(persisted.id);
    expect(removed).toBe(false);
  });
});
