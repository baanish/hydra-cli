import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import type { ModelRunInput } from "./model.js";

type CreateHandler = (
	params: unknown,
	options?: { signal?: AbortSignal },
) => Promise<unknown>;

type TimerHandle = {
	cleared: boolean;
};

let createCalls: Array<{
	params: unknown;
	options?: { signal?: AbortSignal };
}> = [];
let createHandler: CreateHandler = async () => {
	throw new Error("create handler not configured");
};
let timerRestore: (() => void) | null = null;

class MockAPIError extends Error {
	status?: number;

	constructor(status: number, message?: string) {
		super(message ?? `status ${status}`);
		this.status = status;
	}
}

class MockAPIConnectionError extends Error {}
class MockAPIConnectionTimeoutError extends MockAPIConnectionError {}

class MockOpenAI {
	chat = {
		completions: {
			create: (params: unknown, options?: { signal?: AbortSignal }) => {
				createCalls.push({ params, options });
				return createHandler(params, options);
			},
		},
	};
}

vi.doMock("openai", () => ({
	default: MockOpenAI,
	APIError: MockAPIError,
	APIConnectionError: MockAPIConnectionError,
	APIConnectionTimeoutError: MockAPIConnectionTimeoutError,
}));

const { runModelWithOptionalTools } = await import("./model.js");

function completion(content: string) {
	return {
		choices: [
			{
				message: {
					role: "assistant",
					content,
				},
			},
		],
		usage: {
			prompt_tokens: 10,
			completion_tokens: 4,
		},
	};
}

function baseInput(overrides: Partial<ModelRunInput> = {}): ModelRunInput {
	return {
		apiKey: "test-key",
		baseUrl: "https://example.invalid/v1",
		model: "hf:test/model",
		searchConfig: {
			provider: "synthetic",
			syntheticApiKey: "synthetic-key",
			exaApiKey: "",
			braveApiKey: "",
		},
		systemPrompt: "system",
		userPrompt: "user",
		allowTools: false,
		maxToolCalls: 1,
		...overrides,
	};
}

function interceptTimers(fireLongTimeout: boolean): {
	delays: number[];
	restore: () => void;
} {
	const delays: number[] = [];
	const originalSetTimeout = globalThis.setTimeout;
	const originalClearTimeout = globalThis.clearTimeout;
	const handles = new Map<TimerHandle, TimerHandle>();

	globalThis.setTimeout = ((
		callback: TimerHandler,
		ms?: number | undefined,
		...args: unknown[]
	) => {
		const delay = Number(ms ?? 0);
		delays.push(delay);
		const handle: TimerHandle = { cleared: false };
		handles.set(handle, handle);

		const shouldFire = fireLongTimeout || delay < 120_000;
		if (shouldFire) {
			queueMicrotask(() => {
				const state = handles.get(handle);
				if (state?.cleared) {
					return;
				}
				if (typeof callback === "function") {
					callback(...args);
				}
			});
		}

		return handle as unknown as ReturnType<typeof setTimeout>;
	}) as unknown as typeof setTimeout;

	globalThis.clearTimeout = ((timeout: ReturnType<typeof setTimeout>) => {
		const handle = timeout as unknown as TimerHandle;
		if (handles.has(handle)) {
			handle.cleared = true;
		}
	}) as typeof clearTimeout;

	const restore = () => {
		globalThis.setTimeout = originalSetTimeout;
		globalThis.clearTimeout = originalClearTimeout;
	};
	timerRestore = restore;

	return {
		delays,
		restore,
	};
}

beforeEach(() => {
	createCalls = [];
	createHandler = async () => completion("ok");
});

afterEach(() => {
	timerRestore?.();
	timerRestore = null;
});

describe("runModelWithOptionalTools retry behavior", () => {
	test("succeeds on first try", async () => {
		const result = await runModelWithOptionalTools(baseInput());

		expect(result.output).toBe("ok");
		expect(createCalls).toHaveLength(1);
		expect(createCalls[0]?.options?.signal).toBeInstanceOf(AbortSignal);
	});

	test("retries on 524 and then succeeds", async () => {
		const timers = interceptTimers(false);
		let attempt = 0;
		createHandler = async () => {
			attempt += 1;
			if (attempt === 1) {
				throw new MockAPIError(524, "gateway timeout");
			}
			return completion("recovered");
		};

		const result = await runModelWithOptionalTools(baseInput());
		expect(result.output).toBe("recovered");
		expect(createCalls).toHaveLength(2);
		expect(timers.delays).toContain(5_000);
	});

	test("retries on 429 with longer base backoff", async () => {
		const timers = interceptTimers(false);
		let attempt = 0;
		createHandler = async () => {
			attempt += 1;
			if (attempt === 1) {
				throw new MockAPIError(429, "rate limited");
			}
			return completion("ok-after-rate-limit");
		};

		const result = await runModelWithOptionalTools(baseInput());
		expect(result.output).toBe("ok-after-rate-limit");
		expect(createCalls).toHaveLength(2);
		expect(timers.delays).toContain(30_000);
	});

	test("fails after max retries", async () => {
		interceptTimers(false);
		createHandler = async () => {
			throw new MockAPIError(524, "gateway timeout");
		};

		await expect(runModelWithOptionalTools(baseInput())).rejects.toThrow(
			"API failed after 5 attempts: 524 from backend",
		);
		expect(createCalls).toHaveLength(5);
	});

	test("per-call timeout fires and aborts hung requests", async () => {
		const timers = interceptTimers(true);
		createHandler = async () => new Promise(() => undefined);

		await expect(runModelWithOptionalTools(baseInput())).rejects.toThrow(
			"API failed after 5 attempts: ETIMEDOUT from backend",
		);

		expect(createCalls).toHaveLength(5);
		expect(timers.delays.filter((delay) => delay === 120_000).length).toBe(
			createCalls.length,
		);
	});
});
