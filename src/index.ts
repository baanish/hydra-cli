#!/usr/bin/env bun

import { Command } from "commander";
import { writeFileSync } from "node:fs";

import { getRun, getRunAgentRuns, listRuns, removeRun } from "./db/queries";
import { HydraPipeline, type PipelineConfig } from "./engine/pipeline";
import {
  PERSONAS,
  addCustomPersona,
  allPersonas,
  removeCustomPersona,
} from "./engine/personas";
import {
  emitAgentProgress,
  setAgentModeConcurrency,
  setAgentModeDebateRounds,
} from "./ui/agent-mode";
import {
  clampInt,
  MAX_DEBATE_ROUNDS,
  MIN_DEBATE_ROUNDS,
  loadConfig,
  maskConfigValue,
  sanitizeConfigValueForSet,
  writeConfig,
  getConfigPath,
} from "./config";
import type { HydraConfig, RunRecord } from "./types";
import type { PipelineEvent, SearchConfig } from "./types";

const command = new Command()
  .name("hydra")
  .description("multi-agent research and synthesis CLI")
  .addHelpText(
    "after",
    `
storage:
  config: ${getConfigPath()}
`,
  )
  .showHelpAfterError(true);

const configKeyMap: Record<string, keyof HydraConfig> = {
  "api-key": "apiKey",
  "search-provider": "searchProvider",
  "synthetic-api-key": "syntheticApiKey",
  "exa-api-key": "exaApiKey",
  "brave-api-key": "braveApiKey",
  "base-url": "baseUrl",
  model: "model",
  "orchestrator-model": "orchestratorModel",
  "research-model": "researchModel",
  "default-agent-count": "defaultAgentCount",
  "max-concurrency": "maxConcurrency",
  "debate-rounds": "debateRounds",
  "search-enabled": "searchEnabled",
  "custom-personas-only": "customPersonasOnly",
};

function resolveLlmApiKey(config: HydraConfig): string {
  return config.apiKey || config.syntheticApiKey || "";
}

function resolveSearchConfig(config: HydraConfig): SearchConfig {
  return {
    provider: config.searchProvider,
    syntheticApiKey: config.syntheticApiKey || "",
    exaApiKey: config.exaApiKey || "",
    braveApiKey: config.braveApiKey || "",
  };
}

function resolveSearchApiKey(config: HydraConfig): string {
  const searchConfig = resolveSearchConfig(config);
  if (searchConfig.provider === "synthetic") {
    return config.syntheticApiKey || resolveLlmApiKey(config);
  }
  if (searchConfig.provider === "exa") {
    return config.exaApiKey || "";
  }
  return config.braveApiKey || "";
}

function createMaskedConfig(config: HydraConfig) {
  return {
    ...config,
    apiKey: maskConfigValue(config.apiKey),
    syntheticApiKey: maskConfigValue(config.syntheticApiKey),
    exaApiKey: maskConfigValue(config.exaApiKey),
    braveApiKey: maskConfigValue(config.braveApiKey),
  };
}

function statusSymbol(status: RunRecord["status"]): string {
  if (status === "complete") {
    return "✓";
  }
  if (status === "error") {
    return "✗";
  }
  return "⋯";
}

export function formatElapsed(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) {
    return `${hours}h ${minutes}m`;
  }
  if (minutes > 0) {
    return `${minutes}m ${seconds}s`;
  }
  return `${seconds}s`;
}

export function truncateQuery(query: string, maxChars = 60): string {
  const normalized = query.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxChars) {
    return normalized;
  }
  return `${normalized.slice(0, maxChars - 1)}…`;
}

const ROOT_COMMANDS = new Set([
  "run",
  "history",
  "view",
  "delete",
  "web",
  "config",
  "persona",
  "help",
]);

const RUN_BOOLEAN_OPTIONS = new Set(["--agent-mode", "--json", "-h", "--help"]);
const RUN_VALUE_OPTIONS = new Set([
  "-a",
  "--agents",
  "-c",
  "--concurrency",
  "-d",
  "--debate-rounds",
  "--model",
  "-o",
  "--output",
]);

