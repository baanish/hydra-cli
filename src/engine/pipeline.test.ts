import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { PersonaConfig } from "../types";
import type { ModelRunResult } from "./model";
import { getPersonasFile, setPersonasFile } from "./personas";
import { HydraPipeline, type PipelineDependencies } from "./pipeline";

type ModelStep =
  | {
      kind: "resolve";
      output: string;
      searchQueries?: string[];
      promptTokens?: number;
      completionTokens?: number;
    }
  | {
      kind: "reject";
      error: Error;
    };

const TEST_PERSONAS: PersonaConfig[] = [
  {
    id: "skeptic",
    name: "The Skeptic",
    description: "skeptical",
    methodology: "method-a",
  },
  {
    id: "historian",
    name: "The Historian",
    description: "historical",
    methodology: "method-b",
  },
  {
    id: "technical-analyst",
    name: "The Technical Analyst",
    description: "technical",
    methodology: "method-c",
  },
];
const originalDateNow = Date.now;

function resolveStep(
  output: string,
  searchQueries: string[] = [],
  promptTokens = 1,
  completionTokens = 1,
): ModelStep {
  return {
    kind: "resolve",
    output,
    searchQueries,
    promptTokens,
    completionTokens,
  };
}

function rejectStep(message: string): ModelStep {
  return {
    kind: "reject",
    error: new Error(message),
  };
}

function decomposeAssignmentsOutput(): string {
  return JSON.stringify(
    TEST_PERSONAS.map((persona, index) => ({
      persona: persona.name,
      subQuestion: `sub-question-${index + 1}`,
      methodology: persona.methodology,
    })),
  );
}

function customDecomposeAssignmentsOutput(personas: PersonaConfig[]): string {
  return JSON.stringify(
    personas.map((persona, index) => ({
      persona: persona.name,
      subQuestion: `custom-sub-question-${index + 1}`,
      methodology: persona.methodology,
    })),
  );
}

