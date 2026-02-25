import {
  createCliRenderer,
  BoxRenderable,
  TextRenderable,
  type CliRenderer,
  t,
  green,
  yellow,
  magenta,
  brightBlack,
  bold,
} from "@opentui/core";
import { getRunAgentRuns } from "../db/queries";
import { ETAEstimator, formatDuration } from "../engine/eta";
import type { AgentPhase, PipelineEvent, RunStatus } from "../types";

interface HydraUIOptions {
  concurrency: number;
  totalDebateRounds: number;
}

interface AgentEntry {
  persona: string;
  status: "queued" | "running" | "complete" | "error";
  phase: AgentPhase;
  durationMs: number | null;
  searchCount: number;
  startedAt: number;
}

function formatSearchLabel(count: number): string {
  return `${count} search${count === 1 ? "" : "es"}`;
}

function makePlaceholder(agentIndex: number): AgentEntry {
  return {
    persona: `Agent ${agentIndex}`,
    status: "queued",
    phase: "decompose",
    durationMs: null,
    searchCount: 0,
    startedAt: Number.POSITIVE_INFINITY,
  };
}

function formatAgentLine(entry: AgentEntry): string {
  if (entry.status === "running") {
    return `⏳ ${entry.persona} — searching... (${formatDuration(entry.durationMs ?? 0)})`;
  }
  if (entry.status === "queued") {
    return `🔄 ${entry.persona} — queued`;
  }
  if (entry.status === "error") {
    return `❌ ${entry.persona} — error (${formatDuration(entry.durationMs ?? 0)}, ${formatSearchLabel(entry.searchCount)})`;
  }
  return `✅ ${entry.persona} — done (${formatDuration(entry.durationMs ?? 0)}, ${formatSearchLabel(entry.searchCount)})`;
}

function parseSearchCount(rawSearchQueries: string): number {
  try {
    const parsed = JSON.parse(rawSearchQueries);
    return Array.isArray(parsed) ? parsed.length : 0;
  } catch {
    return 0;
  }
}

function mapRunStatusToAgentPhase(status: RunStatus): AgentPhase {
  if (status === "researching") {
    return "research";
  }
  if (status === "debating") {
    return "debate";
  }
  if (status === "synthesizing") {
    return "synthesis";
  }
  return "decompose";
}

function mapAgentPhaseToRunStatus(phase: AgentPhase): RunStatus {
  if (phase === "research") {
    return "researching";
  }
  if (phase === "debate") {
    return "debating";
  }
  if (phase === "synthesis") {
    return "synthesizing";
  }
  return "decomposing";
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) {
    return min;
  }
  return Math.max(min, Math.min(max, value));
}

function mapStatusForDisplay(
  status: RunStatus,
  debateRound: number,
  totalDebateRounds: number,
): string {
  if (status === "debating") {
    return `DEBATING | Round ${debateRound}/${Math.max(1, totalDebateRounds)}`;
  }
  return status.toUpperCase();
}

