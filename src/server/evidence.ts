import type { EvidenceItem } from "../shared/types.js";

export class EvidenceUnavailableError extends Error {
  constructor(keyword: string, cause?: unknown) {
    const detail = cause instanceof Error ? cause.message : String(cause ?? "unknown error");
    super(`Academic evidence unavailable for "${keyword}": ${detail}`);
    this.name = "EvidenceUnavailableError";
  }
}

export interface OpenAlexEvidenceOptions {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  /** OpenAlex polite pool — set OPENALEX_MAILTO in production. */
  mailto?: string;
}

const OPENALEX_BASE = "https://api.openalex.org";
const OPENALEX_AUTHORITY = 0.92;

interface OpenAlexWork {
  id: string;
  cited_by_count: number;
  publication_year: number | null;
  keywords?: Array<{ display_name: string; score: number }>;
  concepts?: Array<{ display_name: string; score: number; level: number }>;
}

interface OpenAlexWorksResponse {
  meta: { count: number };
  results: OpenAlexWork[];
}

interface OpenAlexGroupByResponse {
  group_by: Array<{ key: number; key_display_name: string; count: number }>;
}

/** Log-scaled publication volume → 0–1 (≈1M works ≈ 1.0). */
export function normalizePublicationCount(count: number): number {
  if (count <= 0) {
    return 0.05;
  }
  return Math.min(1, Math.log10(count + 1) / 6);
}

/** Map relative growth (recent vs prior window) to 0–1. */
export function normalizeGrowthRate(recent: number, previous: number): number {
  if (previous <= 0) {
    return recent > 0 ? 0.75 : 0.15;
  }
  const rate = (recent - previous) / previous;
  return Math.max(0, Math.min(1, (rate + 0.5) / 2.5));
}

export function sumYearWindow(
  groups: Array<{ key: number; count: number }>,
  fromYear: number,
  toYear: number,
): number {
  return groups
    .filter((group) => group.key >= fromYear && group.key <= toYear)
    .reduce((sum, group) => sum + group.count, 0);
}

export function computeTrendMetrics(
  groups: Array<{ key: number; count: number }>,
  currentYear = new Date().getFullYear(),
): { recent: number; previous: number; growth: number; popularity: number } {
  const recent = sumYearWindow(groups, currentYear - 2, currentYear);
  const previous = sumYearWindow(groups, currentYear - 5, currentYear - 3);
  const growth = normalizeGrowthRate(recent, previous);
  const popularity = Math.min(
    1,
    normalizePublicationCount(recent) * 0.55 + growth * 0.45,
  );
  return { recent, previous, growth, popularity };
}

/** Median cited-by count from top works → authority 0–1. */
export function normalizeCitationAuthority(citedByCounts: number[]): number {
  if (citedByCounts.length === 0) {
    return 0.35;
  }
  const sorted = [...citedByCounts].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)] ?? 0;
  return Math.min(1, Math.log10(median + 1) / 4);
}

export function extractCooccurringTerms(
  works: OpenAlexWork[],
  excludeKeyword: string,
  limit = 3,
): Array<{ term: string; score: number }> {
  const exclude = excludeKeyword.toLowerCase().replace(/\s+/g, " ").trim();
  const weights = new Map<string, number>();

  for (const work of works) {
    for (const keyword of work.keywords ?? []) {
      const term = keyword.display_name.trim();
      if (!term || term.toLowerCase() === exclude) {
        continue;
      }
      weights.set(term, (weights.get(term) ?? 0) + keyword.score);
    }
    for (const concept of work.concepts ?? []) {
      if (concept.level < 2) {
        continue;
      }
      const term = concept.display_name.trim();
      if (!term || term.toLowerCase() === exclude) {
        continue;
      }
      weights.set(term, (weights.get(term) ?? 0) + concept.score * 0.8);
    }
  }

  return [...weights.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([term, score]) => ({ term, score: Math.min(1, score) }));
}

function openAlexSearchUrl(keyword: string): string {
  return `https://openalex.org/works?page=1&filter=default.search:${encodeURIComponent(keyword)}`;
}

