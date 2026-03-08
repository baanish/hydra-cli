import { randomBytes, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { clampInt, loadConfig, maskConfigValue } from "../config";
import { getRun, getRunAgentRuns, listRuns, removeRun } from "../db/queries";
import { HydraPipeline, type PipelineConfig } from "../engine/pipeline";
import { formatErrorMessage, isLoopbackHostname } from "../security";
import type {
  AgentRunRecord,
  AgentRunState,
  HydraConfig,
  PipelineEvent,
  SearchConfig,
} from "../types";

type RunSsePayload = PipelineEvent | { type: "done"; runId: string };

type SseClient = {
  send: (event: RunSsePayload) => Promise<void>;
  close: () => Promise<void>;
};

const APP_HTML_TEMPLATE = readFileSync(
  resolve(dirname(fileURLToPath(import.meta.url)), "app.html"),
  "utf8",
);
const API_SESSION_HEADER = "x-hydra-session";
const SESSION_TOKEN_PLACEHOLDER = "__HYDRA_WEB_TOKEN__";
const MAX_WEB_QUERY_CHARS = 20_000;

const activeRunPipelines = new Map<string, HydraPipeline>();
const activeRunClients = new Map<string, Set<SseClient>>();

const pipelineEventTypes = [
  "run-created",
  "run-status-changed",
  "agent-progress",
  "agent-complete",
  "run-complete",
] as const;

function createSecurityHeaders(contentType?: string): Headers {
  const headers = new Headers();
  headers.set("Cache-Control", "no-store");
  headers.set(
    "Content-Security-Policy",
    "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'; object-src 'none'",
  );
  headers.set("Cross-Origin-Resource-Policy", "same-origin");
  headers.set("Referrer-Policy", "no-referrer");
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("X-Frame-Options", "DENY");
  if (contentType) {
    headers.set("Content-Type", contentType);
  }
  return headers;
}

function buildAppHtml(sessionToken: string): string {
  return APP_HTML_TEMPLATE.replaceAll(SESSION_TOKEN_PLACEHOLDER, sessionToken);
}

function createSseResponse() {
  const encoder = new TextEncoder();
  const stream = new TransformStream<Uint8Array, Uint8Array>();
  const writer = stream.writable.getWriter();
  let closed = false;

  const send = async (event: RunSsePayload): Promise<void> => {
    if (closed) {
      return;
    }
    const payload = `data: ${JSON.stringify(event)}\n\n`;
    await writer.ready;
    await writer.write(encoder.encode(payload));
  };

  const close = async () => {
    if (closed) {
      return;
    }
    closed = true;
    try {
      await writer.close();
    } catch {
      // stream already closed.
    }
  };

  return {
    response: new Response(stream.readable, {
      headers: createSecurityHeaders("text/event-stream"),
    }),
    send,
    close,
  };
}

function addRunClient(runId: string, client: SseClient): () => void {
  let clients = activeRunClients.get(runId);
  if (!clients) {
    clients = new Set();
    activeRunClients.set(runId, clients);
  }

  clients.add(client);

  return () => {
    const current = activeRunClients.get(runId);
    if (!current) {
      return;
    }
    current.delete(client);
    if (current.size === 0) {
      activeRunClients.delete(runId);
    }
  };
}

function broadcastRunEvent(runId: string, event: RunSsePayload): void {
  const clients = activeRunClients.get(runId);
  if (!clients || clients.size === 0) {
    return;
  }

  for (const client of [...clients]) {
    void client.send(event).catch(() => {
      const current = activeRunClients.get(runId);
      if (!current) {
        return;
      }
      current.delete(client);
      if (current.size === 0) {
        activeRunClients.delete(runId);
      }
    });
  }
}

async function closeRunSubscribers(runId: string): Promise<void> {
  const clients = activeRunClients.get(runId);
  if (!clients || clients.size === 0) {
    return;
  }

  activeRunClients.delete(runId);
  await Promise.allSettled(
    [...clients].map(async (client) => {
      try {
        await client.send({ type: "done", runId });
      } catch {
        // ignore failed stream writes while closing.
      }
      try {
        await client.close();
      } catch {
        // ignore failed stream closes while closing.
      }
    }),
  );
}

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

function toMaskedConfig(config: HydraConfig) {
  return {
    ...config,
    apiKey: maskConfigValue(config.apiKey),
    syntheticApiKey: maskConfigValue(config.syntheticApiKey),
    exaApiKey: maskConfigValue(config.exaApiKey),
    braveApiKey: maskConfigValue(config.braveApiKey),
  };
}

function phaseProgress(agentRuns: AgentRunRecord[]) {
  const counts: Record<string, { completed: number; total: number }> = {
    decompose: { completed: 0, total: 0 },
    research: { completed: 0, total: 0 },
    debate: { completed: 0, total: 0 },
    synthesis: { completed: 0, total: 0 },
  };

  for (const item of agentRuns) {
    if (!counts[item.phase]) {
      counts[item.phase] = { completed: 0, total: 0 };
    }
    counts[item.phase].total += 1;
    if (item.status === "complete" || item.status === "error") {
      counts[item.phase].completed += 1;
    }
  }

  return counts;
}

function toState(agentRun: AgentRunRecord): AgentRunState {
  return {
    runId: agentRun.runId,
    phase: agentRun.phase,
    persona: agentRun.persona,
    status: agentRun.status,
    startedAt: agentRun.startedAt,
    completedAt: agentRun.completedAt,
    promptTokens: agentRun.promptTokens,
    completionTokens: agentRun.completionTokens,
    output: agentRun.output,
  };
}

function toPublicAgentRun(agentRun: AgentRunRecord) {
  return {
    id: agentRun.id,
    runId: agentRun.runId,
    phase: agentRun.phase,
    persona: agentRun.persona,
    status: agentRun.status,
    promptTokens: agentRun.promptTokens,
    completionTokens: agentRun.completionTokens,
    startedAt: agentRun.startedAt,
    completedAt: agentRun.completedAt,
    output: agentRun.output,
  };
}

async function replayFromDb(
  runId: string,
  send: (event: RunSsePayload) => Promise<void>,
) {
  const run = getRun(runId);
  if (!run) {
    return;
  }
  await send({
    type: "run-created",
    runId: run.id,
    query: run.query,
    agentCount: run.agentCount,
    timestamp: run.createdAt,
  });

  const records = getRunAgentRuns(run.id).sort(
    (left, right) => left.startedAt - right.startedAt,
  );
  const stats = phaseProgress(records);

  for (const [phase, summary] of Object.entries(stats)) {
    if (summary.total === 0) {
      continue;
    }
    await send({
      type: "agent-progress",
      runId: run.id,
      phase: phase as "decompose" | "research" | "debate" | "synthesis",
      completedAgents: summary.completed,
      totalAgents: summary.total,
      timestamp: run.createdAt,
    });
  }

  for (const item of records) {
    if (item.status !== "complete" && item.status !== "error") {
      continue;
    }
    await send({
      type: "agent-complete",
      runId: run.id,
      agentRunId: item.id,
      persona: item.persona,
      phase: item.phase,
      state: toState(item),
      timestamp: item.completedAt ?? item.startedAt,
    });
  }

  await send({
    type: "run-status-changed",
    runId: run.id,
    status: run.status,
    timestamp: run.completedAt ?? run.createdAt,
  });

  if (run.status === "complete") {
    await send({
      type: "run-complete",
      runId: run.id,
      elapsedMs: run.elapsedMs ?? 0,
      totalPromptTokens: run.totalPromptTokens,
      totalCompletionTokens: run.totalCompletionTokens,
      timestamp: run.completedAt ?? run.createdAt,
    });
  }
}

function parseJsonBody(body: unknown): {
  query: string;
  agentCount?: number;
  searchEnabled?: boolean;
} | null {
  if (typeof body !== "object" || body === null) {
    return null;
  }

  const payload = body as {
    query?: unknown;
    agentCount?: unknown;
    searchEnabled?: unknown;
  };

  if (typeof payload.query !== "string") {
    return null;
  }

  const query = payload.query.trim();
  if (!query || query.length > MAX_WEB_QUERY_CHARS) {
    return null;
  }

  return {
    query,
    agentCount:
      typeof payload.agentCount === "number" ||
      typeof payload.agentCount === "string"
        ? Number(payload.agentCount)
        : undefined,
    searchEnabled:
      typeof payload.searchEnabled === "boolean"
        ? payload.searchEnabled
        : undefined,
  };
}

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: createSecurityHeaders("application/json"),
  });
}

