import { describe, expect, it } from "vitest";
import { scoreKeyword } from "../src/shared/scoring.js";

describe("scoreKeyword", () => {
  it("calculates composite score with default weights", () => {
    const score = scoreKeyword({
      semanticRelevance: 0.8,
      popularity: 0.4,
      sourceAuthority: 0.5,
    });

    expect(score.semanticRelevance).toBe(0.8);
    expect(score.popularity).toBe(0.4);
    expect(score.sourceAuthority).toBe(0.5);
    expect(score.compositeScore).toBeCloseTo(0.62, 5);
  });

  it("clamps all dimensions to 0-1", () => {
    const score = scoreKeyword({
      semanticRelevance: -5,
      popularity: 99,
      sourceAuthority: 0.5,
    });

    expect(score.semanticRelevance).toBe(0);
    expect(score.popularity).toBe(1);
    expect(score.sourceAuthority).toBe(0.5);
  });
});
