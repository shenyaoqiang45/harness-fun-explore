import { describe, expect, it, vi } from "vitest";
import { parseArxivFeed, createArxivEvidenceProvider } from "../src/server/evidence-arxiv.js";
import {
  createSemanticScholarEvidenceProvider,
  extractTitleTerms,
} from "../src/server/evidence-semantic-scholar.js";
import { resolveDefaultEvidenceProvider } from "../src/server/evidence-providers.js";
import {
  computeTrendMetrics,
  createOpenAlexEvidenceProvider,
  EvidenceUnavailableError,
  extractCooccurringTerms,
  normalizeCitationAuthority,
  normalizeGrowthRate,
  normalizePublicationCount,
  sumYearWindow,
} from "../src/server/evidence.js";

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

const worksPayload = {
  meta: { count: 125_000 },
  results: [
    {
      id: "https://openalex.org/W1",
      cited_by_count: 8000,
      publication_year: 2024,
      keywords: [
        { display_name: "transformer", score: 0.92 },
        { display_name: "attention mechanism", score: 0.71 },
      ],
      concepts: [{ display_name: "Computer science", score: 0.95, level: 0 }],
    },
    {
      id: "https://openalex.org/W2",
      cited_by_count: 2000,
      publication_year: 2023,
      keywords: [{ display_name: "large language model", score: 0.88 }],
    },
  ],
};

const trendPayload = {
  group_by: [
    { key: 2026, key_display_name: "2026", count: 400 },
    { key: 2025, key_display_name: "2025", count: 900 },
    { key: 2024, key_display_name: "2024", count: 800 },
    { key: 2023, key_display_name: "2023", count: 700 },
    { key: 2022, key_display_name: "2022", count: 600 },
    { key: 2021, key_display_name: "2021", count: 500 },
    { key: 2020, key_display_name: "2020", count: 450 },
    { key: 2019, key_display_name: "2019", count: 400 },
  ],
};

function fakeFetch(handler: (url: string) => Response | Promise<Response>): typeof fetch {
  return vi.fn(async (input: RequestInfo | URL) => handler(String(input))) as unknown as typeof fetch;
}

describe("academic metric helpers", () => {
  it("normalizes publication counts on a log scale", () => {
    expect(normalizePublicationCount(0)).toBe(0.05);
    expect(normalizePublicationCount(1_000_000)).toBeCloseTo(1, 5);
  });

  it("normalizes growth rates", () => {
    expect(normalizeGrowthRate(300, 100)).toBeGreaterThan(0.5);
    expect(normalizeGrowthRate(0, 100)).toBeLessThan(0.5);
  });

  it("computes recent vs prior publication windows", () => {
    const groups = trendPayload.group_by.map((group) => ({ key: group.key, count: group.count }));
    expect(sumYearWindow(groups, 2024, 2026)).toBe(2100);
    expect(sumYearWindow(groups, 2021, 2023)).toBe(1800);
  });

  it("derives trend popularity from recent volume and growth", () => {
    const groups = trendPayload.group_by.map((group) => ({ key: group.key, count: group.count }));
    const trend = computeTrendMetrics(groups, 2026);
    expect(trend.recent).toBe(2100);
    expect(trend.previous).toBe(1800);
    expect(trend.popularity).toBeGreaterThan(0.4);
  });

  it("derives citation authority from median cited-by counts", () => {
    expect(normalizeCitationAuthority([8000, 2000])).toBeGreaterThan(0.5);
    expect(normalizeCitationAuthority([])).toBe(0.35);
  });

  it("extracts co-occurring terms and excludes the seed keyword", () => {
    const terms = extractCooccurringTerms(worksPayload.results, "large language model");
    expect(terms.map((item) => item.term)).toContain("transformer");
    expect(terms.map((item) => item.term)).not.toContain("large language model");
  });
});