function textResponse(message: string, status = 200): Response {
  return new Response(message, {
    status,
    headers: createSecurityHeaders("text/plain; charset=utf-8"),
  });
}

function isEventStreamRequest(req: Request): boolean {
  return req.headers.get("accept")?.includes("text/event-stream") ?? false;
}

function readProvidedSessionToken(req: Request, url: URL): string {
  const headerToken = req.headers.get(API_SESSION_HEADER)?.trim();
  if (headerToken) {
    return headerToken;
  }
  if (!isEventStreamRequest(req)) {
    return "";
  }
  return url.searchParams.get("session")?.trim() ?? "";
}

function isAuthorizedSessionToken(
  expectedToken: string,
  providedToken: string,
): boolean {
  if (!providedToken) {
    return false;
  }
  const expected = Buffer.from(expectedToken);
  const provided = Buffer.from(providedToken);
  if (expected.length !== provided.length) {
    return false;
  }
  return timingSafeEqual(expected, provided);
}

function authorizeApiRequest(
  req: Request,
  url: URL,
  sessionToken: string,
): Response | null {
  if (!isLoopbackHostname(url.hostname)) {
    return jsonResponse({ error: "forbidden host" }, 403);
  }

  const secFetchSite = req.headers.get("sec-fetch-site");
  if (
    secFetchSite &&
    secFetchSite !== "same-origin" &&
    secFetchSite !== "same-site" &&
    secFetchSite !== "none"
  ) {
    return jsonResponse({ error: "forbidden request origin" }, 403);
  }

  const origin = req.headers.get("origin");
  if (origin && origin !== url.origin) {
    return jsonResponse({ error: "forbidden request origin" }, 403);
  }

  const providedToken = readProvidedSessionToken(req, url);
  if (!isAuthorizedSessionToken(sessionToken, providedToken)) {
    return jsonResponse({ error: "unauthorized" }, 401);
  }

  return null;
}

