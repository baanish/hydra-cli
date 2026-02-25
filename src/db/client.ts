import { Database } from "bun:sqlite";
import { mkdirSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { CONFIG_DIR } from "../config";

const DB_DIR = CONFIG_DIR;
const DB_PATH = resolve(DB_DIR, "hydra.db");

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

let db: Database | null = null;

function ensureDbDir() {
  if (!existsSync(DB_DIR)) {
    mkdirSync(DB_DIR, { recursive: true, mode: 0o700 });
  }
}

function initializeSchema(database: Database) {
  database.exec("PRAGMA foreign_keys = ON;");
  database.exec("PRAGMA journal_mode = WAL;");
  database.exec(SCHEMA_SQL);
}

/** return fully qualified path to the sqlite database file. */
export function getDatabasePath(): string {
  return DB_PATH;
}

/** get initialized singleton sqlite connection with required pragmas applied. */
export function getDatabase(): Database {
  if (db) {
    return db;
  }

  ensureDbDir();
  const database = new Database(DB_PATH);
  initializeSchema(database);
  db = database;
  return db;
}

/** close singleton database connection and clear in-memory handle. */
export function closeDatabase() {
  if (db) {
    db.close();
    db = null;
  }
}