function isRecognizedRunOptionToken(token: string): { known: boolean; takesValue: boolean } {
  if (RUN_BOOLEAN_OPTIONS.has(token)) {
    return { known: true, takesValue: false };
  }

  if (RUN_VALUE_OPTIONS.has(token)) {
    return { known: true, takesValue: true };
  }

  if (token.startsWith("-") && !token.startsWith("--") && token.length > 2) {
    const shortOption = token.slice(0, 2);
    if (RUN_VALUE_OPTIONS.has(shortOption)) {
      // support compact short options like -a5, -d3, -oout.txt during bare-run normalization.
      return { known: true, takesValue: false };
    }
  }

  if (!token.startsWith("--")) {
    return { known: false, takesValue: false };
  }

  const separatorIndex = token.indexOf("=");
  if (separatorIndex <= 2) {
    return { known: false, takesValue: false };
  }

  const optionName = token.slice(0, separatorIndex);
  if (RUN_VALUE_OPTIONS.has(optionName)) {
    return { known: true, takesValue: false };
  }

  return { known: false, takesValue: false };
}

function isSingleEditOrSwapAway(input: string, target: string): boolean {
  if (input === target) {
    return false;
  }

  if (Math.abs(input.length - target.length) > 1) {
    return false;
  }

  if (input.length === target.length) {
    let mismatchIndex = -1;
    for (let index = 0; index < input.length; index += 1) {
      if (input[index] !== target[index]) {
        mismatchIndex = index;
        break;
      }
    }

    if (mismatchIndex === -1) {
      return false;
    }

    if (input.slice(mismatchIndex + 1) === target.slice(mismatchIndex + 1)) {
      return true;
    }

    return (
      mismatchIndex + 1 < input.length &&
      input[mismatchIndex] === target[mismatchIndex + 1] &&
      input[mismatchIndex + 1] === target[mismatchIndex] &&
      input.slice(mismatchIndex + 2) === target.slice(mismatchIndex + 2)
    );
  }

  const shorter = input.length < target.length ? input : target;
  const longer = input.length < target.length ? target : input;
  for (let index = 0; index < shorter.length; index += 1) {
    if (shorter[index] !== longer[index]) {
      return shorter.slice(index) === longer.slice(index + 1);
    }
  }

  return true;
}

function isLikelyRootCommandTypo(token: string): boolean {
  if (/\s/.test(token)) {
    return false;
  }

  const normalized = token.toLowerCase();
  if (ROOT_COMMANDS.has(normalized)) {
    return false;
  }

  for (const commandName of ROOT_COMMANDS) {
    if (isSingleEditOrSwapAway(normalized, commandName)) {
      return true;
    }
  }

  return false;
}

function shouldRewriteAsBareRun(argv: string[]): boolean {
  const [queryToken, ...rest] = argv;
  if (!queryToken) {
    return false;
  }

  if (rest.length === 0) {
    return true;
  }

  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index];
    if (!token || !token.startsWith("-")) {
      return false;
    }

    const { known, takesValue } = isRecognizedRunOptionToken(token);
    const nextToken = rest[index + 1];
    if (takesValue && nextToken && !nextToken.startsWith("-")) {
      index += 1;
      continue;
    }

    if (!known && nextToken && !nextToken.startsWith("-")) {
      // Unknown options are still treated as run flags so the run parser can emit a precise error.
      index += 1;
    }
  }

  return true;
}

export function normalizeArgvForBareRun(argv: string[]): string[] {
  if (argv.length < 3) {
    return argv;
  }

  const firstArg = argv[2];
  const normalizedFirstArg = firstArg?.toLowerCase();
  if (!firstArg || firstArg.startsWith("-")) {
    return argv;
  }

  if (normalizedFirstArg && ROOT_COMMANDS.has(normalizedFirstArg)) {
    if (normalizedFirstArg === firstArg) {
      return argv;
    }
    return [argv[0], argv[1], normalizedFirstArg, ...argv.slice(3)];
  }

  const bareRunArgs = argv.slice(2);
  if (isLikelyRootCommandTypo(firstArg)) {
    return argv;
  }

  if (!shouldRewriteAsBareRun(bareRunArgs)) {
    return argv;
  }

  return [argv[0], argv[1], "run", ...argv.slice(2)];
}

