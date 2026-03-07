import { EventEmitter } from "node:events";

import {
  addTokenUsage,
  completeAgentRun,
  createAgentRun,
  createRun,
  markRunComplete,
  markRunFailed,
  updateAgentRun,
  updateRunStatus,
} from "../db/queries";
import type {
  AgentRunState,
  DecomposedAssignment,
  PersonaConfig,
  PipelineEvent,
  RunStatus,
  SearchConfig,
} from "../types";
import { runWithConcurrency } from "./concurrency";
import { type ModelRunResult, runModelWithOptionalTools } from "./model";
import {
  allPersonas,
  generateEphemeralPersonas,
  loadCustomPersonas,
} from "./personas";
import {
  DEBATE_PROMPT,
  ORCHESTRATOR_PROMPT,
  RESEARCH_PROMPT,
  SYNTHESIS_PROMPT,
} from "./prompts";

/** configuration passed to pipeline creation and used across all phases. */
export interface PipelineConfig {
  apiKey: string;
  baseUrl: string;
  model: string;
  orchestratorModel?: string;
  researchModel?: string;
  searchConfig: SearchConfig;
  agentCount: number;
  maxConcurrency: number;
  debateRounds: number;
  searchEnabled: boolean;
  customPersonasOnly: boolean;
}

export type PipelineDependencies = {
  runModel: typeof runModelWithOptionalTools;
  runWithConcurrency: typeof runWithConcurrency;
  personas: PersonaConfig[] | (() => PersonaConfig[]);
  createRun: typeof createRun;
  createAgentRun: typeof createAgentRun;
  completeAgentRun: typeof completeAgentRun;
  updateAgentRun: typeof updateAgentRun;
  updateRunStatus: typeof updateRunStatus;
  markRunComplete: typeof markRunComplete;
  markRunFailed: typeof markRunFailed;
  addTokenUsage: typeof addTokenUsage;
};

const DEFAULT_DEPENDENCIES: PipelineDependencies = {
  runModel: runModelWithOptionalTools,
  runWithConcurrency,
  personas: () => allPersonas(),
  createRun,
  createAgentRun,
  completeAgentRun,
  updateAgentRun,
  updateRunStatus,
  markRunComplete,
  markRunFailed,
  addTokenUsage,
};

type AssignedPersona = {
  assignment: DecomposedAssignment;
  persona: PersonaConfig;
};

type PersonaOutput = {
  persona: PersonaConfig;
  output: string;
  searchQueries: string[];
  status: "complete" | "error";
};

const MAX_DEBATE_CONTEXT_CHARS = 3200;

/** orchestrates a full hydra run across decomposition, research, debate, and synthesis. */
export class HydraPipeline extends EventEmitter {
  #config: PipelineConfig;
  #deps: PipelineDependencies;
  #orchestratorModel: string;
  #researchModel: string;
  #totalPromptTokens = 0;
  #totalCompletionTokens = 0;

