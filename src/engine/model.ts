import OpenAI, {
	APIConnectionError,
	APIConnectionTimeoutError,
	APIError,
} from "openai";
import type {
	ChatCompletion,
	ChatCompletionCreateParamsNonStreaming,
	ChatCompletionMessageParam,
	ChatCompletionTool,
} from "openai/resources/chat/completions";

import { wrapUntrustedToolResult } from "../security";
import type { SearchConfig } from "../types";
import { SEARCH_TOOLS, type SearchToolCall, runSearchTool } from "./search";

type NormalizedRole = "system" | "user" | "assistant" | "tool";
type NormalizedToolCall = {
	id: string;
	type: "function";
	function: {
		name: string;
		arguments: string;
	};
};
type NormalizedMessage =
	| {
			role: "system";
			content: string;
	  }
	| {
			role: "user";
			content: string;
	  }
	| {
			role: "assistant";
			content: string;
			tool_calls?: NormalizedToolCall[];
	  }
	| {
			role: "tool";
			content: string;
			tool_call_id: string;
	  };

/** normalized result from a model invocation including usage and trace. */
export interface ModelRunResult {
	/** normalized output text after model cleanup. */
	output: string;
	messages: NormalizedMessage[];
	searchQueries: string[];
	promptTokens: number;
	completionTokens: number;
	executionStartedAt: number;
}

/** options required to execute a model invocation in the pipeline. */
export interface ModelRunInput {
	apiKey: string;
	baseUrl: string;
	model: string;
	searchConfig: SearchConfig;
	systemPrompt: string;
	userPrompt: string;
	maxToolCalls?: number;
	allowTools?: boolean;
	temperature?: number;
	onExecutionStart?: (timestamp: number) => void;
}

const ALLOWED_ROLES: NormalizedRole[] = ["system", "user", "assistant", "tool"];
const MAX_TOOL_CALLS = 5;
const MAX_TOOL_RESULT_CHARS = 6000;
const MAX_FINAL_CALLS = 1;
const MAX_BACKEND_ATTEMPTS = 5;
const MODEL_CALL_TIMEOUT_MS = 120_000;
const RETRY_BASE_BACKOFF_MS = 5_000;
const RETRY_RATE_LIMIT_BASE_BACKOFF_MS = 30_000;
const RETRY_BACKOFF_MULTIPLIER = 2;
const RETRY_BACKOFF_CAP_MS = 60_000;
const RETRY_JITTER_MAX_MS = 2_000;
const RETRYABLE_STATUS_CODES = new Set([429, 502, 503, 524]);
const RETRYABLE_NETWORK_ERROR_CODES = new Set([
	"ECONNRESET",
	"ETIMEDOUT",
	"ENOTFOUND",
	"ECONNREFUSED",
]);

type RetryDecision = {
	shouldRetry: boolean;
	reason: string;
	baseBackoffMs: number;
};

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => {
		setTimeout(resolve, ms);
	});
}

function createModelCallTimeoutError(
	timeoutMs: number,
): Error & { code: string } {
	const timeoutSeconds = Math.floor(timeoutMs / 1000);
	const error = new Error(
		`ETIMEDOUT from backend (model call exceeded ${timeoutSeconds}s timeout)`,
	) as Error & { code: string };
	error.code = "ETIMEDOUT";
	return error;
}

async function createCompletionWithTimeout(
	client: OpenAI,
	params: ChatCompletionCreateParamsNonStreaming,
): Promise<ChatCompletion> {
	const controller = new AbortController();
	let timeoutHandle: ReturnType<typeof setTimeout> | null = null;

	const timeoutPromise = new Promise<never>((_, reject) => {
		timeoutHandle = setTimeout(() => {
			controller.abort();
			reject(createModelCallTimeoutError(MODEL_CALL_TIMEOUT_MS));
		}, MODEL_CALL_TIMEOUT_MS);
	});

	try {
		const completionPromise = client.chat.completions.create(params, {
			signal: controller.signal,
		}) as Promise<ChatCompletion>;
		return await Promise.race([completionPromise, timeoutPromise]);
	} finally {
		if (timeoutHandle) {
			clearTimeout(timeoutHandle);
		}
	}
}