function createHarness(steps: ModelStep[]) {
  const modelSteps = [...steps];
  const runs = new Map<string, ReturnType<PipelineDependencies["createRun"]>>();
  const agents = new Map<string, ReturnType<PipelineDependencies["createAgentRun"]>>();
  const runFailures: string[] = [];
  const runCompletions: string[] = [];
  const addTokenUsageCalls: Array<Parameters<PipelineDependencies["addTokenUsage"]>> = [];
  const modelInputs: Array<{ systemPrompt: string; userPrompt: string }> = [];
  let runSeq = 0;
  let agentSeq = 0;

  const deps: PipelineDependencies = {
    personas: TEST_PERSONAS,
    runModel: async (
      input: Parameters<PipelineDependencies["runModel"]>[0],
    ): Promise<ModelRunResult> => {
      modelInputs.push({
        systemPrompt: input.systemPrompt,
        userPrompt: input.userPrompt,
      });
      input.onExecutionStart?.(Date.now());
      const step = modelSteps.shift();
      if (!step) {
        throw new Error("missing model step");
      }
      if (step.kind === "reject") {
        throw step.error;
      }
      return {
        output: step.output,
        messages: [],
        searchQueries: step.searchQueries ?? [],
        promptTokens: step.promptTokens ?? 1,
        completionTokens: step.completionTokens ?? 1,
        executionStartedAt: Date.now(),
      };
    },
    runWithConcurrency: async <T, R>(
      items: T[],
      _concurrency: number,
      fn: (item: T, index: number) => Promise<R>,
    ): Promise<R[]> => {
      const output: R[] = [];
      for (let index = 0; index < items.length; index += 1) {
        const item = items[index];
        if (item === undefined) {
          throw new Error(`missing item at index ${index}`);
        }
        output.push(await fn(item, index));
      }
      return output;
    },
    createRun: (input: Parameters<PipelineDependencies["createRun"]>[0]) => {
      const id = `run-${++runSeq}`;
      const run: ReturnType<PipelineDependencies["createRun"]> = {
        id,
        query: input.query,
        agentCount: input.agentCount,
        status: input.status ?? "decomposing",
        brief: null,
        error: null,
        pipelineState: input.pipelineState ?? null,
        totalPromptTokens: 0,
        totalCompletionTokens: 0,
        createdAt: Date.now(),
        completedAt: null,
        elapsedMs: null,
      };
      runs.set(id, run);
      return run;
    },
    createAgentRun: (input: Parameters<PipelineDependencies["createAgentRun"]>[0]) => {
      const id = `agent-${++agentSeq}`;
      const record: ReturnType<PipelineDependencies["createAgentRun"]> = {
        id,
        runId: input.runId,
        phase: input.phase,
        persona: input.persona,
        systemPrompt: input.systemPrompt,
        messages: input.messages ?? "[]",
        output: input.output ?? "",
        searchQueries: JSON.stringify(input.searchQueries ?? []),
        status: input.status ?? "queued",
        promptTokens: input.promptTokens ?? 0,
        completionTokens: input.completionTokens ?? 0,
        startedAt: input.startedAt ?? Date.now(),
        completedAt: input.completedAt ?? null,
      };
      agents.set(id, record);
      return record;
    },
    updateAgentRun: (
      agentRunId: Parameters<PipelineDependencies["updateAgentRun"]>[0],
      patch: Parameters<PipelineDependencies["updateAgentRun"]>[1],
    ) => {
      const current = agents.get(agentRunId);
      if (!current) {
        throw new Error(`agent ${agentRunId} not found`);
      }
      const updated: ReturnType<PipelineDependencies["createAgentRun"]> = {
        ...current,
        ...(patch as object),
        searchQueries: patch.searchQueries
          ? JSON.stringify(patch.searchQueries)
          : current.searchQueries,
      };
      agents.set(agentRunId, updated);
      return updated;
    },
    completeAgentRun: (
      agentRunId: Parameters<PipelineDependencies["completeAgentRun"]>[0],
      output: Parameters<PipelineDependencies["completeAgentRun"]>[1],
      options?: Parameters<PipelineDependencies["completeAgentRun"]>[2],
    ) => {
      const current = agents.get(agentRunId);
      if (!current) {
        throw new Error(`agent ${agentRunId} not found`);
      }
      const updated: ReturnType<PipelineDependencies["createAgentRun"]> = {
        ...current,
        output,
        status: options?.status ?? "complete",
        searchQueries: JSON.stringify(options?.searchQueries ?? []),
        promptTokens: options?.promptTokens ?? 0,
        completionTokens: options?.completionTokens ?? 0,
        completedAt: Date.now(),
      };
      agents.set(agentRunId, updated);
      return updated;
    },
    updateRunStatus: (
      runId: Parameters<PipelineDependencies["updateRunStatus"]>[0],
      patch: Parameters<PipelineDependencies["updateRunStatus"]>[1],
    ) => {
      const current = runs.get(runId);
      if (!current) {
        throw new Error(`run ${runId} not found`);
      }
      const updated = {
        ...current,
        ...(patch as object),
      };
      runs.set(runId, updated);
      return updated;
    },
    markRunComplete: (runId: string, brief: string) => {
      const current = runs.get(runId);
      if (!current) {
        throw new Error(`run ${runId} not found`);
      }
      const updated: ReturnType<PipelineDependencies["createRun"]> = {
        ...current,
        status: "complete",
        brief,
        completedAt: Date.now(),
        elapsedMs: 123,
      };
      runs.set(runId, updated);
      runCompletions.push(brief);
      return updated;
    },
    markRunFailed: (runId: string, error: string) => {
      const current = runs.get(runId);
      if (!current) {
        throw new Error(`run ${runId} not found`);
      }
      const updated: ReturnType<PipelineDependencies["createRun"]> = {
        ...current,
        status: "error",
        error,
        completedAt: Date.now(),
        elapsedMs: 123,
      };
      runs.set(runId, updated);
      runFailures.push(error);
      return updated;
    },
    addTokenUsage: (...args) => {
      addTokenUsageCalls.push(args);
    },
  };

  return {
    deps,
    runFailures,
    runCompletions,
    addTokenUsageCalls,
    modelInputs,
  };
}

function createPipelineConfig(debateRounds = 1, customPersonasOnly = false, agentCount = TEST_PERSONAS.length) {
  return {
    apiKey: "api-key",
    baseUrl: "https://example.invalid/v1",
    model: "hf:test/model",
    searchConfig: {
      provider: "synthetic" as const,
      syntheticApiKey: "synthetic-key",
      exaApiKey: "",
      braveApiKey: "",
    },
    agentCount,
    maxConcurrency: 1,
    debateRounds,
    searchEnabled: false,
    customPersonasOnly,
  };
}

const DEFAULT_PERSONAS_FILE = getPersonasFile();
let tempDir = "";
let tempPersonasFile = "";

function setCustomPersonas(personas: PersonaConfig[]): void {
  writeFileSync(tempPersonasFile, JSON.stringify(personas, null, 2), "utf8");
}

