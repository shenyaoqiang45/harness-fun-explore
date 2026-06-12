import type { EvidenceItem } from "../shared/types.js";
import {
  computeTrendMetrics,
  EvidenceUnavailableError,
  normalizeCitationAuthority,
  normalizePublicationCount,
} from "./evidence.js";

const S2_BASE = "https://api.semanticscholar.org/graph/v1";
const S2_AUTHORITY = 0.9;

interface SemanticScholarPaper {
  title?: string;
  citationCount?: number;
  year?: number;
  url?: string;
}

interface SemanticScholarSearchResponse {
  total?: number;
  data?: SemanticScholarPaper[];
}

export interface SemanticScholarEvidenceOptions {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  apiKey?: string;
}

function semanticScholarPortalUrl(keyword: string): string {
  return `https://www.semanticscholar.org/search?q=${encodeURIComponent(keyword)}&sort=relevance`;
}

export function extractTitleTerms(
  papers: SemanticScholarPaper[],
  excludeKeyword: string,
  limit = 3,
): Array<{ term: string; score: number }> {
  const exclude = excludeKeyword.toLowerCase().replace(/\s+/g, " ").trim();
  const weights = new Map<string, number>();

  for (const paper of papers) {
    const title = paper.title ?? "";
    const tokens = title
      .toLowerCase()
      .split(/[\s,;:()[\]"'·、，。]+/)
      .map((token) => token.trim())
      .filter((token) => token.length > 2);

    for (const token of tokens) {
      if (!token || token === exclude || exclude.includes(token)) {
        continue;
      }
      weights.set(token, (weights.get(token) ?? 0) + 1);
    }
  }

  const max = Math.max(...weights.values(), 1);
  return [...weights.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([term, count]) => ({ term, score: Math.min(1, count / max) }));
}

export function createSemanticScholarEvidenceProvider(
  options: SemanticScholarEvidenceOptions = {},
): (keyword: string) => Promise<EvidenceItem[]> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? 8000;
  const apiKey = options.apiKey ?? process.env.SEMANTIC_SCHOLAR_API_KEY;

  return async function searchEvidence(keyword: string): Promise<EvidenceItem[]> {
    const url = new URL(`${S2_BASE}/paper/search`);
    url.searchParams.set("query", keyword);
    url.searchParams.set("limit", "25");
    url.searchParams.set("fields", "title,citationCount,year,url");

    const headers: Record<string, string> = { accept: "application/json" };
    if (apiKey) {
      headers["x-api-key"] = apiKey;
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    let payload: SemanticScholarSearchResponse;
    try {
      const response = await fetchImpl(url.toString(), {
        headers,
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new Error(`Semantic Scholar request failed with ${response.status}`);
      }
      payload = (await response.json()) as SemanticScholarSearchResponse;
    } catch (error) {
      throw new EvidenceUnavailableError(keyword, error);
    } finally {
      clearTimeout(timer);
    }

    const papers = payload.data ?? [];
    const total = payload.total ?? papers.length;
    if (total <= 0 && papers.length === 0) {
      throw new EvidenceUnavailableError(keyword, "no papers found");
    }

    const portalUrl = semanticScholarPortalUrl(keyword);
    const citations = papers.map((paper) => paper.citationCount ?? 0);
    const corpusPopularity = normalizePublicationCount(total);
    const citationAuthority = normalizeCitationAuthority(citations);
    const evidence: EvidenceItem[] = [];

    evidence.push({
      source: "semanticscholar-corpus",
      title: `文献总量 ${total.toLocaleString("en-US")} 篇`,
      url: portalUrl,
      popularity: corpusPopularity,
      sourceAuthority: S2_AUTHORITY,
    });

    if (citations.length > 0) {
      const sorted = [...citations].sort((a, b) => a - b);
      const median = sorted[Math.floor(sorted.length / 2)] ?? 0;
      evidence.push({
        source: "semanticscholar-citations",
        title: `Top 文献被引中位数 ${median.toLocaleString("en-US")}`,
        url: portalUrl,
        popularity: Math.min(1, corpusPopularity * 0.85),
        sourceAuthority: citationAuthority,
      });
    }

    const yearGroups = new Map<number, number>();
    for (const paper of papers) {
      if (paper.year) {
        yearGroups.set(paper.year, (yearGroups.get(paper.year) ?? 0) + 1);
      }
    }

    if (yearGroups.size > 0) {
      const groups = [...yearGroups.entries()].map(([key, count]) => ({ key, count }));
      const trend = computeTrendMetrics(groups);
      const growthPct = Math.round(trend.growth * 100);
      evidence.push({
        source: "semanticscholar-trend",
        title: `近 3 年样本 ${trend.recent.toLocaleString("en-US")} 篇 · 增长指数 ${growthPct}`,
        url: portalUrl,
        popularity: trend.popularity,
        sourceAuthority: 0.86,
      });
    }

    for (const { term, score } of extractTitleTerms(papers, keyword)) {
      evidence.push({
        source: "semanticscholar-cooccurrence",
        title: `共现词 · ${term}`,
        url: semanticScholarPortalUrl(term),
        popularity: Math.min(1, score * 0.9 + corpusPopularity * 0.1),
        sourceAuthority: 0.76,
      });
    }

    return evidence;
  };
}