function resolveNetworkErrorCode(error: unknown): string | null {
	if (!error || typeof error !== "object") {
		return null;
	}

	const maybeError = error as {
		code?: unknown;
		cause?: unknown;
	};

	if (typeof maybeError.code === "string") {
		return maybeError.code.toUpperCase();
	}

	if (!maybeError.cause || typeof maybeError.cause !== "object") {
		return null;
	}

	const cause = maybeError.cause as { code?: unknown };
	if (typeof cause.code === "string") {
		return cause.code.toUpperCase();
	}
	return null;
}

function findRetryableNetworkCode(message: string): string | null {
	const normalized = message.toUpperCase();
	for (const code of RETRYABLE_NETWORK_ERROR_CODES) {
		if (normalized.includes(code)) {
			return code;
		}
	}
	return null;
}

function computeRetryBackoffMs(attempt: number, baseBackoffMs: number): number {
	const exponent = Math.max(0, attempt - 1);
	const exponentialDelayMs = Math.min(
		baseBackoffMs * RETRY_BACKOFF_MULTIPLIER ** exponent,
		RETRY_BACKOFF_CAP_MS,
	);
	const jitterMs =
		attempt <= 1 ? 0 : Math.floor(Math.random() * (RETRY_JITTER_MAX_MS + 1));
	return exponentialDelayMs + jitterMs;
}

function classifyRetryableModelError(error: unknown): RetryDecision {
	if (
		error instanceof APIError &&
		typeof error.status === "number" &&
		RETRYABLE_STATUS_CODES.has(error.status)
	) {
		return {
			shouldRetry: true,
			reason: `${error.status} from backend`,
			baseBackoffMs:
				error.status === 429
					? RETRY_RATE_LIMIT_BASE_BACKOFF_MS
					: RETRY_BASE_BACKOFF_MS,
		};
	}

	const networkCode = resolveNetworkErrorCode(error);
	if (networkCode && RETRYABLE_NETWORK_ERROR_CODES.has(networkCode)) {
		return {
			shouldRetry: true,
			reason: `${networkCode} from backend`,
			baseBackoffMs: RETRY_BASE_BACKOFF_MS,
		};
	}

	if (error instanceof APIConnectionTimeoutError) {
		return {
			shouldRetry: true,
			reason: "ETIMEDOUT from backend",
			baseBackoffMs: RETRY_BASE_BACKOFF_MS,
		};
	}

	if (error instanceof APIConnectionError) {
		const networkCodeFromMessage = findRetryableNetworkCode(error.message);
		if (networkCodeFromMessage) {
			return {
				shouldRetry: true,
				reason: `${networkCodeFromMessage} from backend`,
				baseBackoffMs: RETRY_BASE_BACKOFF_MS,
			};
		}

		if (error.message.toLowerCase().includes("connection error")) {
			return {
				shouldRetry: true,
				reason: "Connection error from backend",
				baseBackoffMs: RETRY_BASE_BACKOFF_MS,
			};
		}

		return {
			shouldRetry: true,
			reason: "APIConnectionError from backend",
			baseBackoffMs: RETRY_BASE_BACKOFF_MS,
		};
	}

	if (error instanceof Error) {
		const networkCodeFromMessage = findRetryableNetworkCode(error.message);
		if (networkCodeFromMessage) {
			return {
				shouldRetry: true,
				reason: `${networkCodeFromMessage} from backend`,
				baseBackoffMs: RETRY_BASE_BACKOFF_MS,
			};
		}

		if (error.message.toLowerCase().includes("connection error")) {
			return {
				shouldRetry: true,
				reason: "Connection error from backend",
				baseBackoffMs: RETRY_BASE_BACKOFF_MS,
			};
		}
	}

	return {
		shouldRetry: false,
		reason:
			error instanceof Error && error.message.trim()
				? error.message.trim()
				: "non-retryable error",
		baseBackoffMs: RETRY_BASE_BACKOFF_MS,
	};
}