function printRunErrorGuidance(message: string): void {
  const normalized = message.toLowerCase();

  if (normalized.includes("524")) {
    console.error("Tip: Synthetic.new timed out. Try again or reduce --agents.");
    return;
  }

  if (
    normalized.includes("all agents failed") ||
    /all\s+\w+\s+agents failed/.test(normalized)
  ) {
    console.error("Tip: Check your API key with 'hydra config show'.");
  }
}

function parseJsonLine(value: string) {
  try {
    return JSON.stringify(JSON.parse(value), null, 2);
  } catch {
    return value;
  }
}

function slugifyPersonaId(value: string): string {
  return value.trim()
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9-]/g, "");
}

const runCommand = new Command("run")
  .description("run a hydra query")
  .argument("<query>", "query to process")
  .option("-a, --agents <count>", "number of agents")
  .option("-c, --concurrency <count>", "max concurrency (1-5, default 5)")
  .option(
    "-d, --debate-rounds <n>",
    `debate rounds for this run (${MIN_DEBATE_ROUNDS}-${MAX_DEBATE_ROUNDS})`,
  )
  .option("--model <model>", "model override for this run")
  .option("--custom-personas-only", "use only custom personas (and generate ephemeral personas if needed)")
  .option("-o, --output <file>", "write full synthesis output to file")
  .option("--agent-mode", "emit machine-friendly logs")
  .option("--json", "emit json payload")
