import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  PERSONAS,
  addCustomPersona,
  allPersonas,
  getPersonasFile,
  loadCustomPersonas,
  removeCustomPersona,
  selectPersonas,
  setPersonasFile,
} from "./personas";
import type { PersonaConfig } from "../types";

const DEFAULT_PERSONAS_FILE = getPersonasFile();

describe("personas storage helpers", () => {
  let tempDir = "";
  let tempPersonasFile = "";

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "hydra-personas-"));
    tempPersonasFile = join(tempDir, "personas.json");
    setPersonasFile(tempPersonasFile);
  });

  afterEach(() => {
    setPersonasFile(DEFAULT_PERSONAS_FILE);
    rmSync(tempDir, { recursive: true, force: true });
  });

  test("loadCustomPersonas returns [] when personas file is missing", () => {
    expect(loadCustomPersonas()).toEqual([]);
  });

  test("addCustomPersona validates required fields", () => {
    const missingId = addCustomPersona({
      id: "",
      name: "Custom Persona",
      description: "Description",
      methodology: "Method",
    } as PersonaConfig);
    expect(missingId.error).toBe("id must be non-empty");

    const missingName = addCustomPersona({
      id: "custom-persona",
      name: "   ",
      description: "Description",
      methodology: "Method",
    } as PersonaConfig);
    expect(missingName.error).toBe("name must be non-empty");

    const missingDescription = addCustomPersona({
      id: "custom-persona-2",
      name: "Custom Persona",
      description: "   ",
      methodology: "Method",
    } as PersonaConfig);
    expect(missingDescription.error).toBe("description must be non-empty");

    const missingMethodology = addCustomPersona({
      id: "custom-persona-3",
      name: "Custom Persona",
      description: "Description",
      methodology: "   ",
    } as PersonaConfig);
    expect(missingMethodology.error).toBe("methodology must be non-empty");
  });

  test("addCustomPersona validates id format", () => {
    const result = addCustomPersona({
      id: "Bad ID!",
      name: "Custom Persona",
      description: "Description",
      methodology: "Method",
    } as PersonaConfig);

    expect(result.error).toBe("id must be lowercase alphanumeric and hyphens only");
  });

  test("addCustomPersona rejects duplicate ids", () => {
    const builtinDuplicate = addCustomPersona({
      id: PERSONAS[0]!.id,
      name: "Conflict",
      description: "Description",
      methodology: "Method",
    } as PersonaConfig);
    expect(builtinDuplicate.error).toBe("id already exists");

    const firstInsert = addCustomPersona({
      id: "custom-dup",
      name: "Custom Persona",
      description: "Description",
      methodology: "Method",
    } as PersonaConfig);
    expect(firstInsert.error).toBeUndefined();

    const secondInsert = addCustomPersona({
      id: "custom-dup",
      name: "Another Persona",
      description: "Another Description",
      methodology: "Another Method",
    } as PersonaConfig);
    expect(secondInsert.error).toBe("id already exists");
  });

  test("removeCustomPersona returns true when an id exists and false when missing", () => {
    const removedMiss = removeCustomPersona("nope");
    expect(removedMiss).toBe(false);

    const createResult = addCustomPersona({
      id: "custom-remove",
      name: "Custom to remove",
      description: "Description",
      methodology: "Method",
    } as PersonaConfig);
    expect(createResult.error).toBeUndefined();

    const removed = removeCustomPersona("custom-remove");
    expect(removed).toBe(true);
    expect(loadCustomPersonas()).toEqual([]);
  });

  test("allPersonas returns built-ins plus custom entries", () => {
    const added = addCustomPersona({
      id: "custom-one",
      name: "Custom One",
      description: "First description",
      methodology: "Method one",
    } as PersonaConfig);
    expect(added.error).toBeUndefined();

    const addedTwo = addCustomPersona({
      id: "custom-two",
      name: "Custom Two",
      description: "Second description",
      methodology: "Method two",
    } as PersonaConfig);
    expect(addedTwo.error).toBeUndefined();

    const personas = allPersonas();
    expect(personas.length).toBe(PERSONAS.length + 2);
    expect(personas.at(-2)?.id).toBe("custom-one");
    expect(personas.at(-1)?.id).toBe("custom-two");
  });

  test("selectPersonas uses custom personas from the full pool", () => {
    const result = addCustomPersona({
      id: "selectable-custom",
      name: "Selectable Custom",
      description: "Method description",
      methodology: "Method",
    } as PersonaConfig);
    expect(result.error).toBeUndefined();

    const selected = selectPersonas(PERSONAS.length + 1);
    const selectedIds = selected.map((persona) => persona.id);
    expect(selected).toHaveLength(PERSONAS.length + 1);
    expect(selectedIds).toContain("selectable-custom");
    expect(selected.at(-1)?.id).toBe("selectable-custom");
  });
});
