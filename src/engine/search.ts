import type { SearchConfig, SearchResult } from "../types";

/** arguments expected by `web_search` tool calls. */
export type SearchToolCall = {
  query: string;
};

/** web search function tool schema exposed to the llm for function calls. */
export const WEB_SEARCH_TOOL = {
  type: "function" as const,
  function: {
    name: "web_search",
    description: "Search the web for current information. Returns ~5 results with full text.",
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Search query",
        },
      },
      required: ["query"],
    },
  },
};

/** list of available function tools for tool-enabled model runs. */
export const SEARCH_TOOLS = [WEB_SEARCH_TOOL];

const SYNTHETIC_SEARCH_URL = "https://api.synthetic.new/v2/search";
const EXA_SEARCH_URL = "https://api.exa.ai/search";
const BRAVE_SEARCH_URL = "https://api.search.brave.com/res/v1/web/search";

type SearchResultCandidate = {
  title?: unknown;
  url?: unknown;
  text?: unknown;
  description?: unknown;
  snippet?: unknown;
  published?: unknown;
  publishedDate?: unknown;
  date?: unknown;
};

function normalizeResult(raw: SearchResultCandidate): SearchResult {
  return {
    title: typeof raw.title === "string" ? raw.title : "",
    url: typeof raw.url === "string" ? raw.url : "",
    text:
      typeof raw.text === "string"
        ? raw.text
        : typeof raw.description === "string"
          ? raw.description
          : typeof raw.snippet === "string"
            ? raw.snippet
            : "",
    published:
      typeof raw.published === "string"
        ? raw.published
        : typeof raw.publishedDate === "string"
          ? raw.publishedDate
          : typeof raw.date === "string"
            ? raw.date
            : null,
  };
}

function withSearchTimeout(url: string, requestInit: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30_000);
  return fetch(url, {
    ...requestInit,
    signal: controller.signal,
  }).finally(() => {
    clearTimeout(timeout);
  });
}

function warnUntestedSearch(provider: "exa" | "brave"): void {
  console.warn(`[hydra] Warning: ${provider} search is community-contributed and untested. PRs welcome!`);
}

async function runSyntheticSearch(query: string, apiKey: string): Promise<SearchResult[]> {
  const trimmedQuery = query.trim();
  if (!trimmedQuery) {
    return [];
  }

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${apiKey}`,
  };

  let response = await withSearchTimeout(SYNTHETIC_SEARCH_URL, {
    method: "POST",
    headers,
    body: JSON.stringify({ query: trimmedQuery }),
  });

  if (response.status === 401) {
    response = await withSearchTimeout(SYNTHETIC_SEARCH_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-API-Key": apiKey,
      },
      body: JSON.stringify({ query: trimmedQuery }),
    });
  }

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Synthetic search failed (${response.status}): ${body}`);
  }

  const payload = (await response.json()) as {
    results?: SearchResultCandidate[];
    data?: SearchResultCandidate[];
  };

  const rawResults = payload.results ?? payload.data ?? [];
  return rawResults.map(normalizeResult);
}

async function runExaSearch(query: string, apiKey: string): Promise<SearchResult[]> {
  warnUntestedSearch("exa");
  const trimmedQuery = query.trim();
  if (!trimmedQuery) {
    return [];
  }

  const response = await withSearchTimeout(EXA_SEARCH_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      query: trimmedQuery,
      num_results: 5,
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Exa search failed (${response.status}): ${body}`);
  }

  const payload = (await response.json()) as {
    results?: SearchResultCandidate[];
  };

  return (payload.results ?? []).map(normalizeResult);
}

async function runBraveSearch(query: string, apiKey: string): Promise<SearchResult[]> {
  warnUntestedSearch("brave");
  const trimmedQuery = query.trim();
  if (!trimmedQuery) {
    return [];
  }

  const url = new URL(BRAVE_SEARCH_URL);
  url.searchParams.set("q", trimmedQuery);
  url.searchParams.set("count", "5");

  const response = await withSearchTimeout(url.toString(), {
    method: "GET",
    headers: {
      Accept: "application/json",
      "X-Subscription-Token": apiKey,
    },
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Brave search failed (${response.status}): ${body}`);
  }

  const payload = (await response.json()) as {
    web?: {
      results?: SearchResultCandidate[];
    };
    results?: SearchResultCandidate[];
  };

  const rawResults = payload.web?.results ?? payload.results ?? [];
  return rawResults.map(normalizeResult);
}

/** run search through configured provider and return normalized results. */
export async function runWebSearch(query: string, config: SearchConfig): Promise<SearchResult[]> {
  const trimmedQuery = query.trim();
  if (!trimmedQuery) {
    return [];
  }

  if (config.provider === "exa") {
    return runExaSearch(trimmedQuery, config.exaApiKey);
  }

  if (config.provider === "brave") {
    return runBraveSearch(trimmedQuery, config.braveApiKey);
  }

  return runSyntheticSearch(trimmedQuery, config.syntheticApiKey);
}

/** invoke a named search tool with args using configured provider credentials. */
export async function runSearchTool(
  name: string,
  args: SearchToolCall,
  searchConfig: SearchConfig,
): Promise<unknown> {
  if (name !== "web_search") {
    return { error: `Unsupported tool: ${name}` };
  }

  return runWebSearch(args.query, searchConfig);
}