.action(async (query: string, options) => {
    const baseConfig = loadConfig();
    const resolvedConcurrency = options.concurrency
      ? clampInt(options.concurrency, 1, 5, baseConfig.maxConcurrency)
      : baseConfig.maxConcurrency;
    const resolvedDebateRounds = options.debateRounds
      ? clampInt(
        options.debateRounds,
        MIN_DEBATE_ROUNDS,
        MAX_DEBATE_ROUNDS,
        baseConfig.debateRounds,
      )
      : baseConfig.debateRounds;
    const resolvedModel = typeof options.model === "string" && options.model.trim().length > 0
      ? options.model.trim()
      : baseConfig.model;
    const resolvedCustomPersonasOnly = options.customPersonasOnly
      ? true
      : baseConfig.customPersonasOnly;
    const config = {
      ...baseConfig,
      maxConcurrency: resolvedConcurrency,
      debateRounds: resolvedDebateRounds,
      model: resolvedModel,
      customPersonasOnly: resolvedCustomPersonasOnly,
    };

    const modelApiKey = resolveLlmApiKey(config);
    const searchConfig = resolveSearchConfig(config);
    const searchApiKey = resolveSearchApiKey(config);

    if (!modelApiKey) {
      console.error("[hydra] warning: no api-key configured. run calls may fail.");
    }

    if (!searchApiKey) {
      console.error(
        `[hydra] warning: no search API key configured for provider ${searchConfig.provider}. search calls may fail.`,
      );
    }

    if (!config.syntheticApiKey) {
      console.error(
        "[hydra] warning: no synthetic-api-key configured. synthetic search may be unavailable for synthetic provider.",
      );
    }

    const agentCount = clampInt(
      options.agents ?? config.defaultAgentCount,
      1,
      20,
      config.defaultAgentCount,
    );
    const pipelineConfig: PipelineConfig = {
      apiKey: modelApiKey,
      baseUrl: config.baseUrl,
      model: resolvedModel,
      orchestratorModel: config.orchestratorModel ?? resolvedModel,
      researchModel: config.researchModel ?? resolvedModel,
      searchConfig,
      agentCount,
      maxConcurrency: config.maxConcurrency,
      debateRounds: config.debateRounds,
      searchEnabled: config.searchEnabled,
      customPersonasOnly: config.customPersonasOnly,
    };

    const pipeline = new HydraPipeline(pipelineConfig);
    const shouldUseTui =
    !options.json && !options.agentMode && process.stdout.isTTY === true && process.stderr.isTTY === true;
    let useAgentProgress = options.agentMode || !shouldUseTui;
    type HydraUILike = {
      start: (query: string, agentCount: number) => Promise<void>;
      handleEvent: (event: PipelineEvent) => void;
      stop: (brief?: string) => void;
    };
    let ui: HydraUILike | null = null;

  if (shouldUseTui) {
    try {
      const tuiModule = await import("./ui/tui");
      ui = new tuiModule.HydraUI({
        concurrency: config.maxConcurrency,
        totalDebateRounds: config.debateRounds,
      });
      await ui.start(query, agentCount);
      useAgentProgress = false;
    } catch (error) {
      ui?.stop();
      const message = error instanceof Error ? error.message : "unknown tui initialization error";
      console.error(
        `[hydra] warning: failed to initialize TUI, falling back to non-interactive progress: ${message}`,
      );
      ui = null;
      useAgentProgress = true;
    }
  }

  if (!options.json) {
    setAgentModeDebateRounds(config.debateRounds);
    setAgentModeConcurrency(config.maxConcurrency);

      if (useAgentProgress) {
        pipeline.on("run-created", emitAgentProgress);
        pipeline.on("run-status-changed", emitAgentProgress);
        pipeline.on("agent-progress", emitAgentProgress);
        pipeline.on("agent-complete", emitAgentProgress);
        pipeline.on("run-complete", emitAgentProgress);
      }

      if (ui) {
        const activeUi = ui;
        pipeline.on("run-created", (event) => {
          if (event.type === "run-created") {
            activeUi.handleEvent(event);
          }
        });
        pipeline.on("run-status-changed", (event) => {
          if (event.type === "run-status-changed") {
            activeUi.handleEvent(event);
          }
        });
        pipeline.on("agent-progress", (event) => {
          if (event.type === "agent-progress") {
            activeUi.handleEvent(event);
          }
        });
        pipeline.on("agent-complete", (event) => {
          if (event.type === "agent-complete") {
            activeUi.handleEvent(event);
          }
        });
        pipeline.on("run-complete", (event) => {
          if (event.type === "run-complete") {
            activeUi.handleEvent(event);
          }
        });
      }
    }

    let result: { runId: string; brief: string } | null = null;
    try {
      result = await pipeline.run(query);
    } catch (error) {
      ui?.stop();
      const message = error instanceof Error ? error.message : "pipeline failed";
      console.error(`[hydra] error: ${message}`);
      printRunErrorGuidance(message);
      process.exitCode = 1;
      return;
    }

    if (!result) {
      return;
    }

    const outputPath = typeof options.output === "string" && options.output.trim().length > 0
      ? options.output.trim()
      : null;
    if (outputPath) {
      try {
        writeFileSync(outputPath, result.brief, "utf8");
      } catch (error) {
        const message = error instanceof Error ? error.message : "unknown error";
        ui?.stop();
        console.error("Error: could not write to file:", message);
        process.exitCode = 1;
        return;
      }
    }

    if (options.json) {
      const finishedRun = getRun(result.runId);
      const agentRuns = finishedRun ? getRunAgentRuns(finishedRun.id) : [];
      console.log(
        JSON.stringify(
          {
            runId: result.runId,
            query,
            agentCount: finishedRun?.agentCount ?? agentCount,
            elapsedMs: finishedRun?.elapsedMs ?? 0,
            synthesis: result.brief,
            agents: agentRuns.map((agentRun) => ({
              persona: agentRun.persona,
              phase: agentRun.phase,
              output: agentRun.output,
            })),
          },
          null,
          2,
        ),
      );
      if (outputPath) {
        console.error(`Saved to ${outputPath}`);
      }
      return;
    }

    if (ui) {
      ui.stop(result.brief);
    } else {
      console.log("\nbrief:");
      console.log(result.brief);
    }
    if (outputPath) {
      console.log(`Saved to ${outputPath}`);
    }
  });