async function createCompletionWithRetry(
	client: OpenAI,
	params: ChatCompletionCreateParamsNonStreaming,
) {
	for (let attempt = 1; attempt <= MAX_BACKEND_ATTEMPTS; attempt++) {
		try {
			return await createCompletionWithTimeout(client, params);
		} catch (error) {
			const retryDecision = classifyRetryableModelError(error);
			const shouldRetry =
				retryDecision.shouldRetry && attempt < MAX_BACKEND_ATTEMPTS;
			if (!shouldRetry) {
				throw new Error(
					`API failed after ${attempt} attempt${attempt === 1 ? "" : "s"}: ${retryDecision.reason}`,
				);
			}

			const backoffMs = computeRetryBackoffMs(
				attempt,
				retryDecision.baseBackoffMs,
			);
			console.error(
				`[retry ${attempt}/${MAX_BACKEND_ATTEMPTS}] ${retryDecision.reason}, waiting ${(
					backoffMs / 1000
				).toFixed(1)}s...`,
			);
			await sleep(backoffMs);
		}
	}

	throw new Error("retry loop exited unexpectedly");
}

function isAllowedRole(value: unknown): value is NormalizedRole {
	return (
		typeof value === "string" && ALLOWED_ROLES.includes(value as NormalizedRole)
	);
}

function normalizeAssistantMessage(
	rawMessage: unknown,
	messageIndex: number,
): {
	content: string;
	toolCalls: NormalizedToolCall[];
} {
	if (!rawMessage || typeof rawMessage !== "object") {
		throw new Error(
			`Invalid OpenAI message at index ${messageIndex}: assistant message must be object.`,
		);
	}

	const message = rawMessage as {
		role?: unknown;
		content?: unknown;
		tool_calls?: unknown;
	};

	if (message.role !== "assistant") {
		throw new Error(
			`Invalid OpenAI message at index ${messageIndex}: expected assistant role in model response.`,
		);
	}

	const content = typeof message.content === "string" ? message.content : "";
	if (!Array.isArray(message.tool_calls)) {
		return { content, toolCalls: [] };
	}

	const toolCalls = message.tool_calls.map((toolCall, toolIndex) => {
		if (!toolCall || typeof toolCall !== "object") {
			throw new Error(
				`Invalid assistant tool call at message ${messageIndex}, index ${toolIndex}: must be object.`,
			);
		}

		const call = toolCall as {
			id?: unknown;
			type?: unknown;
			function?: unknown;
		};

		if (typeof call.id !== "string" || !call.id.trim()) {
			throw new Error(
				`Invalid assistant tool call at message ${messageIndex}, index ${toolIndex}: missing id.`,
			);
		}
		if (call.type !== "function") {
			throw new Error(
				`Invalid assistant tool call at message ${messageIndex}, index ${toolIndex}: unsupported type ${String(
					call.type,
				)}.`,
			);
		}
		if (!call.function || typeof call.function !== "object") {
			throw new Error(
				`Invalid assistant tool call at message ${messageIndex}, index ${toolIndex}: missing function object.`,
			);
		}

		const fn = call.function as { name?: unknown; arguments?: unknown };
		if (typeof fn.name !== "string" || !fn.name.trim()) {
			throw new Error(
				`Invalid assistant tool call at message ${messageIndex}, index ${toolIndex}: missing function name.`,
			);
		}
		if (typeof fn.arguments !== "string") {
			throw new Error(
				`Invalid assistant tool call at message ${messageIndex}, index ${toolIndex}: arguments must be JSON string.`,
			);
		}

		return {
			id: call.id,
			type: "function" as const,
			function: {
				name: fn.name,
				arguments: fn.arguments,
			},
		};
	});

	return { content, toolCalls };
}

function normalizeToolMessage(
	rawMessage: unknown,
	messageIndex: number,
): NormalizedMessage {
	if (!rawMessage || typeof rawMessage !== "object") {
		throw new Error(
			`Invalid message at index ${messageIndex}: message must be object.`,
		);
	}

	const message = rawMessage as {
		role?: unknown;
		content?: unknown;
		tool_call_id?: unknown;
		tool_calls?: unknown;
	};

	if (!isAllowedRole(message.role)) {
		throw new Error(`Invalid role at message index ${messageIndex}.`);
	}
	if (typeof message.content !== "string") {
		throw new Error(
			`Invalid content at message index ${messageIndex}: must be string.`,
		);
	}

	if (message.role === "tool") {
		if (
			typeof message.tool_call_id !== "string" ||
			!message.tool_call_id.trim()
		) {
			throw new Error(
				`Invalid tool message at index ${messageIndex}: missing tool_call_id.`,
			);
		}
		return {
			role: "tool",
			content: message.content,
			tool_call_id: message.tool_call_id,
		};
	}

	if (message.role === "assistant") {
		const normalized: NormalizedMessage = {
			role: "assistant",
			content: message.content,
		};
		if (Array.isArray(message.tool_calls)) {
			normalized.tool_calls = message.tool_calls as NormalizedToolCall[];
		}
		return normalized;
	}

	return {
		role: message.role,
		content: message.content,
	};
}

