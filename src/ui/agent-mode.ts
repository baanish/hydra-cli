import type { PipelineEvent, RunStatus } from "../types";
import { ETAEstimator, formatDuration } from "../engine/eta";

interface AgentModeState {
  runId: string;
  startedAt: number;
  currentStatus: RunStatus;
  totalAgents: number;
  completedAgents: number;
  totalInPhase: number;
  phaseStartedAt: number;
  debateRound: number;
  debateRoundComplete: boolean;
  concurrency: number;
  totalDebateRounds: number;
  eta: ETAEstimator;
}

function phaseLabel(status: RunStatus): string {
  return status === "decomposing" ? "decomposing" : status;
}

function phaseForAgentEvent(phase: "decompose" | "research" | "debate" | "synthesis"): RunStatus {
  if (phase === "decompose") {
    return "decomposing";
  }
  if (phase === "research") {
    return "researching";
  }
  if (phase === "debate") {
    return "debating";
  }
  return "synthesizing";
}

function formatAgentModeProgress(state: AgentModeState, eventPhase: RunStatus, includeProgress: boolean): string {
  const completed = Math.min(state.completedAgents, state.totalInPhase);
  const total = Math.max(1, state.totalInPhase);
  const remaining = Math.max(0, total - completed);
  const eta = state.eta.estimate(remaining, state.concurrency);

  if (eventPhase === "decomposing") {
    return `Phase: ${phaseLabel(eventPhase)} | Agents: ${total} | ETA: --`;
  }

  if (eventPhase === "researching") {
    return includeProgress
      ? `Phase: ${phaseLabel(eventPhase)} | Progress: ${completed}/${total} | ETA: ${eta}`
      : `Phase: ${phaseLabel(eventPhase)} | ETA: ${eta}`;
  }

  if (eventPhase === "debating") {
    const phaseTotal = Math.max(1, state.totalInPhase);
    const roundTotal = Math.max(1, state.totalDebateRounds);
    const round = `${Math.max(1, state.debateRound)}/${roundTotal}`;
    return `Phase: ${phaseLabel(eventPhase)} | Round: ${round} | Progress: ${completed}/${phaseTotal} | ETA: ${eta}`;
  }

  return `Phase: ${phaseLabel(eventPhase)} | ETA: ${eta}`;
}

const agentModeState: AgentModeState = {
  runId: "",
  startedAt: 0,
  currentStatus: "decomposing",
  totalAgents: 0,
  completedAgents: 0,
  totalInPhase: 0,
  phaseStartedAt: 0,
  debateRound: 0,
  debateRoundComplete: false,
  concurrency: 1,
  totalDebateRounds: 1,
  eta: new ETAEstimator(),
};

/** set effective parallelism used for ETA estimation in non-interactive mode. */
export function setAgentModeConcurrency(concurrency: number): void {
  const parsed = Math.trunc(concurrency);
  agentModeState.concurrency = Number.isFinite(parsed) && parsed > 0 ? parsed : 1;
}

/** set the debate round total used in non-interactive progress output. */
export function setAgentModeDebateRounds(totalDebateRounds: number): void {
  const parsed = Math.trunc(totalDebateRounds);
  agentModeState.totalDebateRounds = Number.isFinite(parsed) && parsed > 0 ? parsed : 1;
}

function writeAgentModeLine(message: string): void {
  console.error(`[hydra] ${message}`);
}

/** emit a machine-readable progress line to stderr for non-interactive agent mode. */
export function emitAgentProgress(event: PipelineEvent): void {
  if (event.type === "run-created") {
    agentModeState.runId = event.runId;
    agentModeState.startedAt = event.timestamp;
    agentModeState.phaseStartedAt = event.timestamp;
    agentModeState.currentStatus = "decomposing";
    agentModeState.totalAgents = event.agentCount;
    agentModeState.totalInPhase = event.agentCount;
    agentModeState.completedAgents = 0;
    agentModeState.debateRound = 0;
    agentModeState.eta = new ETAEstimator();
    writeAgentModeLine(`${formatAgentModeProgress(agentModeState, "decomposing", false)} | runId=${agentModeState.runId}`);
    return;
  }

  if (event.type === "run-status-changed") {
    const previousStatus = agentModeState.currentStatus;
    agentModeState.currentStatus = event.status;
    if (event.status === "debating" && previousStatus !== "debating") {
      agentModeState.debateRound += 1;
      agentModeState.completedAgents = 0;
      agentModeState.totalInPhase = agentModeState.totalAgents;
      agentModeState.phaseStartedAt = event.timestamp;
      agentModeState.debateRoundComplete = false;
    }

    if (event.status === "decomposing") {
      agentModeState.phaseStartedAt = event.timestamp;
      agentModeState.completedAgents = 0;
    }

    if (event.status === "synthesizing") {
      agentModeState.totalInPhase = agentModeState.totalAgents;
      agentModeState.completedAgents = agentModeState.totalInPhase;
    }

    writeAgentModeLine(formatAgentModeProgress(agentModeState, event.status, event.status !== "synthesizing"));
    return;
  }

  if (event.type === "agent-progress") {
    const phaseStatus = phaseForAgentEvent(event.phase);
    if (phaseStatus === "debating") {
      const isNewRoundByCompletion =
        event.completedAgents < agentModeState.completedAgents || agentModeState.debateRoundComplete;
      if (isNewRoundByCompletion) {
        agentModeState.debateRound += 1;
        agentModeState.debateRoundComplete = false;
      }
    }

    agentModeState.currentStatus = phaseStatus;
    agentModeState.completedAgents = event.completedAgents;
    agentModeState.totalInPhase = event.totalAgents;
    if (phaseStatus === "debating" && event.completedAgents >= event.totalAgents) {
      agentModeState.debateRoundComplete = true;
    }
    writeAgentModeLine(formatAgentModeProgress(agentModeState, phaseStatus, true));
    return;
  }

  if (event.type === "agent-complete") {
    if (typeof event.state.startedAt === "number" && typeof event.state.completedAt === "number") {
      const durationMs = event.state.completedAt - event.state.startedAt;
      agentModeState.eta.recordCompletion(durationMs);
    }
    return;
  }

  if (event.type === "run-complete") {
    const elapsed = formatDuration(event.elapsedMs);
    const tokenCount = event.totalPromptTokens + event.totalCompletionTokens;
    writeAgentModeLine(
      `Complete | Total: ${elapsed} | Tokens: ${tokenCount.toLocaleString()}`,
    );
    return;
  }
}
