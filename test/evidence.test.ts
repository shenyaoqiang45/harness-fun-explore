import { describe, expect, it, vi } from "vitest";
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
