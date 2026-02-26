import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import { CONFIG_DIR } from "../config";
import type { PersonaConfig } from "../types";

const PERSONA_ID_PATTERN = /^[a-z0-9-]+$/;

function trimPersonaValue(value: string): string {
  return value.trim();
}

function normalizePersona(persona: PersonaConfig): PersonaConfig {
  return {
    id: trimPersonaValue(persona.id).toLowerCase(),
    name: trimPersonaValue(persona.name),
    description: trimPersonaValue(persona.description),
    methodology: trimPersonaValue(persona.methodology),
  };
}

function isPersonaConfig(value: unknown): value is PersonaConfig {
  if (!value || typeof value !== "object") {
    return false;
  }
  const candidate = value as Partial<PersonaConfig>;
  if (
    typeof candidate.id !== "string" ||
    typeof candidate.name !== "string" ||
    typeof candidate.description !== "string" ||
    typeof candidate.methodology !== "string"
  ) {
    return false;
  }

  const normalized = normalizePersona({
    id: candidate.id,
    name: candidate.name,
    description: candidate.description,
    methodology: candidate.methodology,
  });
  return (
    normalized.id.length > 0 &&
    PERSONA_ID_PATTERN.test(normalized.id) &&
    normalized.name.length > 0 &&
    normalized.description.length > 0 &&
    normalized.methodology.length > 0
  );
}

function ensurePersonasDirectoryExists(): void {
  const personasDirectory = dirname(PERSONAS_FILE);
  if (!existsSync(personasDirectory)) {
    mkdirSync(personasDirectory, { recursive: true, mode: 0o700 });
  }
}

/** location of custom personas persisted on disk. */
export let PERSONAS_FILE = resolve(CONFIG_DIR, "personas.json");

/** set custom personas storage path for tests or controlled environments. */
export function setPersonasFile(path: string): void {
  PERSONAS_FILE = path;
}

/** return current custom personas storage path. */
export function getPersonasFile(): string {
  return PERSONAS_FILE;
}

/** complete set of built-in personas used by orchestration phases. */
export const PERSONAS: PersonaConfig[] = [
  {
    id: "skeptic",
    name: "The Skeptic",
    description: "Questions assumptions, demands evidence, and identifies logical fallacies.",
    methodology: "first-principles validation",
  },
  {
    id: "optimist",
    name: "The Optimist",
    description: "Explores upside scenarios and hidden opportunities.",
    methodology: "opportunity mapping",
  },
  {
    id: "historian",
    name: "The Historian",
    description: "Uses analogies from history and precedent.",
    methodology: "historical pattern comparison",
  },
  {
    id: "contrarian",
    name: "The Contrarian",
    description: "Argues the opposite case to reveal weak assumptions.",
    methodology: "inverse thesis testing",
  },
  {
    id: "technical-analyst",
    name: "The Technical Analyst",
    description: "Data-driven and quantitative.",
    methodology: "metric-first decomposition",
  },
  {
    id: "risk-assessor",
    name: "The Risk Assessor",
    description: "Identifies failure modes and downside scenarios.",
    methodology: "risk tree analysis",
  },
  {
    id: "futurist",
    name: "The Futurist",
    description: "Extrapolates trends and second-order effects.",
    methodology: "scenario projection",
  },
  {
    id: "devils-advocate",
    name: "The Devil's Advocate",
    description: "Stress-tests every conclusion under pressure.",
    methodology: "adversarial stress testing",
  },
  {
    id: "domain-expert",
    name: "The Domain Expert",
    description: "Deep specialist-style contextual analysis.",
    methodology: "domain-specific synthesis",
  },
  {
    id: "synthesizer",
    name: "The Synthesizer",
    description: "Connects disparate findings into cohesive patterns.",
    methodology: "cross-signal synthesis",
  },
  {
    id: "economist",
    name: "The Economist",
    description: "Analyzes cost structures, market dynamics, and economic incentives.",
    methodology: "economic modeling and incentive analysis",
  },
  {
    id: "pragmatist",
    name: "The Pragmatist",
    description: "Focuses on actionable, implementable solutions over theory.",
    methodology: "feasibility-first evaluation",
  },
  {
    id: "ethicist",
    name: "The Ethicist",
    description: "Examines moral implications, fairness, and societal impact.",
    methodology: "ethical framework analysis",
  },
  {
    id: "systems-thinker",
    name: "The Systems Thinker",
    description: "Maps feedback loops, dependencies, and emergent behaviors.",
    methodology: "systems dynamics modeling",
  },
  {
    id: "consumer-advocate",
    name: "The Consumer Advocate",
    description: "Evaluates from the end-user perspective: value, experience, and satisfaction.",
    methodology: "user-centric value analysis",
  },
  {
    id: "geopolitical-analyst",
    name: "The Geopolitical Analyst",
    description: "Considers supply chains, trade policy, and regional dynamics.",
    methodology: "geopolitical risk mapping",
  },
  {
    id: "data-scientist",
    name: "The Data Scientist",
    description: "Seeks statistical evidence, benchmarks, and empirical validation.",
    methodology: "statistical evidence synthesis",
  },
  {
    id: "venture-strategist",
    name: "The Venture Strategist",
    description: "Evaluates through the lens of market timing, moats, and competitive advantage.",
    methodology: "competitive positioning analysis",
  },
  {
    id: "red-teamer",
    name: "The Red Teamer",
    description: "Actively tries to break the consensus and find fatal flaws.",
    methodology: "adversarial attack surface analysis",
  },
  {
    id: "philosopher",
    name: "The Philosopher",
    description: "Questions framing, definitions, and hidden assumptions in the question itself.",
    methodology: "epistemic deconstruction",
  },
];