function buildToolArguments(
	rawArgs: string,
	messageIndex: number,
	toolIndex: number,
): SearchToolCall {
	let parsed: { query?: unknown };
	try {
		parsed = JSON.parse(rawArgs) as { query?: unknown };
	} catch {
		throw new Error(
			`Tool arguments at message ${messageIndex}, tool ${toolIndex} are invalid JSON.`,
		);
	}

	if (typeof parsed.query !== "string" || !parsed.query.trim()) {
		throw new Error(
			`Tool call at message ${messageIndex}, tool ${toolIndex} missing query argument.`,
		);
	}

	return { query: parsed.query };
}

function validateMessages(messages: NormalizedMessage[]) {
	messages.forEach((message, index) => {
		if (!ALLOWED_ROLES.includes(message.role)) {
			throw new Error(`Invalid role in message ${index}.`);
		}
		if (typeof message.content !== "string") {
			throw new Error(`Invalid message content at index ${index}.`);
		}
		if (message.role === "tool") {
			if (
				typeof message.tool_call_id !== "string" ||
				!message.tool_call_id.trim()
			) {
				throw new Error(
					`Invalid tool message at index ${index}: missing tool_call_id.`,
				);
			}
		}
	});
}

function toolResultMessage(toolCallId: string, result: unknown) {
	const serializedResult = cleanSearchResultOutput(
		JSON.stringify(result),
		MAX_TOOL_RESULT_CHARS,
	);
	return {
		role: "tool",
		tool_call_id: toolCallId,
		content: wrapUntrustedToolResult(serializedResult),
	} as NormalizedMessage;
}

/** strip tool-call wrapper tags from model output before presentation. */
export function cleanModelOutput(text: string): string {
	return text
		.replace(
			/<\|tool_calls_section_begin\|>[\s\S]*?<\|tool_calls_section_end\|>/g,
			"",
		)
		.replace(/<\|tool_call_begin\|>[\s\S]*?<\|tool_call_end\|>/g, "")
		.replace(/<\|tool_calls_section_begin\|>[\s\S]*/g, "")
		.trim();
}

