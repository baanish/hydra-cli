import { nanoid } from "nanoid";

import type {
	AgentPhase,
	AgentRunRecord,
	AgentRunStatus,
	RunRecord,
	RunStatus,
} from "../types.js";
import { getDatabase } from "./client.js";

type DbRunRow = {
	id: string;
	query: string;
	agent_count: number;
	status: RunStatus;
	brief: string | null;
	error: string | null;
	pipeline_state: string | null;
	total_prompt_tokens: number;
	total_completion_tokens: number;
	created_at: number;
	completed_at: number | null;
	elapsed_ms: number | null;
};

type DbAgentRunRow = {
	id: string;
	run_id: string;
	phase: AgentPhase;
	persona: string;
	system_prompt: string;
	messages: string | null;
	output: string;
	search_queries: string | null;
	status: AgentRunStatus;
	prompt_tokens: number;
	completion_tokens: number;
	started_at: number;
	completed_at: number | null;
};

type RunStatusPatch = Partial<
	Pick<
		RunRecord,
		| "query"
		| "status"
		| "brief"
		| "error"
		| "pipelineState"
		| "totalPromptTokens"
		| "totalCompletionTokens"
		| "completedAt"
		| "elapsedMs"
	>
>;

type AgentRunStatusPatch = Partial<
	Omit<
		Pick<
			AgentRunRecord,
			| "messages"
			| "output"
			| "status"
			| "promptTokens"
			| "completionTokens"
			| "completedAt"
		>,
		"searchQueries"
	> & {
		searchQueries?: string[];
		startedAt?: number;
	}
>;

function toRunRecord(row: DbRunRow): RunRecord {
	return {
		id: row.id,
		query: row.query,
		agentCount: row.agent_count,
		status: row.status,
		brief: row.brief,
		error: row.error,
		pipelineState: row.pipeline_state,
		totalPromptTokens: row.total_prompt_tokens,
		totalCompletionTokens: row.total_completion_tokens,
		createdAt: row.created_at,
		completedAt: row.completed_at,
		elapsedMs: row.elapsed_ms,
	};
}

function toAgentRunRecord(row: DbAgentRunRow): AgentRunRecord {
	return {
		id: row.id,
		runId: row.run_id,
		phase: row.phase,
		persona: row.persona,
		systemPrompt: row.system_prompt,
		messages: row.messages ?? "[]",
		output: row.output,
		searchQueries: row.search_queries ?? "[]",
		status: row.status,
		promptTokens: row.prompt_tokens,
		completionTokens: row.completion_tokens,
		startedAt: row.started_at,
		completedAt: row.completed_at,
	};
}