function parseRunId(pathname: string): string | null {
  const match = /^\/api\/runs\/([^/]+)(?:\/events)?$/.exec(pathname);
  if (!match) {
    return null;
  }
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return null;
  }
}

function isRunFinal(status: string): boolean {
  return status === "complete" || status === "error";
}

function routeRunEvents(runId: string, req: Request): Response {
  const run = getRun(runId);
  if (!run) {
    return jsonResponse({ error: "run not found" }, 404);
  }

  const { response, send, close } = createSseResponse();
  const bufferedEvents: RunSsePayload[] = [];
  const client: SseClient = { send, close };
  const bufferedClient: SseClient = {
    send: async (event) => {
      bufferedEvents.push(event);
    },
    close: async () => {},
  };
  let removeClient = () => {};
  const activePipeline = activeRunPipelines.get(runId);
  const onTerminalEvent = (event: PipelineEvent): void => {
    if (
      event.type === "run-complete" ||
      (event.type === "run-status-changed" && event.status === "error")
    ) {
      void closeRunSubscribers(runId);
    }
  };
  const closeSafely = async (): Promise<void> => {
    try {
      await close();
    } catch {
      // ignore close failures when stream is already closed.
    }
  };
  let finalized = false;
  const finalize = () => {
    if (finalized) {
      return;
    }
    finalized = true;
    if (activePipeline) {
      activePipeline.off("run-complete", onTerminalEvent);
      activePipeline.off("run-status-changed", onTerminalEvent);
    }
    removeClient();
  };
  const sendDone = async (): Promise<void> => {
    try {
      await send({ type: "done", runId });
    } catch {
      // ignore failed terminal done sends during disconnects.
    }
  };
  const flushBufferedEvents = async (): Promise<boolean> => {
    let hadDone = false;
    for (const event of bufferedEvents) {
      if (event.type === "done") {
        hadDone = true;
      }
      await send(event);
    }
    bufferedEvents.length = 0;
    return hadDone;
  };

  if (activePipeline) {
    activePipeline.on("run-complete", onTerminalEvent);
    activePipeline.on("run-status-changed", onTerminalEvent);
  }

  req.signal.addEventListener(
    "abort",
    () => {
      finalize();
      void closeSafely();
    },
    { once: true },
  );

  void (async () => {
    try {
      if (req.signal.aborted) {
        finalize();
        await closeSafely();
        return;
      }

      removeClient = addRunClient(runId, bufferedClient);
      await replayFromDb(runId, send);

      if (req.signal.aborted) {
        finalize();
        await closeSafely();
        return;
      }

      const latestRun = getRun(runId);
      if (!latestRun) {
        finalize();
        await closeSafely();
        return;
      }

      if (isRunFinal(latestRun.status)) {
        const hadDone = await flushBufferedEvents();
        if (!hadDone) {
          await sendDone();
        }
        finalize();
        await closeSafely();
        return;
      }

      removeClient();
      removeClient = addRunClient(runId, client);
      for (const event of bufferedEvents) {
        await send(event);
      }
      bufferedEvents.length = 0;

      if (req.signal.aborted) {
        finalize();
        await closeSafely();
        return;
      }

      if (!activeRunPipelines.has(runId)) {
        const initialAgentRuns = getRunAgentRuns(runId);
        const completedAgentRuns = new Set(
          initialAgentRuns
            .filter(
              (agentRun) =>
                agentRun.status === "complete" || agentRun.status === "error",
            )
            .map((agentRun) => agentRun.id),
        );
        const lastProgress = new Map<
          string,
          {
            completedAgents: number;
            totalAgents: number;
          }
        >();
        for (const [phase, summary] of Object.entries(
          phaseProgress(initialAgentRuns),
        )) {
          lastProgress.set(phase, {
            completedAgents: summary.completed,
            totalAgents: summary.total,
          });
        }
        let lastRunStatus = latestRun.status;

        while (!req.signal.aborted) {
          const polledRun = getRun(runId);
          if (!polledRun) {
            finalize();
            await closeSafely();
            return;
          }

          if (activeRunPipelines.has(runId)) {
            return;
          }

          if (polledRun.status !== lastRunStatus) {
            lastRunStatus = polledRun.status;
            await send({
              type: "run-status-changed",
              runId: polledRun.id,
              status: polledRun.status,
              timestamp: polledRun.completedAt ?? polledRun.createdAt,
            });
          }

          const polledAgentRuns = getRunAgentRuns(runId);
          for (const [phase, summary] of Object.entries(
            phaseProgress(polledAgentRuns),
          )) {
            const previous = lastProgress.get(phase);
            if (
              !previous ||
              previous.completedAgents !== summary.completed ||
              previous.totalAgents !== summary.total
            ) {
              lastProgress.set(phase, {
                completedAgents: summary.completed,
                totalAgents: summary.total,
              });
              await send({
                type: "agent-progress",
                runId: polledRun.id,
                phase: phase as
                  | "decompose"
                  | "research"
                  | "debate"
                  | "synthesis",
                completedAgents: summary.completed,
                totalAgents: summary.total,
                timestamp: polledRun.completedAt ?? polledRun.createdAt,
              });
            }
          }

          for (const agentRun of polledAgentRuns) {
            if (agentRun.status !== "complete" && agentRun.status !== "error") {
              continue;
            }
            if (completedAgentRuns.has(agentRun.id)) {
              continue;
            }
            completedAgentRuns.add(agentRun.id);
            await send({
              type: "agent-complete",
              runId: polledRun.id,
              agentRunId: agentRun.id,
              persona: agentRun.persona,
              phase: agentRun.phase,
              state: toState(agentRun),
              timestamp: agentRun.completedAt ?? agentRun.startedAt,
            });
          }

          if (isRunFinal(polledRun.status)) {
            if (polledRun.status === "complete") {
              await send({
                type: "run-complete",
                runId: polledRun.id,
                elapsedMs: polledRun.elapsedMs ?? 0,
                totalPromptTokens: polledRun.totalPromptTokens,
                totalCompletionTokens: polledRun.totalCompletionTokens,
                timestamp: polledRun.completedAt ?? polledRun.createdAt,
              });
            }

            await sendDone();
            finalize();
            await closeSafely();
            return;
          }

          await new Promise((resolve) => setTimeout(resolve, 1000));
        }
      }
    } catch {
      finalize();
      await closeSafely();
    }
  })();

  return response;
}