describe("createOpenAlexEvidenceProvider", () => {
  it("returns corpus, citation, trend, and co-occurrence evidence", async () => {
    const search = createOpenAlexEvidenceProvider({
      fetchImpl: fakeFetch((url) => {
        if (url.includes("group_by=publication_year")) {
          return jsonResponse(trendPayload);
        }
        return jsonResponse(worksPayload);
      }),
    });

    const evidence = await search("large language model");

    expect(evidence.some((item) => item.source === "openalex-corpus")).toBe(true);
    expect(evidence.some((item) => item.source === "openalex-citations")).toBe(true);
    expect(evidence.some((item) => item.source === "openalex-trend")).toBe(true);
    expect(evidence.some((item) => item.source === "openalex-cooccurrence")).toBe(true);
    expect(evidence[0].url).toContain("openalex.org/works");
  });

  it("throws when every OpenAlex request fails", async () => {
    const search = createOpenAlexEvidenceProvider({
      fetchImpl: fakeFetch(() => {
        throw new Error("network down");
      }),
    });

    await expect(search("offline keyword")).rejects.toThrow(EvidenceUnavailableError);
  });

  it("uses only works payload when trend grouping fails", async () => {
    const search = createOpenAlexEvidenceProvider({
      fetchImpl: fakeFetch((url) => {
        if (url.includes("group_by=publication_year")) {
          throw new Error("group_by unavailable");
        }
        return jsonResponse(worksPayload);
      }),
    });

    const evidence = await search("transformer");
    expect(evidence.some((item) => item.source === "openalex-corpus")).toBe(true);
    expect(evidence.some((item) => item.source === "openalex-trend")).toBe(false);
  });
});

describe("createSemanticScholarEvidenceProvider", () => {
  const s2Payload = {
    total: 42_000,
    data: [
      { title: "Transformer Attention for Vision", citationCount: 1200, year: 2025, url: "https://example.com/1" },
      { title: "Large Language Model Calibration", citationCount: 300, year: 2024, url: "https://example.com/2" },
    ],
  };

  it("returns corpus, citation, trend, and co-occurrence evidence", async () => {
    const search = createSemanticScholarEvidenceProvider({
      fetchImpl: fakeFetch(() => jsonResponse(s2Payload)),
    });

    const evidence = await search("transformer");

    expect(evidence.some((item) => item.source === "semanticscholar-corpus")).toBe(true);
    expect(evidence.some((item) => item.source === "semanticscholar-citations")).toBe(true);
    expect(evidence.some((item) => item.source === "semanticscholar-trend")).toBe(true);
    expect(evidence.some((item) => item.source === "semanticscholar-cooccurrence")).toBe(true);
    expect(evidence[0].url).toContain("semanticscholar.org/search");
  });

  it("throws when Semantic Scholar request fails", async () => {
    const search = createSemanticScholarEvidenceProvider({
      fetchImpl: fakeFetch(() => {
        throw new Error("rate limited");
      }),
    });

    await expect(search("offline keyword")).rejects.toThrow(EvidenceUnavailableError);
  });
});

describe("createArxivEvidenceProvider", () => {
  const arxivXml = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom" xmlns:opensearch="http://a9.com/-/spec/opensearch/1.1/">
  <opensearch:totalResults>18000</opensearch:totalResults>
  <entry>
    <id>https://arxiv.org/abs/2401.00001</id>
    <title>Transformer Models for 3D Vision</title>
    <published>2025-01-15T00:00:00Z</published>
    <category term="cs.CV" />
    <category term="cs.LG" />
  </entry>
  <entry>
    <id>https://arxiv.org/abs/2301.00002</id>
    <title>Calibration Methods in Robotics</title>
    <published>2023-06-01T00:00:00Z</published>
    <category term="cs.RO" />
  </entry>
</feed>`;

  it("parses arXiv atom feeds", () => {
    const feed = parseArxivFeed(arxivXml);
    expect(feed.total).toBe(18000);
    expect(feed.entries).toHaveLength(2);
    expect(feed.entries[0].categories).toContain("cs.CV");
  });

  it("returns corpus, trend, recency, and co-occurrence evidence", async () => {
    const search = createArxivEvidenceProvider({
      fetchImpl: fakeFetch(async () => new Response(arxivXml, { status: 200 })),
    });

    const evidence = await search("3d vision");

    expect(evidence.some((item) => item.source === "arxiv-corpus")).toBe(true);
    expect(evidence.some((item) => item.source === "arxiv-trend")).toBe(true);
    expect(evidence.some((item) => item.source === "arxiv-recency")).toBe(true);
    expect(evidence.some((item) => item.source === "arxiv-cooccurrence")).toBe(true);
    expect(evidence[0].url).toContain("arxiv.org/search");
  });
});

describe("evidence provider registry", () => {
  it("defaults to OpenAlex", () => {
    expect(resolveDefaultEvidenceProvider(undefined)).toBe("openalex");
    expect(resolveDefaultEvidenceProvider("arxiv")).toBe("arxiv");
    expect(resolveDefaultEvidenceProvider("unknown")).toBe("openalex");
  });

  it("extracts title terms for Semantic Scholar co-occurrence", () => {
    const terms = extractTitleTerms(
      [{ title: "Transformer Attention for Vision" }, { title: "Vision Transformer Calibration" }],
      "vision",
    );
    expect(terms.length).toBeGreaterThan(0);
    expect(terms[0].term).toBeTruthy();
  });
});
