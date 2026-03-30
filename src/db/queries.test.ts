import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY,
  query TEXT NOT NULL,
  agent_count INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'decomposing',
  brief TEXT,
  error TEXT,
  pipeline_state TEXT,
  total_prompt_tokens INTEGER DEFAULT 0,
  total_completion_tokens INTEGER DEFAULT 0,
  created_at INTEGER NOT NULL,
  completed_at INTEGER,
  elapsed_ms INTEGER
);

CREATE TABLE IF NOT EXISTS agent_runs (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  phase TEXT NOT NULL,
  persona TEXT NOT NULL,
  system_prompt TEXT NOT NULL,
  messages TEXT,
  output TEXT DEFAULT '',
  search_queries TEXT,
  status TEXT NOT NULL DEFAULT 'running',
  prompt_tokens INTEGER DEFAULT 0,
  completion_tokens INTEGER DEFAULT 0,
  started_at INTEGER NOT NULL,
  completed_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_agent_runs_run_id ON agent_runs(run_id);
`;

let db: InstanceType<typeof Database>;
let idCounter = 0;
const originalDateNow = Date.now;

vi.doMock("./client.js", () => ({
	getDatabase: () => db,
}));

vi.doMock("nanoid", () => ({
	nanoid: () => `id-${++idCounter}`,
}));

const { createRun, getRun, listRuns, markRunComplete, markRunFailed } =
	await import("./queries.js");

beforeEach(() => {
	let now = 1_000_000;
	Date.now = () => now++;

	idCounter = 0;
	db = new Database(":memory:");
	db.exec("PRAGMA foreign_keys = ON;");
	db.exec(SCHEMA_SQL);
});

afterEach(() => {
	Date.now = originalDateNow;
	db.close();
});

describe("db/queries", () => {
	test("createRun persists and getRun fetches by id", () => {
		const created = createRun({
			query: "what changed?",
			agentCount: 4,
			pipelineState: "{}",
		});

		const fetched = getRun(created.id);
		expect(fetched).not.toBeNull();
		expect(fetched?.id).toBe(created.id);
		expect(fetched?.query).toBe("what changed?");
		expect(fetched?.agentCount).toBe(4);
		expect(fetched?.status).toBe("decomposing");
	});

	test("markRunComplete stores brief, status, and elapsed", () => {
		const run = createRun({ query: "q", agentCount: 2 });
		const completed = markRunComplete(run.id, "final brief");

		expect(completed.status).toBe("complete");
		expect(completed.brief).toBe("final brief");
		expect(completed.error).toBeNull();
		expect(typeof completed.elapsedMs).toBe("number");
		expect(completed.elapsedMs).toBeGreaterThanOrEqual(0);
	});

	test("markRunFailed stores error and status", () => {
		const run = createRun({ query: "q", agentCount: 2 });
		const failed = markRunFailed(run.id, "kaboom");

		expect(failed.status).toBe("error");
		expect(failed.error).toBe("kaboom");
		expect(typeof failed.elapsedMs).toBe("number");
		expect(failed.elapsedMs).toBeGreaterThanOrEqual(0);
	});

	test("listRuns returns newest-first and honors limit", () => {
		const first = createRun({ query: "first", agentCount: 1 });
		const second = createRun({ query: "second", agentCount: 1 });
		const third = createRun({ query: "third", agentCount: 1 });

		const listed = listRuns(2);
		expect(listed).toHaveLength(2);
		expect(listed.map((run) => run.id)).toEqual([third.id, second.id]);

		// sanity check that oldest exists when requesting more rows
		const all = listRuns(10);
		expect(all.map((run) => run.id)).toContain(first.id);
	});
});