const BUILTIN_PERSONA_IDS = new Set(PERSONAS.map((persona) => persona.id));

/** number of built-in personas. */
export const BUILTIN_PERSONA_COUNT = PERSONAS.length;

/** load and normalize all custom personas from config storage. */
export function loadCustomPersonas(): PersonaConfig[] {
  try {
    if (!existsSync(PERSONAS_FILE)) {
      return [];
    }

    const raw = readFileSync(PERSONAS_FILE, "utf8").trim();
    if (!raw) {
      return [];
    }

    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed) || !parsed.every(isPersonaConfig)) {
      return [];
    }
    return parsed.map((value) => normalizePersona(value));
  } catch {
    return [];
  }
}

/** write custom personas list to disk with restricted file permissions. */
export function saveCustomPersonas(personas: PersonaConfig[]): void {
  ensurePersonasDirectoryExists();
  writeFileSync(PERSONAS_FILE, JSON.stringify(personas, null, 2), {
    encoding: "utf8",
    mode: 0o600,
  });
  chmodSync(PERSONAS_FILE, 0o600);
}

/** append a new custom persona after validation and persist it. */
export function addCustomPersona(persona: PersonaConfig): { error?: string } {
  const candidate = normalizePersona(persona);
  if (!candidate.id.length) {
    return { error: "id must be non-empty" };
  }
  if (!candidate.name.length) {
    return { error: "name must be non-empty" };
  }
  if (!candidate.description.length) {
    return { error: "description must be non-empty" };
  }
  if (!candidate.methodology.length) {
    return { error: "methodology must be non-empty" };
  }
  if (!PERSONA_ID_PATTERN.test(candidate.id)) {
    return {
      error: "id must be lowercase alphanumeric and hyphens only",
    };
  }
  if (BUILTIN_PERSONA_IDS.has(candidate.id)) {
    return { error: "id already exists" };
  }

  const customPersonas = loadCustomPersonas();
  if (customPersonas.some((existing) => existing.id === candidate.id)) {
    return { error: "id already exists" };
  }

  try {
    saveCustomPersonas([...customPersonas, candidate]);
  } catch {
    return { error: "failed to persist custom personas" };
  }
  return {};
}

/** remove a custom persona by id from storage. */
export function removeCustomPersona(id: string): boolean {
  const normalizedId = trimPersonaValue(id).toLowerCase();
  if (!normalizedId.length) {
    return false;
  }

  const customPersonas = loadCustomPersonas();
  const filteredPersonas = customPersonas.filter((persona) => persona.id !== normalizedId);
  if (filteredPersonas.length === customPersonas.length) {
    return false;
  }

  try {
    saveCustomPersonas(filteredPersonas);
  } catch {
    return false;
  }
  return true;
}

/** return built-in and custom personas with built-ins first. */
export function allPersonas(): PersonaConfig[] {
  return [...PERSONAS, ...loadCustomPersonas()];
}

/** find a persona by exact display name from built-ins. */
export function getPersonaByName(name: string): PersonaConfig | undefined {
  return PERSONAS.find((persona) => persona.name === name);
}

/** select a stable prefix of personas up to requested count. */
export function selectPersonas(count: number): PersonaConfig[] {
  const all = allPersonas();
  const safeCount = Math.max(1, Math.min(all.length, count));
  return all.slice(0, safeCount);
}
