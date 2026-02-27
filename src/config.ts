import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { homedir } from "node:os";

import { SearchProvider } from "./types";
import type { HydraConfig, HydraConfigFile } from "./types";

/** default api base url for llm requests. */
export const DEFAULT_BASE_URL = "https://api.synthetic.new/openai/v1";
/** default llm model identifier used by the project. */
export const DEFAULT_MODEL = "hf:MiniMaxAI/MiniMax-M2.5";
/** minimum supported debate rounds value. */
export const MIN_DEBATE_ROUNDS = 1;
/** maximum supported debate rounds value. */
export const MAX_DEBATE_ROUNDS = 8;
/** config directory under user home. */
export const CONFIG_DIR = resolve(homedir(), ".config", "hydra-cli");
/** default config file path. */
export const CONFIG_FILE = resolve(CONFIG_DIR, "config.json");

const DEFAULTS: HydraConfig = {
  apiKey: undefined,
  syntheticApiKey: undefined,
  searchProvider: "synthetic",
  exaApiKey: undefined,
  braveApiKey: undefined,
  baseUrl: DEFAULT_BASE_URL,
  model: DEFAULT_MODEL,
  defaultAgentCount: 5,
  maxConcurrency: 1,
  debateRounds: 2,
  searchEnabled: true,
  customPersonasOnly: false,
};

/** convert raw numeric values into clamped integers with safe fallback. */
export function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const parsed = Number.parseInt(String(value), 10);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.min(Math.max(parsed, min), max);
}

/** normalize truthy / falsy string values from env and config files. */
function normalizeBoolean(value: unknown): boolean | undefined {
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (["1", "true", "yes", "y", "on"].includes(normalized)) {
      return true;
    }
    if (["0", "false", "no", "n", "off"].includes(normalized)) {
      return false;
    }
  }
  return undefined;
}

/** normalize and fallback invalid search provider values. */
function normalizeSearchProvider(value: unknown): SearchProvider {
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (normalized === "synthetic" || normalized === "exa" || normalized === "brave") {
      return normalized;
    }
  }
  return DEFAULTS.searchProvider;
}

/** trim optional api key strings and convert blank values to undefined. */
function trimOptionalApiKey(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/** ensure the config directory exists before read/write operations. */
function ensureConfigDir() {
  if (!existsSync(CONFIG_DIR)) {
    mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  }
}

/** load raw config from disk and return parsed config json if valid. */
function readConfigFile(): HydraConfigFile {
  if (!existsSync(CONFIG_FILE)) {
    return {};
  }

  const raw = readFileSync(CONFIG_FILE, "utf8").trim();
  if (!raw) {
    return {};
  }

  try {
    const parsed = JSON.parse(raw) as HydraConfigFile;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {};
    }
    return parsed;
  } catch {
    return {};
  }
}

/** overlay environment variables on top of persisted config values. */
function applyEnvironmentOverrides(config: HydraConfigFile): HydraConfigFile {
  const merged = { ...config };
  if (process.env.HYDRA_API_KEY) {
    merged.apiKey = process.env.HYDRA_API_KEY;
  }
  if (process.env.HYDRA_SYNTHETIC_API_KEY) {
    merged.syntheticApiKey = process.env.HYDRA_SYNTHETIC_API_KEY;
  } else if (process.env.SYNTHETIC_API_KEY) {
    merged.syntheticApiKey = process.env.SYNTHETIC_API_KEY;
  }
  if (process.env.HYDRA_SEARCH_PROVIDER) {
    merged.searchProvider = normalizeSearchProvider(process.env.HYDRA_SEARCH_PROVIDER);
  }
  if (process.env.HYDRA_EXA_API_KEY) {
    merged.exaApiKey = process.env.HYDRA_EXA_API_KEY;
  } else if (process.env.EXA_API_KEY) {
    merged.exaApiKey = process.env.EXA_API_KEY;
  }
  if (process.env.HYDRA_BRAVE_API_KEY) {
    merged.braveApiKey = process.env.HYDRA_BRAVE_API_KEY;
  } else if (process.env.BRAVE_API_KEY) {
    merged.braveApiKey = process.env.BRAVE_API_KEY;
  }
  if (process.env.HYDRA_MODEL) {
    merged.model = process.env.HYDRA_MODEL;
  }
  if (process.env.HYDRA_ORCHESTRATOR_MODEL) {
    merged.orchestratorModel = process.env.HYDRA_ORCHESTRATOR_MODEL;
  }
  if (process.env.HYDRA_RESEARCH_MODEL) {
    merged.researchModel = process.env.HYDRA_RESEARCH_MODEL;
  }
  if (process.env.HYDRA_BASE_URL) {
    merged.baseUrl = process.env.HYDRA_BASE_URL;
  }
  if (process.env.HYDRA_CUSTOM_PERSONAS_ONLY) {
    const parsed = normalizeBoolean(process.env.HYDRA_CUSTOM_PERSONAS_ONLY);
    if (parsed !== undefined) {
      merged.customPersonasOnly = parsed;
    }
  }
  if (process.env.HYDRA_CONCURRENCY) {
    const parsed = Number.parseInt(process.env.HYDRA_CONCURRENCY, 10);
    if (Number.isFinite(parsed)) {
      merged.maxConcurrency = parsed;
    }
  }
  return merged;
}