export function createOpenAlexEvidenceProvider(
  options: OpenAlexEvidenceOptions = {},
): (keyword: string) => Promise<EvidenceItem[]> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? 8000;
  const mailto = options.mailto ?? process.env.OPENALEX_MAILTO;

  async function fetchJson(path: string): Promise<unknown> {
    const url = new URL(path, OPENALEX_BASE);
    if (mailto) {
      url.searchParams.set("mailto", mailto);
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(url.toString(), {
        headers: { accept: "application/json" },
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new Error(`OpenAlex request failed with ${response.status}`);
      }
      return await response.json();
    } finally {
      clearTimeout(timer);
    }
  }

  return async function searchEvidence(keyword: string): Promise<EvidenceItem[]> {
    const encoded = encodeURIComponent(keyword);
    let worksError: unknown;
    let trendError: unknown;

    let worksPayload: OpenAlexWorksResponse | null = null;
    let trendPayload: OpenAlexGroupByResponse | null = null;

    const [worksResult, trendResult] = await Promise.allSettled([
      fetchJson(`/works?search=${encoded}&sort=cited_by_count:desc&per_page=25`),
      fetchJson(`/works?search=${encoded}&group_by=publication_year`),
    ]);

    if (worksResult.status === "fulfilled") {
      worksPayload = worksResult.value as OpenAlexWorksResponse;
    } else {
      worksError = worksResult.reason;
    }

    if (trendResult.status === "fulfilled") {
      trendPayload = trendResult.value as OpenAlexGroupByResponse;
    } else {
      trendError = trendResult.reason;
    }

    if (!worksPayload && !trendPayload) {
      throw new EvidenceUnavailableError(keyword, worksError ?? trendError);
    }

    const evidence: EvidenceItem[] = [];
    const portalUrl = openAlexSearchUrl(keyword);

    if (worksPayload) {
      const totalWorks = worksPayload.meta?.count ?? 0;
      const citations = (worksPayload.results ?? []).map((work) => work.cited_by_count);
      const corpusPopularity = normalizePublicationCount(totalWorks);
      const citationAuthority = normalizeCitationAuthority(citations);

      evidence.push({
        source: "openalex-corpus",
        title: `文献总量 ${totalWorks.toLocaleString("en-US")} 篇`,
        url: portalUrl,
        popularity: corpusPopularity,
        sourceAuthority: OPENALEX_AUTHORITY,
      });

      if (citations.length > 0) {
        const sorted = [...citations].sort((a, b) => a - b);
        const median = sorted[Math.floor(sorted.length / 2)] ?? 0;
        evidence.push({
          source: "openalex-citations",
          title: `Top 文献被引中位数 ${median.toLocaleString("en-US")}`,
          url: portalUrl,
          popularity: Math.min(1, corpusPopularity * 0.85),
          sourceAuthority: citationAuthority,
        });
      }

      for (const { term, score } of extractCooccurringTerms(worksPayload.results ?? [], keyword)) {
        evidence.push({
          source: "openalex-cooccurrence",
          title: `共现词 · ${term}`,
          url: openAlexSearchUrl(term),
          popularity: Math.min(1, score * 0.9 + corpusPopularity * 0.1),
          sourceAuthority: 0.78,
        });
      }
    }

    if (trendPayload?.group_by?.length) {
      const groups = trendPayload.group_by.map((group) => ({
        key: Number(group.key),
        count: group.count,
      }));
      const trend = computeTrendMetrics(groups);
      const growthPct = Math.round(trend.growth * 100);
      evidence.push({
        source: "openalex-trend",
        title: `近 3 年发文 ${trend.recent.toLocaleString("en-US")} 篇 · 增长指数 ${growthPct}`,
        url: portalUrl,
        popularity: trend.popularity,
        sourceAuthority: 0.88,
      });
    }

    if (evidence.length === 0) {
      throw new EvidenceUnavailableError(keyword, trendError ?? worksError);
    }

    return evidence;
  };
}

/** @deprecated Use createOpenAlexEvidenceProvider */
export const createRealEvidenceProvider = createOpenAlexEvidenceProvider;
