import { describe, expect, test } from "bun:test";
import spinners from "unicode-animations";

import { spinnerFrameAt } from "./animations";

describe("spinnerFrameAt", () => {
  test("returns the first frame at zero elapsed time", () => {
    const sampleSpinner = {
      frames: ["a", "b", "c"],
      interval: 100,
    } as const;
    expect(spinnerFrameAt(sampleSpinner, 0)).toBe("a");
  });

  test("advances frames and wraps at the frame boundary", () => {
    const sampleSpinner = {
      frames: ["a", "b", "c"],
      interval: 100,
    } as const;
    expect(spinnerFrameAt(sampleSpinner, 99)).toBe("a");
    expect(spinnerFrameAt(sampleSpinner, 100)).toBe("b");
    expect(spinnerFrameAt(sampleSpinner, 299)).toBe("c");
    expect(spinnerFrameAt(sampleSpinner, 300)).toBe("a");
  });

  test("clamps invalid elapsed values to first frame", () => {
    const sampleSpinner = {
      frames: ["a", "b", "c"],
      interval: 100,
    } as const;
    expect(spinnerFrameAt(sampleSpinner, -10)).toBe("a");
    expect(spinnerFrameAt(sampleSpinner, Number.NaN)).toBe("a");
  });

  test("falls back to a default glyph when frames are missing", () => {
    const invalidSpinner = {
      frames: [],
      interval: 100,
    } as unknown as (typeof spinners)["braille"];
    expect(spinnerFrameAt(invalidSpinner, 10)).toBe("•");
  });

  test("works with package-provided spinner definitions", () => {
    expect(spinnerFrameAt(spinners.helix, spinners.helix.interval)).toBe(spinners.helix.frames[1]);
  });
});