/** normalize config values and apply hard constraints to numeric fields. */
function normalizeConfig(config: HydraConfig): HydraConfig {
  const syntheticApiKey = trimOptionalApiKey(config.syntheticApiKey);
  const explicitApiKey = trimOptionalApiKey(config.apiKey);
  const apiKey = explicitApiKey ?? syntheticApiKey;

  return {
    apiKey: apiKey ?? undefined,
    syntheticApiKey,
    searchProvider: normalizeSearchProvider(config.searchProvider),
    exaApiKey: trimOptionalApiKey(config.exaApiKey),
    braveApiKey: trimOptionalApiKey(config.braveApiKey),
    baseUrl: config.baseUrl || DEFAULTS.baseUrl,
    model: config.model || DEFAULTS.model,
    orchestratorModel: trimOptionalApiKey(config.orchestratorModel),
    researchModel: trimOptionalApiKey(config.researchModel),
    defaultAgentCount: clampInt(config.defaultAgentCount, 1, 20, DEFAULTS.defaultAgentCount),
    maxConcurrency: clampInt(config.maxConcurrency, 1, 1, DEFAULTS.maxConcurrency),
    debateRounds: clampInt(
      config.debateRounds,
      MIN_DEBATE_ROUNDS,
      MAX_DEBATE_ROUNDS,
      DEFAULTS.debateRounds,
    ),
    searchEnabled: typeof config.searchEnabled === "boolean"
      ? config.searchEnabled
      : DEFAULTS.searchEnabled,
    customPersonasOnly: typeof config.customPersonasOnly === "boolean"
      ? config.customPersonasOnly
      : DEFAULTS.customPersonasOnly,
  };
}

/** return resolved config file path for diagnostics and tests. */
export function getConfigPath(): string {
  return CONFIG_FILE;
}

/** load config from defaults, env, and overrides and return validated values. */
export function loadConfig(overrides: HydraConfigFile = {}): HydraConfig {
  const merged = {
    ...DEFAULTS,
    ...applyEnvironmentOverrides(readConfigFile()),
    ...overrides,
  };

  return normalizeConfig(merged);
}

/** persist config values and return normalized merged config. */
export function writeConfig(updates: HydraConfigFile): HydraConfig {
  ensureConfigDir();
  const fileData = {
    ...readConfigFile(),
    ...updates,
  };

  writeFileSync(CONFIG_FILE, JSON.stringify(fileData, null, 2), {
    encoding: "utf8",
    mode: 0o600,
  });
  // Explicit chmod ensures 0o600 regardless of umask.
  chmodSync(CONFIG_FILE, 0o600);

  return normalizeConfig({
    ...DEFAULTS,
    ...fileData,
  });
}

/** mask api-like values for display to avoid accidental leakage in logs. */
export function maskConfigValue(value: string | undefined): string {
  if (!value) {
    return "not set";
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return "not set";
  }
  if (trimmed.length <= 8) {
    return "[redacted]";
  }
  const suffix = trimmed.slice(-4);
  return `sk-...${suffix}`;
}

/** sanitize raw config-string input and return typed value or validation error. */
export function sanitizeConfigValueForSet(
  key: keyof HydraConfig,
  value: string,
): { error?: string; value: unknown } {
  if (key === "defaultAgentCount") {
    const parsed = Number.parseInt(value, 10);
    if (!Number.isFinite(parsed)) {
      return { error: "defaultAgentCount must be an integer", value: undefined };
    }
    return { value: clampInt(parsed, 1, 20, DEFAULTS.defaultAgentCount) };
  }

  if (key === "maxConcurrency") {
    const parsed = Number.parseInt(value, 10);
    if (!Number.isFinite(parsed)) {
      return {
        error: "maxConcurrency must be 1",
        value: undefined,
      };
    }
    if (parsed !== 1) {
      return {
        error: "maxConcurrency must be 1",
        value: undefined,
      };
    }
    return { value: parsed };
  }

  if (key === "debateRounds") {
    const parsed = Number.parseInt(value, 10);
    if (!Number.isFinite(parsed)) {
      return { error: "debateRounds must be an integer", value: undefined };
    }
    return {
      value: clampInt(
        parsed,
        MIN_DEBATE_ROUNDS,
        MAX_DEBATE_ROUNDS,
        DEFAULTS.debateRounds,
      ),
    };
  }

  if (key === "searchEnabled") {
    const parsed = normalizeBoolean(value);
    if (parsed === undefined) {
      return {
        error: "searchEnabled must be one of: true, false, 1, 0, yes, no",
        value: undefined,
      };
    }
    return { value: parsed };
  }

  if (key === "customPersonasOnly") {
    const parsed = normalizeBoolean(value);
    if (parsed === undefined) {
      return {
        error: "custom-personas-only must be one of: true, false, 1, 0, yes, no",
        value: undefined,
      };
    }
    return { value: parsed };
  }

  if (key === "baseUrl" || key === "model" || key === "syntheticApiKey" || key === "orchestratorModel" || key === "researchModel") {
    return { value: value.trim() }; 
  }

  if (key === "apiKey" || key === "exaApiKey" || key === "braveApiKey") {
    return { value: value.trim() };
  }

  if (key === "searchProvider") {
    const normalized = value.trim().toLowerCase();
    if (
      normalized !== "synthetic" &&
      normalized !== "exa" &&
      normalized !== "brave"
    ) {
      return {
        error: "search-provider must be one of: synthetic, exa, brave",
        value: undefined,
      };
    }
    return { value: normalized };
  }

  return { value };
}