function normalizeTokenValue(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function toDbRunValues(input: {
	query: string;
	agentCount: number;
	status?: RunStatus;
	pipelineState?: string | null;
}): Pick<
	DbRunRow,
	"id" | "query" | "agent_count" | "status" | "pipeline_state" | "created_at"
> {
	const now = Date.now();
	return {
		id: nanoid(),
		query: input.query,
		agent_count: input.agentCount,
		status: input.status ?? "decomposing",
		pipeline_state: input.pipelineState ?? null,
		created_at: now,
	};
}

function toDbAgentRunValues(input: {
	runId: string;
	phase: AgentPhase;
	persona: string;
	systemPrompt: string;
	messages?: string;
	output?: string;
	searchQueries?: string[];
	status?: AgentRunStatus;
	promptTokens?: number;
	completionTokens?: number;
	startedAt?: number;
	completedAt?: number | null;
}) {
	return {
		id: nanoid(),
		run_id: input.runId,
		phase: input.phase,
		persona: input.persona,
		system_prompt: input.systemPrompt,
		messages: input.messages ?? "[]",
		output: input.output ?? "",
		search_queries: JSON.stringify(input.searchQueries ?? []),
		status: input.status ?? "running",
		prompt_tokens: input.promptTokens ?? 0,
		completion_tokens: input.completionTokens ?? 0,
		started_at: input.startedAt ?? Date.now(),
		completed_at: input.completedAt ?? null,
	};
}

const RUNS_SELECT = `
  SELECT
    id, query, agent_count, status, brief, error, pipeline_state,
    total_prompt_tokens, total_completion_tokens, created_at, completed_at, elapsed_ms
  FROM runs
`;

const AGENT_RUNS_SELECT = `
  SELECT
    id, run_id, phase, persona, system_prompt, messages, output, search_queries,
    status, prompt_tokens, completion_tokens, started_at, completed_at
  FROM agent_runs
`;

/** create a new top-level run row and return the persisted record. */
export function createRun(input: {
	query: string;
	agentCount: number;
	status?: RunStatus;
	pipelineState?: string | null;
}): RunRecord {
	const db = getDatabase();
	const row = toDbRunValues(input);

	db.prepare(
		`
    INSERT INTO runs (
      id, query, agent_count, status, brief, error, pipeline_state,
      total_prompt_tokens, total_completion_tokens, created_at, completed_at, elapsed_ms
    )
    VALUES (
      ?, ?, ?, ?, NULL, NULL, ?, 0, 0, ?, NULL, NULL
    )
    `,
	).run(
		row.id,
		row.query,
		row.agent_count,
		row.status,
		row.pipeline_state,
		row.created_at,
	);

	const created = getRun(row.id);
	if (!created) {
		throw new Error(`Run ${row.id} not found`);
	}

	return created;
}

/** build a patch for updating top-level run columns while enforcing defaults. */
function buildRunPatch(patch: RunStatusPatch): {
	fields: string[];
	values: Array<string | number | null>;
} {
	const fields: string[] = [];
	const values: Array<string | number | null> = [];

	if (patch.query !== undefined) {
		fields.push("query = ?");
		values.push(patch.query);
	}
	if (patch.status !== undefined) {
		fields.push("status = ?");
		values.push(patch.status);
	}
	if (patch.brief !== undefined) {
		fields.push("brief = ?");
		values.push(patch.brief);
	}
	if (patch.error !== undefined) {
		fields.push("error = ?");
		values.push(patch.error);
	}
	if (patch.pipelineState !== undefined) {
		fields.push("pipeline_state = ?");
		values.push(patch.pipelineState);
	}
	if (patch.totalPromptTokens !== undefined) {
		fields.push("total_prompt_tokens = ?");
		values.push(patch.totalPromptTokens);
	}
	if (patch.totalCompletionTokens !== undefined) {
		fields.push("total_completion_tokens = ?");
		values.push(patch.totalCompletionTokens);
	}
	if (patch.completedAt !== undefined) {
		fields.push("completed_at = ?");
		values.push(patch.completedAt);
	}
	if (patch.elapsedMs !== undefined) {
		fields.push("elapsed_ms = ?");
		values.push(patch.elapsedMs);
	}

	return { fields, values };
}

/** update a run record and return the fresh persisted record. */
export function updateRunStatus(
	runId: string,
	patch: RunStatusPatch,
): RunRecord {
	const db = getDatabase();
	const { fields, values } = buildRunPatch(patch);

	if (fields.length === 0) {
		const run = getRun(runId);
		if (!run) {
			throw new Error(`Run ${runId} not found`);
		}
		return run;
	}

	db.prepare(`UPDATE runs SET ${fields.join(", ")} WHERE id = ?`).run(
		...values,
		runId,
	);

	const updated = getRun(runId);
	if (!updated) {
		throw new Error(`Run ${runId} not found`);
	}
	return updated;
}

/** fetch a single run by id or return null. */
export function getRun(runId: string): RunRecord | null {
	const db = getDatabase();
	const row = db
		.prepare(`${RUNS_SELECT} WHERE id = ?`)
		.get(runId) as DbRunRow | null;
	return row ? toRunRecord(row) : null;
}

/** list recent runs in descending creation order, clamped to a safe page size. */
export function listRuns(limit = 50): RunRecord[] {
	const db = getDatabase();
	const rows = db
		.prepare(`${RUNS_SELECT} ORDER BY created_at DESC LIMIT ?`)
		.all(Math.max(1, Math.min(limit, 500))) as DbRunRow[];
	return rows.map(toRunRecord);
}

/** delete a run and its dependent agent rows. */
export function deleteRun(runId: string): boolean {
	const db = getDatabase();
	deleteAgentRunsForRun(runId);
	const result = db.prepare("DELETE FROM runs WHERE id = ?").run(runId);
	return result.changes > 0;
}

/** create a new agent run row in the database. */
export function createAgentRun(input: {
	runId: string;
	phase: AgentPhase;
	persona: string;
	systemPrompt: string;
	messages?: string;
	output?: string;
	searchQueries?: string[];
	status?: AgentRunStatus;
	promptTokens?: number;
	completionTokens?: number;
	startedAt?: number;
	completedAt?: number | null;
}): AgentRunRecord {
	const db = getDatabase();
	const row = toDbAgentRunValues(input);

	db.prepare(
		`
    INSERT INTO agent_runs (
      id, run_id, phase, persona, system_prompt, messages, output, search_queries,
      status, prompt_tokens, completion_tokens, started_at, completed_at
    )
    VALUES (
      ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
    )
    `,
	).run(
		row.id,
		row.run_id,
		row.phase,
		row.persona,
		row.system_prompt,
		row.messages,
		row.output,
		row.search_queries,
		row.status,
		row.prompt_tokens,
		row.completion_tokens,
		row.started_at,
		row.completed_at,
	);

	const agentRun = getAgentRun(row.id);
	if (!agentRun) {
		throw new Error(`Failed to create agent run ${row.id}`);
	}
	return agentRun;
}

/** build a patch for updating agent run columns. */
function buildAgentRunPatch(patch: AgentRunStatusPatch): {
	fields: string[];
	values: Array<string | number | null>;
} {
	const fields: string[] = [];
	const values: Array<string | number | null> = [];

	if (patch.messages !== undefined) {
		fields.push("messages = ?");
		values.push(patch.messages);
	}
	if (patch.output !== undefined) {
		fields.push("output = ?");
		values.push(patch.output);
	}
	if (patch.searchQueries !== undefined) {
		fields.push("search_queries = ?");
		values.push(JSON.stringify(patch.searchQueries));
	}
	if (patch.status !== undefined) {
		fields.push("status = ?");
		values.push(patch.status);
	}
	if (patch.promptTokens !== undefined) {
		fields.push("prompt_tokens = ?");
		values.push(normalizeTokenValue(patch.promptTokens));
	}
	if (patch.completionTokens !== undefined) {
		fields.push("completion_tokens = ?");
		values.push(normalizeTokenValue(patch.completionTokens));
	}
	if (patch.completedAt !== undefined) {
		fields.push("completed_at = ?");
		values.push(patch.completedAt);
	}
	if (patch.startedAt !== undefined) {
		fields.push("started_at = ?");
		values.push(patch.startedAt);
	}

	return { fields, values };
}

/** apply status/output changes to an agent run and return updated state. */
export function updateAgentRun(
	agentRunId: string,
	patch: AgentRunStatusPatch,
): AgentRunRecord {
	const db = getDatabase();
	const { fields, values } = buildAgentRunPatch(patch);

	if (fields.length === 0) {
		const existing = getAgentRun(agentRunId);
		if (!existing) {
			throw new Error(`Agent run ${agentRunId} not found`);
		}
		return existing;
	}

	db.prepare(`UPDATE agent_runs SET ${fields.join(", ")} WHERE id = ?`).run(
		...values,
		agentRunId,
	);

	const run = getAgentRun(agentRunId);
	if (!run) {
		throw new Error(`Agent run ${agentRunId} not found`);
	}
	return run;
}

/** mark an agent run complete and persist usage and status metadata. */
export function completeAgentRun(
	agentRunId: string,
	output: string,
	options?: {
		status?: AgentRunStatus;
		searchQueries?: string[];
		promptTokens?: number;
		completionTokens?: number;
	},
): AgentRunRecord {
	return updateAgentRun(agentRunId, {
		output,
		status: options?.status ?? "complete",
		searchQueries: options?.searchQueries,
		promptTokens: options?.promptTokens,
		completionTokens: options?.completionTokens,
		completedAt: Date.now(),
	});
}

/** fetch a single agent run or return null. */
export function getAgentRun(agentRunId: string): AgentRunRecord | null {
	const db = getDatabase();
	const row = db
		.prepare(`${AGENT_RUNS_SELECT} WHERE id = ?`)
		.get(agentRunId) as DbAgentRunRow | null;
	return row ? toAgentRunRecord(row) : null;
}

/** fetch all agent runs for a run ordered by start time. */
export function getAgentRunsForRun(runId: string): AgentRunRecord[] {
	const db = getDatabase();
	const rows = db
		.prepare(`${AGENT_RUNS_SELECT} WHERE run_id = ? ORDER BY rowid`)
		.all(runId) as DbAgentRunRow[];
	return rows.map(toAgentRunRecord);
}

/** alias for `getAgentRunsForRun` retained for compatibility. */
export function getRunAgentRuns(runId: string): AgentRunRecord[] {
	return getAgentRunsForRun(runId);
}

/** delete all agent runs tied to a run id. */
export function deleteAgentRunsForRun(runId: string): void {
	const db = getDatabase();
	db.prepare("DELETE FROM agent_runs WHERE run_id = ?").run(runId);
}

/** legacy alias for `deleteRun` kept for compatibility. */
export const deleteRunRecords = deleteRun;

/** mark a run complete with final brief and compute elapsed wall time. */
export function markRunComplete(runId: string, brief: string): RunRecord {
	const run = getRun(runId);
	if (!run) {
		throw new Error(`Run ${runId} not found`);
	}
	const completedAt = Date.now();

	return updateRunStatus(runId, {
		status: "complete",
		brief,
		completedAt,
		elapsedMs: completedAt - run.createdAt,
		error: null,
	});
}

/** mark a run as failed and store the error message. */
export function markRunFailed(runId: string, error: string): RunRecord {
	const run = getRun(runId);
	if (!run) {
		throw new Error(`Run ${runId} not found`);
	}

	return updateRunStatus(runId, {
		status: "error",
		error,
		completedAt: Date.now(),
		elapsedMs: Date.now() - run.createdAt,
	});
}

/** increment token usage counters on a run. */
export function addTokenUsage(
	runId: string,
	promptTokens: number,
	completionTokens: number,
): void {
	const db = getDatabase();
	db.prepare(
		`
    UPDATE runs
    SET total_prompt_tokens = total_prompt_tokens + ?, total_completion_tokens = total_completion_tokens + ?
    WHERE id = ?
  `,
	).run(promptTokens, completionTokens, runId);
}

// Backward-compatible aliases for older callers.
/** backwards-compatible alias for `updateRunStatus`. */
export const updateRun = updateRunStatus;
/** backwards-compatible alias for `deleteRun`. */
export const removeRun = deleteRun;