/** run a model turn with optional search/tool calling and return normalized artifacts. */
export async function runModelWithOptionalTools(
	input: ModelRunInput,
): Promise<ModelRunResult> {
	const client = new OpenAI({
		apiKey: input.apiKey,
		baseURL: input.baseUrl,
	});

	const messages: NormalizedMessage[] = [
		{ role: "system", content: input.systemPrompt },
		{ role: "user", content: input.userPrompt },
	];

	const allowTools = input.allowTools !== false;
	const maxToolCalls = Math.min(
		Math.max(0, Math.floor(input.maxToolCalls ?? MAX_TOOL_CALLS)),
		MAX_TOOL_CALLS,
	);
	const tools: ChatCompletionTool[] | undefined = allowTools
		? (SEARCH_TOOLS as ChatCompletionTool[])
		: undefined;

	const searchQueries: string[] = [];
	let promptTokens = 0;
	let completionTokens = 0;
	const executionStartedAt = Date.now();
	let executionNotified = false;
	const notifyExecutionStart = () => {
		if (executionNotified) {
			return;
		}
		executionNotified = true;
		input.onExecutionStart?.(executionStartedAt);
	};
	let toolCallsUsed = 0;
	const hasBudget = (toolCallsUsed: number) => toolCallsUsed < maxToolCalls;

	notifyExecutionStart();
	for (let i = 0; i < maxToolCalls; i++) {
		validateMessages(messages);

		const completion = await createCompletionWithRetry(client, {
			model: input.model,
			messages: messages as ChatCompletionMessageParam[],
			tools,
			tool_choice: allowTools ? "auto" : undefined,
			temperature: input.temperature ?? 0.5,
		});

		promptTokens += completion.usage?.prompt_tokens ?? 0;
		completionTokens += completion.usage?.completion_tokens ?? 0;

		const firstMessage = completion.choices[0]?.message;
		if (!firstMessage) {
			throw new Error("Model returned empty response.");
		}

		const normalized = normalizeAssistantMessage(firstMessage, messages.length);
		messages.push(
			normalizeToolMessage(
				{
					role: "assistant",
					content: normalized.content,
					...(normalized.toolCalls.length > 0
						? { tool_calls: normalized.toolCalls }
						: {}),
				},
				messages.length,
			),
		);

		if (!allowTools || normalized.toolCalls.length === 0) {
			return {
				output: cleanModelOutput(normalized.content),
				messages,
				searchQueries,
				promptTokens,
				completionTokens,
				executionStartedAt,
			};
		}

		let budgetExceeded = false;

		for (const [toolIndex, toolCall] of normalized.toolCalls.entries()) {
			if (!hasBudget(toolCallsUsed)) {
				budgetExceeded = true;
				messages.push(
					normalizeToolMessage(
						toolResultMessage(toolCall.id, {
							error:
								"Tool call budget exceeded. No remaining tool calls allowed for this run.",
						}),
						messages.length,
					),
				);
				continue;
			}

			try {
				const args = buildToolArguments(
					toolCall.function.arguments,
					messages.length - 1,
					toolIndex,
				);
				searchQueries.push(`web_search: ${args.query}`);
				toolCallsUsed += 1;
				const result = await runSearchTool(
					toolCall.function.name,
					args,
					input.searchConfig,
				);
				messages.push(
					normalizeToolMessage(
						toolResultMessage(toolCall.id, result),
						messages.length,
					),
				);
			} catch (error) {
				const payload =
					error instanceof Error
						? { error: error.message }
						: { error: "Tool execution failed." };
				messages.push(
					normalizeToolMessage(
						toolResultMessage(toolCall.id, payload),
						messages.length,
					),
				);
			}
		}

		if (budgetExceeded || !hasBudget(toolCallsUsed)) {
			break;
		}
	}

	// Force one final text-only pass if tool-call limit is hit.
	for (let attempt = 0; attempt < MAX_FINAL_CALLS; attempt++) {
		validateMessages(messages);
		const completion = await createCompletionWithRetry(client, {
			model: input.model,
			messages: messages as ChatCompletionMessageParam[],
			temperature: input.temperature ?? 0.5,
			tools: undefined,
			tool_choice: undefined,
		});

		promptTokens += completion.usage?.prompt_tokens ?? 0;
		completionTokens += completion.usage?.completion_tokens ?? 0;

		const finalMessage = completion.choices[0]?.message;
		if (!finalMessage) {
			break;
		}

		const output = cleanModelOutput(
			typeof finalMessage.content === "string" ? finalMessage.content : "",
		);
		messages.push(
			normalizeToolMessage(
				{ role: "assistant", content: finalMessage.content ?? "" },
				messages.length,
			),
		);

		if (output.length > 0 || attempt >= MAX_FINAL_CALLS - 1) {
			return {
				output,
				messages,
				searchQueries,
				promptTokens,
				completionTokens,
				executionStartedAt,
			};
		}
	}

	return {
		output: "",
		messages,
		searchQueries,
		promptTokens,
		completionTokens,
		executionStartedAt,
	};
}

/** run a model turn with tool support explicitly enabled. */
export async function runModelWithTools(
	input: ModelRunInput,
): Promise<ModelRunResult> {
	return runModelWithOptionalTools({ ...input, allowTools: true });
}

/** clip tool-call result text to avoid runaway token usage in context. */
export function cleanSearchResultOutput(
	resultText: string,
	maxChars = MAX_TOOL_RESULT_CHARS,
): string {
	return resultText.length <= maxChars
		? resultText
		: `${resultText.slice(0, maxChars)}\n\n[... truncated]`;
}