beforeEach(() => {
  // deterministic timestamps for cleaner assertions
  let now = 10_000;
  Date.now = () => now++;

  tempDir = mkdtempSync(join(tmpdir(), "hydra-persona-pool-"));
  tempPersonasFile = join(tempDir, "personas.json");
  setPersonasFile(tempPersonasFile);
});

afterEach(() => {
  Date.now = originalDateNow;
  setPersonasFile(DEFAULT_PERSONAS_FILE);
  rmSync(tempDir, { recursive: true, force: true });
});

describe("HydraPipeline", () => {
  test("successful run emits lifecycle events", async () => {
    const harness = createHarness([
      resolveStep(decomposeAssignmentsOutput()),
      resolveStep("research-a"),
      resolveStep("research-b"),
      resolveStep("research-c"),
      resolveStep("debate-a"),
      resolveStep("debate-b"),
      resolveStep("debate-c"),
      resolveStep("final synthesis"),
    ]);

    const pipeline = new HydraPipeline(createPipelineConfig(1), harness.deps);
    const events: string[] = [];
    const statuses: string[] = [];

    pipeline.on("run-created", () => {
      events.push("run-created");
    });
    pipeline.on("run-complete", () => {
      events.push("run-complete");
    });
    pipeline.on("run-status-changed", (event: { status: string }) => {
      statuses.push(event.status);
    });

    const result = await pipeline.run("explain the transition");

    expect(result.brief).toBe("final synthesis");
    expect(events).toContain("run-created");
    expect(events).toContain("run-complete");
    expect(statuses).toEqual(["researching", "debating", "synthesizing"]);
    expect(harness.runCompletions).toEqual(["final synthesis"]);
    expect(harness.addTokenUsageCalls).toHaveLength(8);
    expect(
      harness.addTokenUsageCalls.reduce((sum, [, promptTokens]) => sum + promptTokens, 0),
    ).toBe(8);
    expect(
      harness.addTokenUsageCalls.reduce((sum, [, , completionTokens]) => sum + completionTokens, 0),
    ).toBe(8);
  });

  test("throws when all research agents fail", async () => {
    const harness = createHarness([
      resolveStep(decomposeAssignmentsOutput()),
      rejectStep("r1 failed"),
      rejectStep("r2 failed"),
      rejectStep("r3 failed"),
    ]);

    const pipeline = new HydraPipeline(createPipelineConfig(1), harness.deps);

    await expect(pipeline.run("q")).rejects.toThrow("research phase failed: 0/3 agents succeeded");
    expect(harness.runFailures.at(-1)).toBe("research phase failed: 0/3 agents succeeded");
    expect(harness.addTokenUsageCalls).toHaveLength(1);
    expect(harness.addTokenUsageCalls[0]?.[1]).toBe(1);
    expect(harness.addTokenUsageCalls[0]?.[2]).toBe(1);
  });

  test("sanitizes persona names in research failure logs", async () => {
    const originalConsoleError = console.error;
    const loggedLines: string[] = [];
    console.error = (...args: unknown[]) => {
      loggedLines.push(String(args[0] ?? ""));
    };

    try {
      const unsafePersona: PersonaConfig = {
        id: "unsafe-research",
        name: "Unsafe\x1b[31mPersona",
        description: "custom",
        methodology: "custom method",
      };
      const harness = createHarness([
        resolveStep(customDecomposeAssignmentsOutput([unsafePersona])),
        rejectStep("research exploded"),
      ]);

      const pipeline = new HydraPipeline(
        createPipelineConfig(1, false, 1),
        { ...harness.deps, personas: [unsafePersona] },
      );

      await expect(pipeline.run("q")).rejects.toThrow(
        "research phase failed: 0/1 agents succeeded",
      );

      expect(loggedLines.some((line) => line.includes("\x1b"))).toBe(false);
      expect(loggedLines.some((line) => line.includes("\r"))).toBe(false);
      expect(
        loggedLines.some((line) =>
          line.includes("[hydra] research agent failed for UnsafePersona:")),
      ).toBe(true);
    } finally {
      console.error = originalConsoleError;
    }
  });

  test("sanitizes upstream error payloads in research failure logs", async () => {
    const originalConsoleError = console.error;
    const loggedLines: string[] = [];
    console.error = (...args: unknown[]) => {
      loggedLines.push(String(args[0] ?? ""));
    };

    try {
      const unsafePersona: PersonaConfig = {
        id: "unsafe-error",
        name: "Safe Persona",
        description: "custom",
        methodology: "custom method",
      };
      const harness = createHarness([
        resolveStep(customDecomposeAssignmentsOutput([unsafePersona])),
        rejectStep("boom\x1b[31mred\r\nnext"),
      ]);

      const pipeline = new HydraPipeline(
        createPipelineConfig(1, false, 1),
        { ...harness.deps, personas: [unsafePersona] },
      );

      await expect(pipeline.run("q")).rejects.toThrow(
        "research phase failed: 0/1 agents succeeded",
      );

      expect(loggedLines.some((line) => line.includes("\x1b"))).toBe(false);
      expect(loggedLines.some((line) => line.includes("\r"))).toBe(false);
      expect(
        loggedLines.some((line) =>
          line.includes("[hydra] research agent failed for Safe Persona: boomred next"),
        ),
      ).toBe(true);
    } finally {
      console.error = originalConsoleError;
    }
  });


  test("tolerates partial debate failures when at least two agents succeed", async () => {
    const harness = createHarness([
      resolveStep(decomposeAssignmentsOutput()),
      resolveStep("research-a"),
      resolveStep("research-b"),
      resolveStep("research-c"),
      resolveStep("debate-a"),
      rejectStep("debate-b failed"),
      resolveStep("debate-c"),
      resolveStep("synthesis after partial failure"),
    ]);

    const pipeline = new HydraPipeline(createPipelineConfig(1), harness.deps);
    const result = await pipeline.run("q");

    expect(result.brief).toBe("synthesis after partial failure");
    expect(harness.runFailures).toHaveLength(0);
    expect(harness.addTokenUsageCalls).toHaveLength(7);
  });

  test("fails debate round when fewer than two agents succeed", async () => {
    const harness = createHarness([
      resolveStep(decomposeAssignmentsOutput()),
      resolveStep("research-a"),
      resolveStep("research-b"),
      resolveStep("research-c"),
      resolveStep("debate-a"),
      rejectStep("debate-b failed"),
      rejectStep("debate-c failed"),
    ]);

    const pipeline = new HydraPipeline(createPipelineConfig(1), harness.deps);

    await expect(pipeline.run("q")).rejects.toThrow("debate round 1 failed: 1/3 agents succeeded");
    expect(harness.runFailures.at(-1)).toBe("debate round 1 failed: 1/3 agents succeeded");
    expect(harness.addTokenUsageCalls).toHaveLength(5);
  });

  test("sanitizes persona names in debate failure logs", async () => {
    const originalConsoleError = console.error;
    const loggedLines: string[] = [];
    console.error = (...args: unknown[]) => {
      loggedLines.push(String(args[0] ?? ""));
    };

    try {
      const unsafePersona: PersonaConfig = {
        id: "unsafe-debate",
        name: "Unsafe\x1b[31mDebater",
        description: "custom",
        methodology: "custom method",
      };
      const harness = createHarness([
        resolveStep(customDecomposeAssignmentsOutput([unsafePersona])),
        resolveStep("research-a"),
        rejectStep("debate exploded"),
      ]);

      const pipeline = new HydraPipeline(
        createPipelineConfig(1, false, 1),
        { ...harness.deps, personas: [unsafePersona] },
      );

      await expect(pipeline.run("q")).rejects.toThrow(
        "debate round 1 failed: 0/1 agents succeeded",
      );

      expect(loggedLines.some((line) => line.includes("\x1b"))).toBe(false);
      expect(
        loggedLines.some((line) =>
          line.includes("[hydra] debate agent failed for UnsafeDebater:")),
      ).toBe(true);
    } finally {
      console.error = originalConsoleError;
    }
  });

  test("allows single-agent debate rounds to complete", async () => {
    const singlePersona = TEST_PERSONAS[0];
    expect(singlePersona).toBeDefined();
    const harness = createHarness([
      resolveStep(decomposeAssignmentsOutput()),
      resolveStep("research-a"),
      resolveStep("debate-a"),
      resolveStep("single-agent synthesis"),
    ]);

    const pipeline = new HydraPipeline(
      {
        ...createPipelineConfig(1, false, 1),
        searchEnabled: false,
      },
      { ...harness.deps, personas: singlePersona ? [singlePersona] : [] },
    );

    const result = await pipeline.run("q");

    expect(result.brief).toBe("single-agent synthesis");
    expect(harness.runFailures).toHaveLength(0);
    expect(harness.addTokenUsageCalls).toHaveLength(4);
  });

  test("marks run failed when synthesizer step throws", async () => {
    const harness = createHarness([
      resolveStep(decomposeAssignmentsOutput()),
      resolveStep("research-a"),
      resolveStep("research-b"),
      resolveStep("research-c"),
      resolveStep("debate-a"),
      resolveStep("debate-b"),
      resolveStep("debate-c"),
      rejectStep("synthesis crashed"),
    ]);

    const pipeline = new HydraPipeline(createPipelineConfig(1), harness.deps);

    await expect(pipeline.run("q")).rejects.toThrow("synthesis crashed");
    expect(harness.runFailures.at(-1)).toBe("synthesis crashed");
    expect(harness.addTokenUsageCalls).toHaveLength(7);
  });

  test("uses only custom personas when custom-personas-only is enabled and enough custom personas exist", async () => {
    const customPersonas: PersonaConfig[] = [
      {
        id: "custom-alpha",
        name: "Custom Alpha",
        description: "maps risk with constraints",
        methodology: "custom method",
      },
      {
        id: "custom-beta",
        name: "Custom Beta",
        description: "finds execution details",
        methodology: "custom method",
      },
    ];
    setCustomPersonas(customPersonas);

    const harness = createHarness([
      resolveStep(customDecomposeAssignmentsOutput(customPersonas)),
      resolveStep("research-alpha"),
      resolveStep("research-beta"),
      resolveStep("debate-alpha"),
      resolveStep("debate-beta"),
      resolveStep("final synthesis"),
    ]);

    const pipeline = new HydraPipeline(
      createPipelineConfig(1, true, customPersonas.length),
      harness.deps,
    );

    await pipeline.run("what is custom enough");

    expect(harness.modelInputs[0]).toBeDefined();
    expect(harness.modelInputs[0]?.userPrompt).toContain("- Custom Alpha: maps risk with constraints");
    expect(harness.modelInputs[0]?.userPrompt).toContain("- Custom Beta: finds execution details");
    expect(harness.modelInputs[0]?.userPrompt).not.toContain("The Skeptic");
  });

  test("generates ephemeral personas to fill custom-personas-only shortfall", async () => {
    const customPersonas: PersonaConfig[] = [
      {
        id: "custom-only",
        name: "Custom Only",
        description: "exists for baseline",
        methodology: "baseline mode",
      },
    ];
    const ephemeralPersonas: PersonaConfig[] = [
      {
        id: "ephemeral-one",
        name: "Ephemeral Analyst",
        description: "fills missing perspective",
        methodology: "generated method",
      },
    ];
    setCustomPersonas(customPersonas);

    const harness = createHarness([
      resolveStep(JSON.stringify(ephemeralPersonas)),
      resolveStep(customDecomposeAssignmentsOutput([...customPersonas, ...ephemeralPersonas])),
      resolveStep("research-only"),
      resolveStep("research-ephemeral"),
      resolveStep("debate-only"),
      resolveStep("debate-ephemeral"),
      resolveStep("final synthesis"),
    ]);

    const pipeline = new HydraPipeline(createPipelineConfig(1, true, customPersonas.length + 1), harness.deps);
    await pipeline.run("fill missing personas for query");

    expect(harness.modelInputs[0]).toBeDefined();
    expect(harness.modelInputs[0]?.systemPrompt)
      .toBe("You are a persona designer. Return ONLY a valid JSON array of analyst personas.");
    expect(harness.modelInputs[0]?.userPrompt).toContain(
      'Generate 1 distinct analyst personas best suited to research: "fill missing personas for query"',
    );
    expect(harness.modelInputs).toHaveLength(7);
    expect(harness.modelInputs[1]).toBeDefined();
    expect(harness.modelInputs[1]?.userPrompt).toContain("- Ephemeral Analyst: fills missing perspective");
  });

  test("throws when custom-personas-only ends with an empty persona pool", async () => {
    const harness = createHarness([resolveStep("[]"), resolveStep("[]"), resolveStep("[]")]);

    const pipeline = new HydraPipeline(createPipelineConfig(1, true, 2), harness.deps);

    await expect(pipeline.run("fill none")).rejects.toThrow(
      "custom-personas-only mode requires at least 1 persona; define custom personas with `hydra persona add` or increase agent count",
    );
    expect(harness.runFailures.at(-1)).toBe(
      "custom-personas-only mode requires at least 1 persona; define custom personas with `hydra persona add` or increase agent count",
    );
    expect(harness.modelInputs).toHaveLength(3);
  });
});