export async function startWebServer(port: number): Promise<void> {
  const sessionToken = randomBytes(24).toString("base64url");
  Bun.serve({
    hostname: "127.0.0.1",
    port,
    idleTimeout: 0,
    async fetch(req) {
      const method = req.method;
      const url = new URL(req.url);
      const pathname = url.pathname;
      const apiRequest = pathname.startsWith("/api/");

      if (!isLoopbackHostname(url.hostname)) {
        return textResponse("forbidden host", 403);
      }

      if (method === "OPTIONS") {
        return new Response(null, {
          status: 204,
          headers: createSecurityHeaders("text/plain; charset=utf-8"),
        });
      }

      if (apiRequest) {
        const authFailure = authorizeApiRequest(req, url, sessionToken);
        if (authFailure) {
          return authFailure;
        }
      }

      if (pathname === "/" || pathname === "/index.html") {
        return new Response(buildAppHtml(sessionToken), {
          headers: createSecurityHeaders("text/html; charset=utf-8"),
        });
      }

      if (pathname === "/api/config") {
        if (method !== "GET") {
          return jsonResponse({ error: "method not allowed" }, 405);
        }
        return jsonResponse(toMaskedConfig(loadConfig()));
      }

      if (pathname === "/api/runs") {
        if (method !== "GET") {
          return jsonResponse({ error: "method not allowed" }, 405);
        }
        return jsonResponse(listRuns(50));
      }

      const runId = parseRunId(pathname);
      if (runId) {
        if (pathname.endsWith("/events")) {
          if (method !== "GET") {
            return jsonResponse({ error: "method not allowed" }, 405);
          }
          return routeRunEvents(runId, req);
        }

        if (method === "GET") {
          const run = getRun(runId);
          if (!run) {
            return jsonResponse({ error: "run not found" }, 404);
          }
          return jsonResponse({
            run,
            agentRuns: getRunAgentRuns(runId).map(toPublicAgentRun),
          });
        }

        if (method === "DELETE") {
          const run = getRun(runId);
          if (!run) {
            return jsonResponse({ error: "run not found" }, 404);
          }
          if (activeRunPipelines.has(runId)) {
            return jsonResponse({ error: "run is still executing" }, 409);
          }
          if (!isRunFinal(run.status)) {
            return jsonResponse({ error: "run is still executing" }, 409);
          }
          const removed = removeRun(runId);
          if (!removed) {
            return jsonResponse({ error: "run not found" }, 404);
          }
          return jsonResponse({ ok: true });
        }

        return jsonResponse({ error: "method not allowed" }, 405);
      }

      if (pathname === "/api/run") {
        if (method !== "POST") {
          return jsonResponse({ error: "method not allowed" }, 405);
        }

        let parsedPayload: {
          query: string;
          agentCount?: number;
          searchEnabled?: boolean;
        } | null;
        try {
          parsedPayload = parseJsonBody(await req.json());
        } catch {
          parsedPayload = null;
        }

        if (!parsedPayload) {
          return jsonResponse({ error: "invalid run payload" }, 400);
        }

        const config = loadConfig();
        const resolvedAgentCount = clampInt(
          parsedPayload.agentCount ?? config.defaultAgentCount,
          1,
          20,
          config.defaultAgentCount,
        );
        const resolvedSearchEnabled =
          parsedPayload.searchEnabled ?? config.searchEnabled;

        const pipelineConfig: PipelineConfig = {
          apiKey: resolveLlmApiKey(config),
          baseUrl: config.baseUrl,
          model: config.model,
          orchestratorModel: config.orchestratorModel ?? config.model,
          researchModel: config.researchModel ?? config.model,
          searchConfig: resolveSearchConfig(config),
          agentCount: resolvedAgentCount,
          maxConcurrency: config.maxConcurrency,
          debateRounds: config.debateRounds,
          searchEnabled: resolvedSearchEnabled,
          customPersonasOnly: config.customPersonasOnly,
        };

        const pipeline = new HydraPipeline(pipelineConfig);
        const { response, send, close } = createSseResponse();
        const client: SseClient = { send, close };
        let runId: string | null = null;
        let removeClient = () => {};
        let terminalEventHandled = false;
        let terminalClose: Promise<void> | null = null;

        const onPipelineEvent = (event: PipelineEvent): void => {
          if (event.type === "run-created") {
            runId = event.runId;
            activeRunPipelines.set(runId, pipeline);
            removeClient();
            removeClient = addRunClient(runId, client);
          }

          broadcastRunEvent(event.runId, event);

          if (event.type === "run-complete") {
            if (event.runId && !terminalEventHandled) {
              terminalEventHandled = true;
              activeRunPipelines.delete(event.runId);
              terminalClose = closeRunSubscribers(event.runId).catch(() => {
                // ignore terminal cleanup failures while stream is closing.
              });
            }
          } else if (
            event.type === "run-status-changed" &&
            event.status === "error"
          ) {
            if (!terminalEventHandled) {
              terminalEventHandled = true;
              activeRunPipelines.delete(event.runId);
              terminalClose = closeRunSubscribers(event.runId).catch(() => {
                // ignore terminal cleanup failures while stream is closing.
              });
            }
          }
        };

        for (const eventType of pipelineEventTypes) {
          pipeline.on(eventType, onPipelineEvent);
        }

        const cleanupListeners = () => {
          for (const eventType of pipelineEventTypes) {
            pipeline.off(eventType, onPipelineEvent);
          }
        };

        req.signal.addEventListener(
          "abort",
          () => {
            removeClient();
            void close();
          },
          { once: true },
        );

        void (async () => {
          try {
            await pipeline.run(parsedPayload.query);
          } catch (error) {
            console.error(
              `[hydra] pipeline failed to start run ${runId ?? "unknown"}: ${formatErrorMessage(error)}`,
            );
            if (runId && !terminalEventHandled) {
              activeRunPipelines.delete(runId);
              try {
                await send({
                  type: "run-status-changed",
                  runId,
                  status: "error",
                  timestamp: Date.now(),
                });
              } catch {
                // ignore write failures for aborted bootstrap streams.
              }
              terminalClose = closeRunSubscribers(runId).catch(() => {
                // ignore terminal cleanup failures while stream is closing.
              });
            }
            if (!runId) {
              try {
                await send({ type: "done", runId: "" });
              } catch {
                // ignore done writes for interrupted streams.
              }
              return;
            }

            if (terminalClose) {
              await terminalClose;
              return;
            }
            try {
              await send({ type: "done", runId });
            } catch {
              // ignore done writes for interrupted streams.
            }
          } finally {
            cleanupListeners();
            removeClient();
            await close();
          }
        })();

        return response;
      }

      return new Response("not found", {
        status: 404,
        headers: createSecurityHeaders("text/plain; charset=utf-8"),
      });
    },
  });

  console.log(`[hydra] web UI starting at http://localhost:${port}`);
  console.log(`[hydra] open http://localhost:${port} in your browser`);
  await new Promise(() => {});
}
