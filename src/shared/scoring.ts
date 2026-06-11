import type { ScoreBreakdown } from "./types.js";

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

export function scoreKeyword(input: {
  semanticRelevance: number;
  popularity: number;
  sourceAuthority: number;
  weights?: { relevance: number; popularity: number; authority: number };
}): ScoreBreakdown {
  const weights = input.weights ?? { relevance: 0.5, popularity: 0.3, authority: 0.2 };

  const semanticRelevance = clamp01(input.semanticRelevance);
  const popularity = clamp01(input.popularity);
  const sourceAuthority = clamp01(input.sourceAuthority);

  const compositeScore = clamp01(
    semanticRelevance * weights.relevance +
      popularity * weights.popularity +
      sourceAuthority * weights.authority,
  );

  return {
    semanticRelevance,
    popularity,
    sourceAuthority,
    compositeScore,
  };
}