const historyCommand = new Command("history")
  .description("list past runs")
  .option("--limit <n>", "max rows to show")
  .action((options) => {
    const limit = clampInt(options.limit ?? 30, 1, 200, 30);
    const runs = listRuns(limit);
    if (runs.length === 0) {
      console.log("no runs found");
      return;
    }

    const now = Date.now();
    const rows = runs.map((run) => {
      const elapsedMs =
        run.elapsedMs ??
        (run.status === "complete" || run.status === "error"
          ? Math.max(0, (run.completedAt ?? run.createdAt) - run.createdAt)
          : Math.max(0, now - run.createdAt));

      return {
        status: `${statusSymbol(run.status)} ${run.status}`,
        runId: run.id,
        createdAt: new Date(run.createdAt).toISOString(),
        agents: String(run.agentCount),
        elapsed: formatElapsed(elapsedMs),
        query: truncateQuery(run.query, 60),
      };
    });

    const statusWidth = Math.max("status".length, ...rows.map((row) => row.status.length));
    const runIdWidth = Math.max("run-id".length, ...rows.map((row) => row.runId.length));
    const createdAtWidth = Math.max("created-at".length, ...rows.map((row) => row.createdAt.length));
    const agentsWidth = Math.max("agents".length, ...rows.map((row) => row.agents.length));
    const elapsedWidth = Math.max("elapsed".length, ...rows.map((row) => row.elapsed.length));

    console.log(
      [
        "status".padEnd(statusWidth),
        "run-id".padEnd(runIdWidth),
        "created-at".padEnd(createdAtWidth),
        "agents".padStart(agentsWidth),
        "elapsed".padStart(elapsedWidth),
        "query",
      ].join(" | "),
    );

    for (const row of rows) {
      console.log(
        [
          row.status.padEnd(statusWidth),
          row.runId.padEnd(runIdWidth),
          row.createdAt.padEnd(createdAtWidth),
          row.agents.padStart(agentsWidth),
          row.elapsed.padStart(elapsedWidth),
          row.query,
        ].join(" | "),
      );
    }
  });

const viewCommand = new Command("view")
  .description("view a past run")
  .argument("<runId>", "run id")
  .option("--transcripts", "show agent transcripts")
  .action((runId: string, options) => {
    const run = getRun(runId);
    if (!run) {
      throw new Error(`run ${runId} not found`);
    }

    console.log(`id: ${run.id}`);
    console.log(`status: ${run.status}`);
    console.log(`query: ${run.query}`);
    console.log(`createdAt: ${new Date(run.createdAt).toISOString()}`);

    if (run.error) {
      console.log(`error: ${run.error}`);
    }
    if (run.brief) {
      console.log("\nbrief:");
      console.log(run.brief);
    }

    if (options.transcripts) {
      const transcripts = getRunAgentRuns(run.id);
      console.log(`\nagent_runs: ${transcripts.length}`);
      for (const transcript of transcripts) {
        console.log(`\n-- ${transcript.persona} [${transcript.phase}]`);
        console.log(`status: ${transcript.status}`);
        console.log(`started: ${new Date(transcript.startedAt).toISOString()}`);
        if (transcript.output) {
          console.log(parseJsonLine(transcript.output));
        }
      }
    }
  });

const deleteCommand = new Command("delete")
  .description("delete a run")
  .argument("<runId>", "run id")
  .action((runId: string) => {
    const success = removeRun(runId);
    if (!success) {
      throw new Error(`run ${runId} not found`);
    }
    console.log(`deleted ${runId}`);
  });