  /** initialize pipeline with validated runtime configuration. */
  constructor(
    config: PipelineConfig,
    dependencies: Partial<PipelineDependencies> = {},
  ) {
    super();
    this.#config = config;
    this.#orchestratorModel = config.orchestratorModel ?? config.model;
    this.#researchModel = config.researchModel ?? config.model;
    this.#deps = {
      ...DEFAULT_DEPENDENCIES,
      ...dependencies,
    };
  }

  /** execute the full pipeline for a user query and return run metadata. */
  async run(query: string): Promise<{ runId: string; brief: string }> {
    this.#totalPromptTokens = 0;
    this.#totalCompletionTokens = 0;

    const run = this.#deps.createRun({
      query,
      agentCount: this.#config.agentCount,
      status: "decomposing",
      pipelineState: JSON.stringify({
        apiKeyConfigured: Boolean(this.#config.apiKey),
        searchProvider: this.#config.searchConfig.provider,
        concurrency: this.#config.maxConcurrency,
        debateRounds: this.#config.debateRounds,
      }),
    });

    const createdAt = Date.now();

    this.emit("run-created", {
      type: "run-created",
      runId: run.id,
      query: run.query,
      agentCount: run.agentCount,
      timestamp: createdAt,
    } satisfies PipelineEvent);

    try {
      let personas = this.resolvePersonas();
      let agentCount = this.#config.agentCount;
      if (this.#config.customPersonasOnly) {
        const customPersonas = loadCustomPersonas();
        if (customPersonas.length < agentCount) {
          const gap = agentCount - customPersonas.length;
          const generatedPersonas = await generateEphemeralPersonas(
            query,
            gap,
            async (systemPrompt, userPrompt) => {
              const result = await this.runModel({
                runId: run.id,
                model: this.#orchestratorModel,
                systemPrompt,
                userPrompt,
                allowTools: false,
              });
              return result.output;
            },
          );
          console.error(
            `[hydra] generated ${gap} ephemeral persona(s) to fill agent count`,
          );
          personas = [...customPersonas, ...generatedPersonas];
        } else {
          personas = customPersonas.slice(0, agentCount);
        }

        if (personas.length < 1) {
          throw new Error(
            "custom-personas-only mode requires at least 1 persona; define custom personas with `hydra persona add` or increase agent count",
          );
        }

        if (personas.length < agentCount) {
          console.error(
            `[hydra] persona pool has ${personas.length} persona(s); clamping agent count from ${agentCount} to ${personas.length}`,
          );
          agentCount = personas.length;
        }
      }

      const decomposedAssignments = await this.decompose(
        query,
        run.id,
        personas,
        agentCount,
      );
      const selectedPersonas = decomposedAssignments.map(
        ({ persona }) => persona,
      );

      this.setStatus(run.id, "researching");
      const researchOutputs = await this.runResearchPhase(
        run.id,
        decomposedAssignments,
      );
      const debateSeedOutputs = researchOutputs.filter(
        (item) =>
          typeof item.output === "string" && item.output.trim().length > 0,
      );
      const excludedResearchCount =
        researchOutputs.length - debateSeedOutputs.length;
      if (excludedResearchCount > 0) {
        console.warn(
          `[warn] ${excludedResearchCount} research agents returned empty output, excluding from debate`,
        );
      }

      this.setStatus(run.id, "debating");
      const debateOutputs = await this.runDebateRounds(
        run.id,
        query,
        selectedPersonas,
        debateSeedOutputs,
      );

      this.setStatus(run.id, "synthesizing");
      const brief = await this.synthesize(
        run.id,
        query,
        selectedPersonas,
        researchOutputs,
        debateOutputs,
      );

      const completedRun = this.#deps.markRunComplete(run.id, brief);
      this.emit("run-complete", {
        type: "run-complete",
        runId: completedRun.id,
        elapsedMs: completedRun.elapsedMs ?? Date.now() - createdAt,
        totalPromptTokens: completedRun.totalPromptTokens,
        totalCompletionTokens: completedRun.totalCompletionTokens,
        timestamp: Date.now(),
      } satisfies PipelineEvent);

      return { runId: completedRun.id, brief };
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "pipeline failed";
      const failedRun = this.#deps.markRunFailed(run.id, message);
      this.emit("run-status-changed", {
        type: "run-status-changed",
        runId: failedRun.id,
        status: failedRun.status,
        timestamp: Date.now(),
      } satisfies PipelineEvent);
      if (this.listenerCount("error") > 0) {
        this.emit("error", error);
      }
      throw error;
    }
  }

  private async decompose(
    query: string,
    runId: string,
    personas: PersonaConfig[],
    agentCount = this.#config.agentCount,
  ): Promise<AssignedPersona[]> {
    const personaLines = personas
      .map((persona) => `- ${persona.name}: ${persona.description}`)
      .join("\n");
    const decomposePrompt = [
      `You are an orchestrator choosing ${agentCount} specialists.`,
      "Choose the most relevant personas for this query.",
      `Available personas:\n${personaLines}`,
      `Query: ${query}`,
    ].join("\n");

    const result = await this.runModel({
      runId,
      model: this.#orchestratorModel,
      systemPrompt: ORCHESTRATOR_PROMPT,
      userPrompt: decomposePrompt,
      allowTools: false,
    });

    const parsedAssignments = this.parseAssignments(result.output);
    const resolvedAssignments = this.normalizeAssignments(
      parsedAssignments,
      personas,
      query,
      agentCount,
    );

    const usedPersonas = new Set<string>();
    return resolvedAssignments.map((assignment) => ({
      assignment,
      persona: this.resolvePersona(assignment, personas, usedPersonas),
    }));
  }

  private async runResearchPhase(
    runId: string,
    assignments: AssignedPersona[],
  ): Promise<PersonaOutput[]> {
    const phase = "research" as const;
    const workItems = assignments.map(({ assignment, persona }) => {
      const agentRun = this.#deps.createAgentRun({
        runId,
        phase,
        persona: persona.name,
        status: "queued",
        systemPrompt: RESEARCH_PROMPT(persona),
      });

      return {
        assignment,
        persona,
        agentRun,
      };
    });

    let completedAgents = 0;
    const totalAgents = workItems.length;
    const results = await this.#deps.runWithConcurrency(
      workItems,
      this.#config.maxConcurrency,
      async (item): Promise<PersonaOutput> => {
        try {
          let hasStarted = false;
          const markStarted = (executionStartedAt: number) => {
            if (hasStarted) {
              return;
            }
            hasStarted = true;
            this.#deps.updateAgentRun(item.agentRun.id, {
              status: "running",
              startedAt: executionStartedAt,
            });
          };

          const result = await this.runModel({
            runId,
            model: this.#researchModel,
            systemPrompt: RESEARCH_PROMPT(item.persona),
            userPrompt: this.formatCodeBlock(item.assignment.subQuestion),
            allowTools: this.#config.searchEnabled,
            maxToolCalls: 5,
            onExecutionStart: markStarted,
          });

          const completed = this.#deps.completeAgentRun(
            item.agentRun.id,
            result.output,
            {
              status: "complete",
              searchQueries: result.searchQueries,
              promptTokens: result.promptTokens,
              completionTokens: result.completionTokens,
            },
          );

          const state = this.toAgentState(completed);
          const event: PipelineEvent = {
            type: "agent-complete",
            runId,
            agentRunId: completed.id,
            persona: item.persona.name,
            phase,
            state,
            timestamp: Date.now(),
          };
          this.emit("agent-complete", event);

          completedAgents += 1;
          this.emit("agent-progress", {
            type: "agent-progress",
            runId,
            phase,
            completedAgents,
            totalAgents,
            timestamp: Date.now(),
          } satisfies PipelineEvent);

          return {
            persona: item.persona,
            output: result.output,
            searchQueries: result.searchQueries,
            status: "complete",
          };
        } catch (error) {
          const message =
            error instanceof Error ? error.message : "research agent failed";
          const completed = this.#deps.completeAgentRun(
            item.agentRun.id,
            message,
            {
              status: "error",
            },
          );

          const state = this.toAgentState(completed);
          const event: PipelineEvent = {
            type: "agent-complete",
            runId,
            agentRunId: completed.id,
            persona: item.persona.name,
            phase,
            state,
            timestamp: Date.now(),
          };
          this.emit("agent-complete", event);

          completedAgents += 1;
          this.emit("agent-progress", {
            type: "agent-progress",
            runId,
            phase,
            completedAgents,
            totalAgents,
            timestamp: Date.now(),
          } satisfies PipelineEvent);

          return {
            persona: item.persona,
            output: "",
            searchQueries: [],
            status: "error",
          };
        }
      },
    );

    const successfulOutputs = results.filter(
      (item): item is PersonaOutput =>
        item.status === "complete" &&
        typeof item.output === "string" &&
        item.output.trim().length > 0,
    );
    if (successfulOutputs.length === 0) {
      throw new Error(
        `research phase failed: ${successfulOutputs.length}/${totalAgents} agents succeeded`,
      );
    }

    return results;
  }

  private async runDebateRounds(
    runId: string,
    query: string,
    personas: PersonaConfig[],
    startingOutputs: PersonaOutput[],
  ): Promise<PersonaOutput[]> {
    let currentOutputs = [...startingOutputs];
    const rounds = Math.max(1, this.#config.debateRounds);

    for (let round = 1; round <= rounds; round++) {
      currentOutputs = await this.runDebateRound(
        runId,
        query,
        personas,
        currentOutputs,
        round,
      );
    }

    return currentOutputs;
  }

  private async runDebateRound(
    runId: string,
    query: string,
    personas: PersonaConfig[],
    previousOutputs: PersonaOutput[],
    round: number,
  ): Promise<PersonaOutput[]> {
    const phase = "debate" as const;
    const workItems = personas.map((persona) => {
      const successfulPeers = previousOutputs.filter(
        (item) =>
          item.persona.name !== persona.name &&
          item.status === "complete" &&
          item.output.trim().length > 0,
      );
      const fallbackPeers = previousOutputs.filter(
        (item) => item.persona.name !== persona.name,
      );
      const selectedPeers = [
        ...successfulPeers.slice(0, 2),
        ...fallbackPeers
          .filter((item) => successfulPeers.indexOf(item) === -1)
          .slice(0, Math.max(0, 2 - successfulPeers.length)),
      ].slice(0, 2);
      const agentRun = this.#deps.createAgentRun({
        runId,
        phase,
        persona: persona.name,
        status: "queued",
        systemPrompt: DEBATE_PROMPT(persona, round),
      });

      const priorFinding = previousOutputs.find(
        (item) => item.persona.name === persona.name,
      );
      const assignmentMessage = this.buildDebatePrompt(
        query,
        persona.name,
        priorFinding?.output ?? "",
        selectedPeers,
        round,
      );

      return {
        persona,
        agentRun,
        prompt: DEBATE_PROMPT(persona, round),
        assignmentMessage,
      };
    });

    let completedAgents = 0;
    const totalAgents = workItems.length;
    const results = await this.#deps.runWithConcurrency(
      workItems,
      this.#config.maxConcurrency,
      async (item): Promise<PersonaOutput> => {
        try {
          let hasStarted = false;
          const markStarted = (executionStartedAt: number) => {
            if (hasStarted) {
              return;
            }
            hasStarted = true;
            this.#deps.updateAgentRun(item.agentRun.id, {
              status: "running",
              startedAt: executionStartedAt,
            });
          };
          const result = await this.runModel({
            runId,
            model: this.#researchModel,
            systemPrompt: item.prompt,
            userPrompt: item.assignmentMessage,
            allowTools: false,
            onExecutionStart: markStarted,
          });

          const completed = this.#deps.completeAgentRun(
            item.agentRun.id,
            result.output,
            {
              status: "complete",
              searchQueries: result.searchQueries,
              promptTokens: result.promptTokens,
              completionTokens: result.completionTokens,
            },
          );

          const state = this.toAgentState(completed);
          this.emit("agent-complete", {
            type: "agent-complete",
            runId,
            agentRunId: completed.id,
            persona: item.persona.name,
            phase,
            state,
            timestamp: Date.now(),
          } satisfies PipelineEvent);

          completedAgents += 1;
          this.emit("agent-progress", {
            type: "agent-progress",
            runId,
            phase,
            completedAgents,
            totalAgents,
            timestamp: Date.now(),
          } satisfies PipelineEvent);

          return {
            persona: item.persona,
            output: result.output,
            searchQueries: result.searchQueries,
            status: "complete",
          };
        } catch (error) {
          const message =
            error instanceof Error ? error.message : "debate agent failed";
          const completed = this.#deps.completeAgentRun(
            item.agentRun.id,
            message,
            {
              status: "error",
            },
          );

          const state = this.toAgentState(completed);
          this.emit("agent-complete", {
            type: "agent-complete",
            runId,
            agentRunId: completed.id,
            persona: item.persona.name,
            phase,
            state,
            timestamp: Date.now(),
          } satisfies PipelineEvent);

          completedAgents += 1;
          this.emit("agent-progress", {
            type: "agent-progress",
            runId,
            phase,
            completedAgents,
            totalAgents,
            timestamp: Date.now(),
          } satisfies PipelineEvent);

          return {
            persona: item.persona,
            output: "",
            searchQueries: [],
            status: "error",
          };
        }
      },
    );

    const successfulOutputs = results.filter(
      (item): item is PersonaOutput =>
        item.status === "complete" &&
        typeof item.output === "string" &&
        item.output.trim().length > 0,
    );
    if (successfulOutputs.length < 2) {
      throw new Error(
        `debate round ${round} failed: ${successfulOutputs.length}/${totalAgents} agents succeeded`,
      );
    }

    return successfulOutputs;
  }

  private async synthesize(
    runId: string,
    query: string,
    personas: PersonaConfig[],
    researchOutputs: PersonaOutput[],
    debateOutputs: PersonaOutput[],
  ): Promise<string> {
    const formattedResearch = this.formatPersonaOutputs(
      "research",
      researchOutputs,
    );
    const formattedDebate = this.formatPersonaOutputs("debate", debateOutputs);

    const userPrompt = [
      `Original query:\n${this.formatCodeBlock(query)}`,
      `Selected personas:\n${personas.map((persona) => `- ${persona.name}`).join("\n")}`,
      formattedResearch,
      formattedDebate,
    ].join("\n\n");

    const result = await this.runModel({
      runId,
      model: this.#orchestratorModel,
      systemPrompt: SYNTHESIS_PROMPT,
      userPrompt,
      allowTools: false,
    });

    return result.output.trim();
  }

  private async runModel(input: {
    runId: string;
    model: string;
    systemPrompt: string;
    userPrompt: string;
    allowTools?: boolean;
    maxToolCalls?: number;
    onExecutionStart?: (timestamp: number) => void;
  }): Promise<ModelRunResult> {
    const result = await this.#deps.runModel({
      apiKey: this.#config.apiKey,
      baseUrl: this.#config.baseUrl,
      model: input.model,
      searchConfig: this.#config.searchConfig,
      systemPrompt: input.systemPrompt,
      userPrompt: input.userPrompt,
      allowTools: input.allowTools,
      maxToolCalls: input.maxToolCalls,
      onExecutionStart: input.onExecutionStart,
    });

    const promptTokens = Number.isFinite(result.promptTokens)
      ? result.promptTokens
      : 0;
    const completionTokens = Number.isFinite(result.completionTokens)
      ? result.completionTokens
      : 0;
    this.#totalPromptTokens += promptTokens;
    this.#totalCompletionTokens += completionTokens;
    this.#deps.addTokenUsage(input.runId, promptTokens, completionTokens);
    return result;
  }

  private setStatus(runId: string, status: RunStatus): void {
    this.#deps.updateRunStatus(runId, { status });
    this.emit("run-status-changed", {
      type: "run-status-changed",
      runId,
      status,
      timestamp: Date.now(),
    } satisfies PipelineEvent);
  }

  private normalizeAssignments(
    assignments: DecomposedAssignment[],
    personas: PersonaConfig[],
    query: string,
    targetCount = this.#config.agentCount,
  ): DecomposedAssignment[] {
    const usedPersonas = new Set<string>();
    const availablePersonas = personas.filter(
      (persona) => persona.name.trim().length > 0,
    );
    const personaByName = new Map<string, PersonaConfig>(
      availablePersonas.map((persona) => [persona.name.toLowerCase(), persona]),
    );
    const deduplicated: DecomposedAssignment[] = [];

    for (const assignment of assignments) {
      const candidateName = assignment.persona.trim();
      const persona = personaByName.get(candidateName.toLowerCase());
      if (
        !candidateName ||
        !persona ||
        usedPersonas.has(persona.name.toLowerCase())
      ) {
        continue;
      }
      usedPersonas.add(persona.name.toLowerCase());
      deduplicated.push({
        ...assignment,
        persona: persona.name,
      });
    }

    const remainingPersonas = availablePersonas.filter(
      (persona) => !usedPersonas.has(persona.name.toLowerCase()),
    );

    if (deduplicated.length < targetCount) {
      console.warn(
        `[hydra] orchestrator returned ${assignments.length} assignments; expected ${targetCount}. Filling missing ones from selected personas.`,
      );

      const shuffledRemaining = [...remainingPersonas];
      for (let i = shuffledRemaining.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [shuffledRemaining[i], shuffledRemaining[j]] = [
          shuffledRemaining[j],
          shuffledRemaining[i],
        ];
      }

      for (let index = deduplicated.length; index < targetCount; index++) {
        const replacementPersona = shuffledRemaining.shift();
        if (!replacementPersona) {
          continue;
        }

        usedPersonas.add(replacementPersona.name.toLowerCase());
        deduplicated.push({
          persona: replacementPersona.name,
          subQuestion: query,
          methodology: replacementPersona.methodology,
        });
      }
    }

    if (deduplicated.length > targetCount) {
      console.warn(
        `[hydra] orchestrator returned ${deduplicated.length} assignments; expected ${targetCount}. Truncating extras.`,
      );
      return deduplicated.slice(0, targetCount);
    }

    return deduplicated;
  }

  private parseAssignments(raw: string): DecomposedAssignment[] {
    const trimmed = raw.trim();
    if (!trimmed) {
      return [];
    }

    const fromFence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
    const candidate =
      fromFence?.[1]?.trim() ?? this.extractBracketPayload(trimmed);
    if (!candidate) {
      return [];
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(candidate);
    } catch {
      return [];
    }

    if (!Array.isArray(parsed) || parsed.length === 0) {
      return [];
    }

    const assignments = parsed.map((item) => {
      if (!item || typeof item !== "object") {
        return null;
      }
      const maybe = item as Record<string, unknown>;
      if (
        typeof maybe.persona !== "string" ||
        typeof maybe.subQuestion !== "string" ||
        typeof maybe.methodology !== "string"
      ) {
        return null;
      }
      return {
        persona: maybe.persona.trim(),
        subQuestion: maybe.subQuestion.trim(),
        methodology: maybe.methodology.trim(),
      } satisfies DecomposedAssignment;
    });

    if (assignments.some((item) => item === null)) {
      return [];
    }

    return assignments.filter(
      (assignment): assignment is DecomposedAssignment => assignment !== null,
    );
  }

  private extractBracketPayload(raw: string): string {
    const start = raw.indexOf("[");
    if (start === -1) {
      return "";
    }

    const end = raw.lastIndexOf("]");
    if (end <= start) {
      return "";
    }

    return raw.slice(start, end + 1).trim();
  }

  private resolvePersona(
    assignment: DecomposedAssignment,
    personas: PersonaConfig[],
    usedPersonas: Set<string>,
  ): PersonaConfig {
    const assignedName = assignment.persona.trim();
    const byName = personas.find(
      (persona) =>
        persona.name.toLowerCase() === assignedName.toLowerCase() &&
        !usedPersonas.has(persona.name.toLowerCase()),
    );
    if (byName) {
      usedPersonas.add(byName.name.toLowerCase());
      return byName;
    }

    const fallback = personas.find(
      (persona) => !usedPersonas.has(persona.name.toLowerCase()),
    );
    if (!fallback) {
      return personas[0];
    }

    usedPersonas.add(fallback.name.toLowerCase());
    return fallback;
  }

  private formatCodeBlock(text: string): string {
    return `\`\`\`text\n${text}\n\`\`\``;
  }

  private buildDebatePrompt(
    query: string,
    personaName: string,
    ownFinding: string,
    peers: PersonaOutput[],
    round: number,
  ): string {
    const ownFindingForPrompt = this.trimDebateContext(
      ownFinding || "No finding produced.",
      round,
    );
    const peerLines =
      peers.length === 0
        ? ["No peer findings available."]
        : peers.map(
            (peer) =>
              `${peer.persona.name}:\n${this.formatCodeBlock(
                this.trimDebateContext(peer.output || "No output.", round),
              )}`,
          );

    return [
      `Original query:\n${this.formatCodeBlock(query)}`,
      `Your finding:\n${this.formatCodeBlock(ownFindingForPrompt)}`,
      `Persona: ${personaName}`,
      `Peer findings:\n${peerLines.join("\n\n")}`,
      "Update your thesis with direct contrasts and revised confidence.",
    ].join("\n\n");
  }

  private trimDebateContext(text: string, round: number): string {
    if (round <= 1 || text.length <= MAX_DEBATE_CONTEXT_CHARS) {
      return text;
    }
    return `${text.slice(0, MAX_DEBATE_CONTEXT_CHARS)}\n\n[truncated for context window]`;
  }

  private formatPersonaOutputs(
    label: string,
    outputs: PersonaOutput[],
  ): string {
    if (outputs.length === 0) {
      return `${label.toUpperCase()} OUTPUTS:\nNo outputs.`;
    }

    return `${label.toUpperCase()} OUTPUTS:\n${outputs
      .map(
        (output) =>
          `- ${output.persona.name} (${output.status}):\n${this.formatCodeBlock(output.output || "No output.")}`,
      )
      .join("\n\n")}`;
  }

  private toAgentState(
    record: ReturnType<typeof completeAgentRun>,
  ): AgentRunState {
    return {
      runId: record.runId,
      phase: record.phase,
      persona: record.persona,
      status: record.status,
      startedAt: record.startedAt,
      completedAt: record.completedAt,
      promptTokens: record.promptTokens,
      completionTokens: record.completionTokens,
      output: record.output,
    };
  }

  private resolvePersonas(): PersonaConfig[] {
    return typeof this.#deps.personas === "function"
      ? this.#deps.personas()
      : this.#deps.personas;
  }
}
