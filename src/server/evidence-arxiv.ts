import type { EvidenceItem } from "../shared/types.js";
import {
  computeTrendMetrics,
  EvidenceUnavailableError,
  normalizePublicationCount,
} from "./evidence.js";

const ARXIV_API = "http://export.arxiv.org/api/query";
const ARXIV_AUTHORITY = 0.84;

export interface ArxivEntry {
  title: string;
  published: string;
  link: string;
  categories: string[];
}

export interface ArxivFeed {
  total: number;
  entries: ArxivEntry[];
}

export interface ArxivEvidenceOptions {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

function decodeXmlText(value: string): string {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

export function parseArxivFeed(xml: string): ArxivFeed {
  const totalMatch = xml.match(/<opensearch:totalResults[^>]*>(\d+)<\/opensearch:totalResults>/);
  const total = totalMatch ? Number(totalMatch[1]) : 0;
  const entries: ArxivEntry[] = [];

  const entryBlocks = xml.match(/<entry>[\s\S]*?<\/entry>/g) ?? [];
  for (const block of entryBlocks) {
    const titleMatch = block.match(/<title[^>]*>([\s\S]*?)<\/title>/);
    const publishedMatch = block.match(/<published>([^<]+)<\/published>/);
    const linkMatch = block.match(/<id>([^<]+)<\/id>/);
    const categoryMatches = [...block.matchAll(/<category[^>]*term="([^"]+)"/g)];

    entries.push({
      title: decodeXmlText(titleMatch?.[1] ?? ""),
      published: publishedMatch?.[1] ?? "",
      link: linkMatch?.[1] ?? "",
      categories: categoryMatches.map((match) => match[1]),
    });
  }

  return { total, entries };
}

function arxivPortalUrl(keyword: string): string {
  return `https://arxiv.org/search/?query=${encodeURIComponent(keyword)}&searchtype=all`;
}

function publishedYear(published: string): number | null {
  const match = published.match(/^(\d{4})/);
  return match ? Number(match[1]) : null;
}

export function extractArxivTerms(
  entries: ArxivEntry[],
  excludeKeyword: string,
  limit = 3,
): Array<{ term: string; score: number }> {
  const exclude = excludeKeyword.toLowerCase().replace(/\s+/g, " ").trim();
  const weights = new Map<string, number>();

  for (const entry of entries) {
    for (const category of entry.categories) {
      const term = category.replace(/\./g, " ").trim();
      if (!term || term === exclude) {
        continue;
      }
      weights.set(term, (weights.get(term) ?? 0) + 2);
    }

    const tokens = entry.title
      .toLowerCase()
      .split(/[\s,;:()[\]"'·、，。]+/)
      .map((token) => token.trim())
      .filter((token) => token.length > 3);

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

export function createArxivEvidenceProvider(
  options: ArxivEvidenceOptions = {},
): (keyword: string) => Promise<EvidenceItem[]> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? 10000;

  return async function searchEvidence(keyword: string): Promise<EvidenceItem[]> {
    const url = `${ARXIV_API}?search_query=all:${encodeURIComponent(keyword)}&start=0&max_results=25`;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    let feed: ArxivFeed;
    try {
      const response = await fetchImpl(url, { signal: controller.signal });
      if (!response.ok) {
        throw new Error(`arXiv request failed with ${response.status}`);
      }
      const xml = await response.text();
      feed = parseArxivFeed(xml);
    } catch (error) {
      throw new EvidenceUnavailableError(keyword, error);
    } finally {
      clearTimeout(timer);
    }

    if (feed.total <= 0 && feed.entries.length === 0) {
      throw new EvidenceUnavailableError(keyword, "no preprints found");
    }

    const portalUrl = arxivPortalUrl(keyword);
    const corpusPopularity = normalizePublicationCount(feed.total);
    const evidence: EvidenceItem[] = [];

    evidence.push({
      source: "arxiv-corpus",
      title: `预印本总量 ${feed.total.toLocaleString("en-US")} 篇`,
      url: portalUrl,
      popularity: corpusPopularity,
      sourceAuthority: ARXIV_AUTHORITY,
    });

    const yearGroups = new Map<number, number>();
    for (const entry of feed.entries) {
      const year = publishedYear(entry.published);
      if (year) {
        yearGroups.set(year, (yearGroups.get(year) ?? 0) + 1);
      }
    }

    if (yearGroups.size > 0) {
      const groups = [...yearGroups.entries()].map(([key, count]) => ({ key, count }));
      const trend = computeTrendMetrics(groups);
      const growthPct = Math.round(trend.growth * 100);
      evidence.push({
        source: "arxiv-trend",
        title: `近 3 年样本 ${trend.recent.toLocaleString("en-US")} 篇 · 增长指数 ${growthPct}`,
        url: portalUrl,
        popularity: trend.popularity,
        sourceAuthority: 0.82,
      });
    }

    const recentCount = feed.entries.filter((entry) => {
      const year = publishedYear(entry.published);
      return year !== null && year >= new Date().getFullYear() - 2;
    }).length;

    if (feed.entries.length > 0) {
      const recencyRatio = recentCount / feed.entries.length;
      evidence.push({
        source: "arxiv-recency",
        title: `样本新近度 ${Math.round(recencyRatio * 100)}% · 近 3 年占比`,
        url: portalUrl,
        popularity: Math.min(1, recencyRatio * 0.7 + corpusPopularity * 0.3),
        sourceAuthority: 0.78,
      });
    }

    for (const { term, score } of extractArxivTerms(feed.entries, keyword)) {
      evidence.push({
        source: "arxiv-cooccurrence",
        title: `共现词 · ${term}`,
        url: arxivPortalUrl(term),
        popularity: Math.min(1, score * 0.9 + corpusPopularity * 0.1),
        sourceAuthority: 0.74,
      });
    }

    return evidence;
  };
}
