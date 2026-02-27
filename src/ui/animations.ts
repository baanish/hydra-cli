import spinners, { type Spinner } from "unicode-animations";

export const UI_REFRESH_INTERVAL_MS = 120;
export const DB_SYNC_INTERVAL_MS = 1000;

export const RUNNING_SPINNER: Spinner = spinners.helix;
export const QUEUED_SPINNER: Spinner = spinners.braillewave;
export const PHASE_SPINNER: Spinner = spinners.orbit;

const DEFAULT_ANIMATION_GLYPH = "•";

export function spinnerFrameAt(spinner: Spinner, elapsedMs: number): string {
  if (spinner.frames.length === 0) {
    return DEFAULT_ANIMATION_GLYPH;
  }

  const safeInterval = Number.isFinite(spinner.interval) && spinner.interval > 0 ? spinner.interval : 80;
  const safeElapsed = Number.isFinite(elapsedMs) ? Math.max(0, elapsedMs) : 0;
  const frameIndex = Math.floor(safeElapsed / safeInterval) % spinner.frames.length;

  return spinner.frames[frameIndex] ?? DEFAULT_ANIMATION_GLYPH;
}
