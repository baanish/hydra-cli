import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import type { PersonaConfig } from "../types.js";
import {
	PERSONAS,
	addCustomPersona,
	allPersonas,
	generateEphemeralPersonas,
	getPersonasFile,
	loadCustomPersonas,
	removeCustomPersona,
	selectPersonas,
	setPersonasFile,
} from "./personas.js";

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

		expect(result.error).toBe(
			"id must be lowercase alphanumeric and hyphens only",
		);
	});

	test("addCustomPersona rejects duplicate ids", () => {
		const firstBuiltinPersona = PERSONAS[0];
		if (!firstBuiltinPersona) {
			throw new Error("expected built-in personas to be present");
		}

		const builtinDuplicate = addCustomPersona({
			id: firstBuiltinPersona.id,
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

	test("removeCustomPersona matches ids case-insensitively", () => {
		const created = addCustomPersona({
			id: "My-Custom-ID",
			name: "Custom Casing Persona",
			description: "Description",
			methodology: "Method",
		} as PersonaConfig);
		expect(created.error).toBeUndefined();

		const removed = removeCustomPersona("MY-CUSTOM-ID");
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

	test("generateEphemeralPersonas returns valid PersonaConfig[] from valid JSON", async () => {
		const generated = await generateEphemeralPersonas(
			"analyze migration risks",
			2,
			async () =>
				JSON.stringify([
					{
						id: "Risk-Analyst",
						name: "Risk Analyst",
						description: "Analyzes downside scenarios and failure modes.",
						methodology: "risk-first analysis",
					},
					{
						id: "scenario-mapper",
						name: "Scenario Mapper",
						description: "Builds futures and branches around edge cases.",
						methodology: "scenario mapping",
					},
				]),
		);

		expect(generated).toEqual([
			{
				id: "risk-analyst",
				name: "Risk Analyst",
				description: "Analyzes downside scenarios and failure modes.",
				methodology: "risk-first analysis",
			},
			{
				id: "scenario-mapper",
				name: "Scenario Mapper",
				description: "Builds futures and branches around edge cases.",
				methodology: "scenario mapping",
			},
		]);
	});

	test("generateEphemeralPersonas retries and filters invalid personas", async () => {
		const outputs = [
			"not-json",
			JSON.stringify([
				{
					id: "bad id!",
					name: "Bad Persona",
					description: "Description",
					methodology: "Methodology",
				},
				{
					id: "good-persona",
					name: "Good Persona",
					description: "Description",
					methodology: "Methodology",
				},
			]),
			JSON.stringify([
				{
					id: "valid-two",
					name: "Valid Two",
					description: "Description",
					methodology: "Method",
				},
				{
					id: "good-persona",
					name: "Duplicate Persona",
					description: "Description",
					methodology: "Methodology",
				},
			]),
		];
		const prompts: string[] = [];
		let callCount = 0;

		const generated = await generateEphemeralPersonas(
			"test retries",
			3,
			async (_, userPrompt) => {
				const response = outputs[callCount];
				callCount += 1;
				prompts.push(userPrompt);
				return response ?? "[]";
			},
		);

		expect(callCount).toBe(3);
		expect(prompts).toEqual([
			'Generate 3 distinct analyst personas best suited to research: "test retries". Return a JSON array where each object has: id (lowercase-alphanumeric-hyphens), name, description (one sentence), methodology (short phrase). No markdown, no explanation.',
			'Generate 3 distinct analyst personas best suited to research: "test retries". Return a JSON array where each object has: id (lowercase-alphanumeric-hyphens), name, description (one sentence), methodology (short phrase). No markdown, no explanation.',
			'Generate 2 distinct analyst personas best suited to research: "test retries". Return a JSON array where each object has: id (lowercase-alphanumeric-hyphens), name, description (one sentence), methodology (short phrase). No markdown, no explanation.',
		]);
		expect(generated).toEqual([
			{
				id: "good-persona",
				name: "Good Persona",
				description: "Description",
				methodology: "Methodology",
			},
			{
				id: "valid-two",
				name: "Valid Two",
				description: "Description",
				methodology: "Method",
			},
		]);
	});
});
