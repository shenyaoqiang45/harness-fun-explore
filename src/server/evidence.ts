import type { EvidenceItem } from "../shared/types.js";
import { createConcurrencyLimiter, fetchWith429Retry } from "./evidence-rate-limit.js";

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
  /** OpenAlex API key — get one free at https://openalex.org/settings/api */
  apiKey?: string;
  /** @deprecated OpenAlex now uses API keys; mailto is ignored by the API. */
  mailto?: string;
  /** Max in-flight OpenAlex requests. 0 disables limiting (tests). */
  maxConcurrent?: number;
  maxRetries?: number;
}

const OPENALEX_BASE = "https://api.openalex.org";
const OPENALEX_AUTHORITY = 0.92;
const OPENALEX_MAX_CONCURRENT_WITH_KEY = 8;
const OPENALEX_MAX_CONCURRENT_ANONYMOUS = 1;
const OPENALEX_RETRY_DELAY_WITH_KEY_MS = 600;
const OPENALEX_RETRY_DELAY_ANONYMOUS_MS = 2500;
const OPENALEX_WORKS_PER_PAGE = 15;

let sharedLimiter: ReturnType<typeof createConcurrencyLimiter> | null = null;
let sharedLimiterConcurrency = -1;

function getSharedLimiter(maxConcurrent: number) {
  if (!sharedLimiter || sharedLimiterConcurrency !== maxConcurrent) {
    sharedLimiter = createConcurrencyLimiter(maxConcurrent);
    sharedLimiterConcurrency = maxConcurrent;
  }
  return sharedLimiter;
}

function resolveMaxConcurrent(hasApiKey: boolean, override?: number): number {
  if (override !== undefined) {
    return override;
  }
  return hasApiKey ? OPENALEX_MAX_CONCURRENT_WITH_KEY : OPENALEX_MAX_CONCURRENT_ANONYMOUS;
}

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

/** Approximate year buckets from top-cited works (one API call, no group_by). */
export function deriveTrendGroupsFromWorks(
  works: OpenAlexWork[],
): Array<{ key: number; count: number }> {
  const groups = new Map<number, number>();
  for (const work of works) {
    if (work.publication_year != null) {
      groups.set(work.publication_year, (groups.get(work.publication_year) ?? 0) + 1);
    }
  }
  return [...groups.entries()]
    .map(([key, count]) => ({ key, count }))
    .sort((a, b) => a.key - b.key);
}

export function createOpenAlexEvidenceProvider(
  options: OpenAlexEvidenceOptions = {},
): (keyword: string) => Promise<EvidenceItem[]> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? 12_000;
  const apiKey = options.apiKey ?? process.env.OPENALEX_API_KEY;
  const mailto = options.mailto ?? process.env.OPENALEX_MAILTO;
  const maxRetries = options.maxRetries ?? 5;
  const maxConcurrent = resolveMaxConcurrent(Boolean(apiKey), options.maxConcurrent);
  const minRetryDelayMs = apiKey
    ? OPENALEX_RETRY_DELAY_WITH_KEY_MS
    : OPENALEX_RETRY_DELAY_ANONYMOUS_MS;
  const runLimited =
    maxConcurrent === 0
      ? <T>(task: () => Promise<T>) => task()
      : getSharedLimiter(maxConcurrent);

  async function fetchJson(path: string): Promise<unknown> {
    return runLimited(async () => {
      const url = new URL(path, OPENALEX_BASE);
      if (apiKey) {
        url.searchParams.set("api_key", apiKey);
      } else if (mailto) {
        url.searchParams.set("mailto", mailto);
      }

      const response = await fetchWith429Retry({
        fetchImpl,
        url: url.toString(),
        init: { headers: { accept: "application/json" } },
        timeoutMs,
        maxRetries,
        minRetryDelayMs,
      });
      if (!response.ok) {
        throw new Error(`OpenAlex request failed with ${response.status}`);
      }
      return await response.json();
    });
  }

  return async function searchEvidence(keyword: string): Promise<EvidenceItem[]> {
    const encoded = encodeURIComponent(keyword);
    let worksError: unknown;
    let worksPayload: OpenAlexWorksResponse | null = null;

    try {
      worksPayload = (await fetchJson(
        `/works?search=${encoded}&sort=cited_by_count:desc&per_page=${OPENALEX_WORKS_PER_PAGE}`,
      )) as OpenAlexWorksResponse;
    } catch (error) {
      worksError = error;
    }

    if (!worksPayload) {
      throw new EvidenceUnavailableError(keyword, worksError);
    }

    const evidence: EvidenceItem[] = [];
    const portalUrl = openAlexSearchUrl(keyword);
    const totalWorks = worksPayload.meta?.count ?? 0;
    const results = worksPayload.results ?? [];
    const citations = results.map((work) => work.cited_by_count);
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

    for (const { term, score } of extractCooccurringTerms(results, keyword)) {
      evidence.push({
        source: "openalex-cooccurrence",
        title: `共现词 · ${term}`,
        url: openAlexSearchUrl(term),
        popularity: Math.min(1, score * 0.9 + corpusPopularity * 0.1),
        sourceAuthority: 0.78,
      });
    }

    const trendGroups = deriveTrendGroupsFromWorks(results);
    if (trendGroups.length > 0) {
      const trend = computeTrendMetrics(trendGroups);
      const growthPct = Math.round(trend.growth * 100);
      evidence.push({
        source: "openalex-trend",
        title: `高被引样本近 3 年 ${trend.recent} 篇 · 增长指数 ${growthPct}`,
        url: portalUrl,
        popularity: trend.popularity,
        sourceAuthority: 0.88,
      });
    }

    if (evidence.length === 0) {
      throw new EvidenceUnavailableError(keyword, worksError);
    }

    return evidence;
  };
}

/** @deprecated Use createOpenAlexEvidenceProvider */
export const createRealEvidenceProvider = createOpenAlexEvidenceProvider;