const personaListCommand = new Command("list")
  .description("list built-in and custom personas")
  .option("--json", "output personas as json")
  .action((options) => {
    const builtinPersonaIds = new Set(PERSONAS.map((persona) => persona.id));
    const personas = allPersonas();
    if (options.json) {
      console.log(JSON.stringify(personas, null, 2));
      return;
    }

    for (const persona of personas) {
      const type = builtinPersonaIds.has(persona.id) ? "builtin" : "custom";
      console.log(`[${type}] ${persona.id}  ${persona.name} — ${persona.description}`);
    }
  });

const personaAddCommand = new Command("add")
  .description("add a custom persona")
  .requiredOption("--name <name>", "persona name")
  .requiredOption("--description <desc>", "persona description")
  .requiredOption("--methodology <methodology>", "persona methodology")
  .option("--id <id>", "custom persona id")
  .action((options) => {
    const id = options.id?.trim() || slugifyPersonaId(options.name);
    const persona = {
      id,
      name: options.name,
      description: options.description,
      methodology: options.methodology,
    };
    const result = addCustomPersona(persona);
    if (result.error) {
      throw new Error(result.error);
    }
    console.log(`added persona ${id}`);
  });

const personaRemoveCommand = new Command("remove")
  .description("remove a custom persona")
  .argument("<id>", "custom persona id")
  .action((id: string) => {
    if (PERSONAS.some((persona) => persona.id === id)) {
      throw new Error(`cannot remove builtin persona ${id}`);
    }
    const removed = removeCustomPersona(id);
    if (!removed) {
      throw new Error(`persona ${id} not found`);
    }
    console.log(`removed persona ${id}`);
  });

const personaCommand = new Command("persona")
  .description("manage personas")
  .addCommand(personaListCommand)
  .addCommand(personaAddCommand)
  .addCommand(personaRemoveCommand);

const webCommand = new Command("web")
  .description("launch local web UI")
  .option("--port <n>", "port to listen on", "3737")
  .action(async (options) => {
    const port = clampInt(options.port, 1024, 65535, 3737);
    const { startWebServer } = await import("./web/index");
    await startWebServer(port);
  });

const configShowCommand = new Command("show").action(() => {
  const config = loadConfig();
  console.log(JSON.stringify(createMaskedConfig(config), null, 2));
});

const configSetCommand = new Command("set")
  .description("set a config value")
  .argument(
    "<key>",
    "api-key | synthetic-api-key | search-provider | exa-api-key | brave-api-key | model | orchestrator-model | research-model | base-url | default-agent-count | max-concurrency | debate-rounds | search-enabled | custom-personas-only",
  )
  .argument("<value>")
  .action((key: string, rawValue: string) => {
    const mapped = configKeyMap[key];
    if (!mapped) {
      throw new Error(
        "invalid key. valid keys: api-key, synthetic-api-key, search-provider, exa-api-key, brave-api-key, model, orchestrator-model, research-model, base-url, default-agent-count, max-concurrency, debate-rounds, search-enabled, custom-personas-only",
      );
    }

    const parsed = sanitizeConfigValueForSet(mapped, rawValue);
    if (parsed.error || parsed.value === undefined) {
      throw new Error(parsed.error ?? "invalid value");
    }

    const config = writeConfig({ [mapped]: parsed.value } as Partial<HydraConfig>);
    const safeConfig = createMaskedConfig(config);
    console.log(`updated ${key}`);
    console.log(JSON.stringify(safeConfig, null, 2));
  });

const configCommand = new Command("config")
  .description("manage local hydra config")
  .addCommand(configShowCommand)
  .addCommand(configSetCommand);

command.addCommand(runCommand);
command.addCommand(historyCommand);
command.addCommand(viewCommand);
command.addCommand(deleteCommand);
command.addCommand(personaCommand);
command.addCommand(webCommand);
command.addCommand(configCommand);

if (import.meta.main) {
  (async () => {
    await command.parseAsync(normalizeArgvForBareRun(process.argv));
  })().catch((e) => {
    console.error(e);
    process.exitCode = 1;
  });
}
