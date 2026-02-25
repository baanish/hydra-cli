import { describe, expect, test } from "bun:test";

import { runWithConcurrency } from "./concurrency";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("runWithConcurrency", () => {
  test("respects concurrency limit and preserves result ordering", async () => {
    const items = Array.from({ length: 12 }, (_, index) => index);
    let running = 0;
    let maxRunning = 0;

    const results = await runWithConcurrency(items, 3, async (item) => {
      running += 1;
      maxRunning = Math.max(maxRunning, running);
      await sleep(8);
      running -= 1;
      return item * 2;
    });

    expect(maxRunning).toBeLessThanOrEqual(3);
    expect(results).toEqual(items.map((item) => item * 2));
  });

  test("continues in-flight work even if one task throws", async () => {
    const completed: number[] = [];

    await expect(
      runWithConcurrency([0, 1, 2, 3], 2, async (item) => {
        if (item === 1) {
          await sleep(5);
          throw new Error("boom");
        }

        await sleep(item === 0 ? 20 : 10);
        completed.push(item);
        return item;
      }),
    ).rejects.toThrow("boom");
    expect([...completed].sort((a, b) => a - b)).toEqual([0, 2, 3]);
  });
});