function renderMarkdownAsAnsi(markdown: string): string {
  const reset = "\x1b[0m";
  const bold = "\x1b[1m";
  const heading = markdown.replace(/^##\s*(.*)$/gm, (_match, title) => `${bold}## ${title}${reset}`);
  return heading.replace(/\*\*(.+?)\*\*/g, `${bold}$1${reset}`);
}

function truncateQuery(query: string, width: number): string {
  const cleaned = query.replace(/\s+/g, " ").trim();
  const maxLength = Math.max(30, width - 14);
  if (cleaned.length <= maxLength) {
    return cleaned;
  }
  return `${cleaned.slice(0, maxLength - 3)}...`;
}

function makePlaceholders(count: number): AgentEntry[] {
  return Array.from({ length: count }, (_, index) => ({
    ...makePlaceholder(index + 1),
  }));
}

function renderTokens(totalPromptTokens: number, totalCompletionTokens: number): string {
  const total = Math.max(0, Math.round(totalPromptTokens + totalCompletionTokens));
  return total.toLocaleString();
}

/** render live progress in OpenTUI. */
export class HydraUI {
  #renderer: CliRenderer | null = null;
  #tickHandle: ReturnType<typeof setInterval> | null = null;
  #stopped = false;
  #started = false;
  #runId = "";
  #query = "";
  #totalAgents = 0;
  #runCreatedAt = 0;
  #phaseStartedAt = 0;
  #status: RunStatus = "decomposing";
  #phase: AgentPhase = "decompose";
  #progressCompleted = 0;
  #progressTotal = 0;
  #debateRound = 0;
  #debateRoundComplete = false;
  #totalDebateRounds = 1;
  #estimatedMs = 0;
  #totalPromptTokens = 0;
  #totalCompletionTokens = 0;
  #totalSearches = 0;
  #etaEstimator = new ETAEstimator();

  #agentEntries: AgentEntry[] = [];
  #rootPanel: BoxRenderable | null = null;
  #titleText: TextRenderable | null = null;
  #queryText: TextRenderable | null = null;
  #phaseText: TextRenderable | null = null;
  #summaryText: TextRenderable | null = null;
  #agentListPanel: BoxRenderable | null = null;
  #footerText: TextRenderable | null = null;
  #concurrency: number;

  constructor(options: HydraUIOptions) {
    this.#concurrency = clamp(options.concurrency, 1, 10);
    this.#totalDebateRounds = Math.max(1, Math.trunc(options.totalDebateRounds));
  }

  /** create renderer and mount the live UI. */
  async start(query: string, agentCount: number): Promise<void> {
    if (this.#started) {
      return;
    }

    this.#started = true;
    this.#query = query;
    this.#totalAgents = clamp(agentCount, 1, 20);
    this.#progressTotal = this.#totalAgents;
    this.#agentEntries = makePlaceholders(this.#totalAgents);

    this.#renderer = await createCliRenderer({
      exitOnCtrlC: true,
      useAlternateScreen: true,
    });

    const rootPanel = new BoxRenderable(this.#renderer, {
      border: true,
      borderStyle: "rounded",
      flexDirection: "column",
      gap: 1,
      padding: 1,
      width: "100%",
      height: "100%",
    });
    this.#renderer.root.add(rootPanel);
    this.#rootPanel = rootPanel;

    this.#titleText = new TextRenderable(this.#renderer, {
      content: t`${green(bold("🐉 HYDRA — Swarm Intelligence Engine"))}`,
    });
    this.#queryText = new TextRenderable(this.#renderer, {
      content: `Query: ${this.#query}`,
    });
    this.#phaseText = new TextRenderable(this.#renderer, {
      content: "Phase: DECOMPOSING",
    });
    this.#summaryText = new TextRenderable(this.#renderer, {
      content: "ETA: -- | Elapsed: 0s | Tokens: 0",
    });
    this.#agentListPanel = new BoxRenderable(this.#renderer, {
      flexDirection: "column",
      flexGrow: 1,
      gap: 0,
    });
    this.#footerText = new TextRenderable(this.#renderer, {
      content: "",
    });

    rootPanel.add(this.#titleText);
    rootPanel.add(this.#queryText);
    rootPanel.add(this.#phaseText);
    rootPanel.add(this.#summaryText);
    rootPanel.add(this.#agentListPanel);
    rootPanel.add(this.#footerText);
    this.#rebuildAgentRows();

    this.#renderer.requestLive();
    this.#runCreatedAt = Date.now();
    this.#phaseStartedAt = this.#runCreatedAt;
    this.#tickHandle = setInterval(() => {
      this.#estimatedMs = Date.now() - this.#phaseStartedAt;
      this.#syncAgentListFromDb();
      this.#refreshRunningAgentDurations();
      this.#refresh();
    }, 1000);
    this.#refresh();
  }

  /** process all pipeline events and sync UI state. */
  handleEvent(event: PipelineEvent): void {
    if (!this.#renderer) {
      return;
    }

    if (event.type === "run-created") {
      this.#runId = event.runId;
      this.#query = event.query;
      this.#totalAgents = event.agentCount;
      this.#progressTotal = event.agentCount;
      this.#progressCompleted = 0;
      this.#totalPromptTokens = 0;
      this.#totalCompletionTokens = 0;
      this.#status = "decomposing";
      this.#phase = "decompose";
      this.#debateRound = 0;
      this.#debateRoundComplete = false;
      this.#runCreatedAt = event.timestamp;
      this.#phaseStartedAt = event.timestamp;
      this.#etaEstimator.reset();
      this.#agentEntries = makePlaceholders(this.#totalAgents);
      this.#syncAgentListFromDb();
      this.#refresh();
      return;
    }

    if (event.type === "run-status-changed") {
      const previousStatus = this.#status;
      this.#status = event.status;
      if (event.status !== "complete" && event.status !== "error") {
        this.#phase = mapRunStatusToAgentPhase(event.status);
      }
      this.#phaseStartedAt = event.timestamp;

      if (event.status === "debating" && previousStatus !== "debating") {
        this.#debateRound += 1;
        this.#debateRoundComplete = false;
      }
      if (event.status === "researching" || event.status === "debating") {
        this.#progressCompleted = 0;
      }
      if (event.status === "synthesizing") {
        this.#progressCompleted = this.#totalAgents;
      }
      if (event.status !== "decomposing") {
        this.#progressTotal = this.#totalAgents;
      }
      this.#syncAgentListFromDb();
      this.#refresh();
      return;
    }

    if (event.type === "agent-progress") {
      const newPhase = mapAgentPhaseToRunStatus(event.phase);
      if (newPhase === "debating") {
        const isNewRoundByCompletion =
          event.completedAgents < this.#progressCompleted || this.#debateRoundComplete;
        if (isNewRoundByCompletion) {
          this.#debateRound += 1;
          this.#debateRoundComplete = false;
        }
      }

      this.#status = newPhase;
      this.#phase = event.phase;
      this.#progressCompleted = event.completedAgents;
      this.#progressTotal = event.totalAgents;
      if (newPhase === "debating" && event.completedAgents >= event.totalAgents) {
        this.#debateRoundComplete = true;
      }
      this.#syncAgentListFromDb();
      this.#refresh();
      return;
    }

    if (event.type === "agent-complete") {
      const promptTokens = Number.isFinite(event.state.promptTokens)
        ? event.state.promptTokens
        : 0;
      const completionTokens = Number.isFinite(event.state.completionTokens)
        ? event.state.completionTokens
        : 0;
      this.#totalPromptTokens += promptTokens;
      this.#totalCompletionTokens += completionTokens;

      if (
        typeof event.state.completedAt === "number" &&
        typeof event.state.startedAt === "number"
      ) {
        const durationMs = event.state.completedAt - event.state.startedAt;
        if (Number.isFinite(durationMs) && durationMs > 0) {
          this.#etaEstimator.recordCompletion(durationMs);
        }
      }

      this.#syncAgentListFromDb();
      this.#refresh();
      return;
    }

    if (event.type === "run-complete") {
      this.#status = "complete";
      this.#progressCompleted = this.#totalAgents;
      this.#totalPromptTokens = event.totalPromptTokens;
      this.#totalCompletionTokens = event.totalCompletionTokens;
      this.#syncAgentListFromDb();
      this.#refresh();
    }
  }

  /** stop live rendering and print the final brief. */
  stop(brief?: string): void {
    if (!this.#renderer || this.#stopped) {
      return;
    }

    this.#stopped = true;
    if (this.#tickHandle) {
      clearInterval(this.#tickHandle);
      this.#tickHandle = null;
    }

    this.#renderer.dropLive();
    this.#renderer.destroy();

    if (brief === undefined) {
      return;
    }

    const rendered = renderMarkdownAsAnsi(brief.trim());
    if (rendered.length === 0) {
      return;
    }

    console.log("");
    console.log(rendered);
  }

  #syncAgentListFromDb(): void {
    if (!this.#runId) {
      this.#totalSearches = this.#agentEntries.reduce((total, entry) => total + entry.searchCount, 0);
      return;
    }

    const runAgentRuns = getRunAgentRuns(this.#runId);
    const phaseRows = runAgentRuns.filter((row) => row.phase === this.#phase);
    const rawRows = phaseRows.length > 0 ? phaseRows : runAgentRuns;
    const byPersona = new Map<string, (typeof rawRows)[number]>();
    for (const row of rawRows) {
      byPersona.set(row.persona, row);
    }

    const updatedEntries: AgentEntry[] = [];
    const now = Date.now();
    for (const row of byPersona.values()) {
      const status: AgentEntry["status"] = row.status;
      const durationMs =
        row.completedAt && (status === "complete" || status === "error")
          ? Math.max(0, row.completedAt - row.startedAt)
          : status === "running" && row.startedAt > 0
            ? Math.max(0, now - row.startedAt)
            : null;

      updatedEntries.push({
        persona: row.persona,
        status,
        phase: row.phase,
        durationMs,
        searchCount: parseSearchCount(row.searchQueries),
        startedAt: row.startedAt,
      });
    }

    while (updatedEntries.length < this.#totalAgents) {
      updatedEntries.push(makePlaceholder(updatedEntries.length + 1));
    }
    if (updatedEntries.length > this.#totalAgents) {
      updatedEntries.length = this.#totalAgents;
    }

    this.#agentEntries = updatedEntries;
    this.#totalSearches = runAgentRuns.reduce(
      (total, entry) => total + parseSearchCount(entry.searchQueries),
      0,
    );
    this.#rebuildAgentRows();
  }

  #rebuildAgentRows(): void {
    if (!this.#agentListPanel || !this.#renderer) {
      return;
    }

    for (const child of this.#agentListPanel.getChildren()) {
      this.#agentListPanel.remove(child.id);
    }

    for (const entry of this.#agentEntries) {
      const row = new TextRenderable(this.#renderer, {
        content: formatAgentLine(entry),
      });
      this.#agentListPanel.add(row);
    }
  }

  #refresh(): void {
    if (!this.#renderer || !this.#titleText || !this.#queryText || !this.#phaseText || !this.#summaryText || !this.#footerText) {
      return;
    }

    const width = this.#renderer.width;
    const phase = mapStatusForDisplay(
      this.#status,
      this.#debateRound,
      this.#totalDebateRounds,
    );

    const totalForDisplay = Math.max(1, this.#progressTotal || this.#totalAgents || 1);
    const completed = clamp(this.#progressCompleted, 0, totalForDisplay);
    const remaining = Math.max(0, totalForDisplay - completed);
    const progressBar = this.#buildProgressBar(completed, totalForDisplay);
    const eta = this.#status === "complete" ? "0s" : this.#etaEstimator.estimate(remaining, this.#concurrency);
    const elapsed = formatDuration(
      this.#status === "decomposing" ? this.#estimatedMs : Math.max(0, Date.now() - this.#runCreatedAt),
    );
    const progressText = `${completed}/${totalForDisplay}`;
    const tokens = renderTokens(this.#totalPromptTokens, this.#totalCompletionTokens);
    const errors = this.#agentEntries.filter((entry) => entry.status === "error").length;

    this.#queryText.content = t`Query: ${brightBlack(truncateQuery(this.#query, width))}`;
    this.#phaseText.content = t`Phase: ${green(phase)} [${progressBar}] ${progressText} agents`;
    this.#summaryText.content = t`ETA: ${yellow(eta)} | Elapsed: ${yellow(elapsed)} | Tokens: ${yellow(tokens)}`;
    this.#footerText.content = t`Concurrency: ${magenta(this.#concurrency)} | Searches: ${magenta(this.#totalSearches)} | Errors: ${magenta(errors)}`;
  }

  #buildProgressBar(completed: number, total: number): string {
    const width = clamp(this.#renderer ? this.#renderer.width - 30 : 24, 12, 64);
    const safeCompleted = clamp(completed, 0, total);
    const safeTotal = Math.max(1, total);
    const filled = Math.round((safeCompleted / safeTotal) * width);
    const empty = Math.max(0, width - filled);
    return `${"█".repeat(filled)}${"░".repeat(empty)}`;
  }

  #refreshRunningAgentDurations(): void {
    if (!this.#agentEntries.length) {
      return;
    }

    let changed = false;
    const now = Date.now();
    for (const entry of this.#agentEntries) {
      if (entry.status !== "running" || entry.startedAt <= 0 || !Number.isFinite(entry.startedAt)) {
        continue;
      }

      const nextDurationMs = Math.max(0, now - entry.startedAt);
      if (entry.durationMs === nextDurationMs) {
        continue;
      }

      entry.durationMs = nextDurationMs;
      changed = true;
    }

    if (changed) {
      this.#rebuildAgentRows();
    }
  }
}
