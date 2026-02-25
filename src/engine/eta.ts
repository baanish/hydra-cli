/** estimate remaining wall clock with recent completion samples and concurrency. */
export class ETAEstimator {
  private completionTimesMs: number[] = [];
  private readonly maxSamples: number;

  /** initialize the estimator with optional max sample size for smoothing. */
  constructor(maxSamples = 20) {
    this.maxSamples = Math.max(1, maxSamples);
  }

  /** record a completed item duration in milliseconds for future estimates. */
  recordCompletion(durationMs: number): void {
    if (!Number.isFinite(durationMs) || durationMs <= 0) {
      return;
    }

    this.completionTimesMs.push(durationMs);
    if (this.completionTimesMs.length > this.maxSamples) {
      this.completionTimesMs.shift();
    }
  }

  /** estimate remaining time from current samples and configured concurrency. */
  estimate(remainingItems: number, currentConcurrency: number): string {
    if (!Number.isFinite(remainingItems) || remainingItems <= 0) {
      return "0s";
    }
    if (this.completionTimesMs.length === 0) {
      return "--";
    }

    const safeConcurrency = Number.isFinite(currentConcurrency) && currentConcurrency > 0
      ? Math.floor(currentConcurrency)
      : 1;
    const average =
      this.completionTimesMs.reduce((sum, value) => sum + value, 0) /
      this.completionTimesMs.length;
    const batches = Math.ceil(remainingItems / safeConcurrency);
    const estimateMs = Math.max(0, Math.round(average * batches));
    return formatDuration(estimateMs);
  }

  /** clear any stored completion samples. */
  reset(): void {
    this.completionTimesMs = [];
  }
}

/** format milliseconds into a human friendly `Xm Ss` or `Ns` string. */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) {
    return "0s";
  }

  const totalSeconds = Math.max(1, Math.round(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;

  if (minutes > 0) {
    return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
  }
  return `${seconds}s`;
}
