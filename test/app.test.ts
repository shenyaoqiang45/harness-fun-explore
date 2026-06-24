import { afterAll, describe, expect, it } from "vitest";
import type { EngineDeps } from "../src/server/engine.js";
import { buildApp } from "../src/server/app.js";

async function waitForSessionReady(
  app: ReturnType<typeof buildApp>,
  sessionId: string,
): Promise<{
  sessionId: string;
  llmProvider: string;
  evidenceProvider: string;
  status: string;
  rounds: Array<{ candidateKeywords: string[]; topNodeIds: string[] }>;
  rootNodeId: string;
}> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const response = await app.inject({
      method: "GET",
      url: `/api/session/${sessionId}`,
    });
    const body = response.json() as {
      sessionId: string;
      llmProvider: string;
      evidenceProvider: string;
      status: string;
      rounds: Array<{ candidateKeywords: string[]; topNodeIds: string[] }>;
      rootNodeId: string;
    };

    if (body.status === "await-user-click" || body.status === "confirmed") {
      return body;
    }
    if (body.status === "error") {
      throw new Error("Session entered error state");
    }

    await new Promise((resolve) => setTimeout(resolve, 20));
  }

  throw new Error("Timed out waiting for session round to complete");
}

function makeTestDeps(): EngineDeps {
  return {
    async expandKeywords(seed: string) {
      return Array.from({ length: 5 }, (_, index) => `${seed}-${index + 1}`);
    },
    async searchEvidence(keyword: string) {
      return [
        {
          source: "test-web",
          title: keyword,
          url: `https://example.com/${encodeURIComponent(keyword)}`,
          popularity: 0.4 + ((keyword.length % 5) * 0.1),
          sourceAuthority: 0.5,
        },
      ];
    },
    async summarizeRound(rootKeyword: string, topKeywords: string[], priorRounds: { roundId: number }[]) {
      return {
        directionSummary: {
          label: `Focus ${rootKeyword}`,
          reason: topKeywords.join(", "),
        },
        personaHypothesis: {
          label: priorRounds.length > 0 ? "Focused" : "Exploring",
          confidence: 0.7,
          reason: "Testing",
        },
      };
    },
  };
}

describe("HTTP API", () => {
  const app = buildApp({ deps: makeTestDeps() });

  afterAll(async () => {
    await app.close();
  });

  it("lists configured LLM providers", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/api/llm-providers",
    });

    expect(response.statusCode).toBe(200);
    const body = response.json() as {
      providers: Array<{ id: string; label: string; model: string }>;
      defaultProvider: string;
    };
    expect(body.providers.length).toBeGreaterThan(0);
    expect(body.defaultProvider).toBeTruthy();
  });

  it("lists evidence database providers", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/api/evidence-providers",
    });

    expect(response.statusCode).toBe(200);
    const body = response.json() as {
      providers: Array<{ id: string; label: string }>;
      defaultProvider: string;
    };
    expect(body.providers.map((item) => item.id)).toEqual([
      "openalex",
      "semantic-scholar",
      "arxiv",
    ]);
    expect(body.defaultProvider).toBe("openalex");
  });

  it("starts a session with one ranked round", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/start",
      payload: { keyword: "harness", evidenceProvider: "arxiv" },
    });

    expect(response.statusCode).toBe(200);
    const kickoff = response.json() as {
      sessionId: string;
      llmProvider: string;
      evidenceProvider: string;
      status: string;
    };
    expect(["draft", "expanding"]).toContain(kickoff.status);
    expect(kickoff.evidenceProvider).toBe("arxiv");
    const body = await waitForSessionReady(app, kickoff.sessionId);

    expect(body.sessionId).toBeTruthy();
    expect(body.llmProvider).toBeTruthy();
    expect(body.rounds).toHaveLength(1);
    expect(body.rounds[0].candidateKeywords).toHaveLength(5);
    expect(body.rounds[0].topNodeIds).toHaveLength(5);
    expect(body.status).toBe("await-user-click");
  });

  it("expands from a leaf and confirms the chosen path", async () => {
    const start = await app.inject({
      method: "POST",
      url: "/api/start",
      payload: { keyword: "harness" },
    });
    const kickoff = start.json() as { sessionId: string };
    const session = await waitForSessionReady(app, kickoff.sessionId);

    const leafId = session.rounds[0].topNodeIds[0];
    const expand = await app.inject({
      method: "POST",
      url: "/api/expand",
      payload: { sessionId: session.sessionId, rootNodeId: leafId },
    });

    expect(expand.statusCode).toBe(200);
    const expanded = await waitForSessionReady(app, session.sessionId);
    expect(expanded.rounds).toHaveLength(2);
    expect(expanded.status).toBe("await-user-click");

    const confirm = await app.inject({
      method: "POST",
      url: "/api/confirm",
      payload: { sessionId: session.sessionId, nodeId: leafId },
    });

    expect(confirm.statusCode).toBe(200);
    const confirmed = confirm.json() as {
      status: string;
      confirmedPath: string[];
    };
    expect(confirmed.status).toBe("confirmed");
    expect(confirmed.confirmedPath.at(-1)).toBe(leafId);
  });

  it("returns session and trace timelines", async () => {
    const start = await app.inject({
      method: "POST",
      url: "/api/start",
      payload: { keyword: "trace" },
    });
    const kickoff = start.json() as { sessionId: string };
    const session = await waitForSessionReady(app, kickoff.sessionId);

    const sessionResp = await app.inject({
      method: "GET",
      url: `/api/session/${session.sessionId}`,
    });
    expect(sessionResp.statusCode).toBe(200);

    const traceResp = await app.inject({
      method: "GET",
      url: `/api/trace/${session.sessionId}`,
    });
    expect(traceResp.statusCode).toBe(200);
    const trace = traceResp.json() as unknown[];
    expect(trace.length).toBeGreaterThan(0);
  });

  it("returns 404 for an unknown trace event", async () => {
    const start = await app.inject({
      method: "POST",
      url: "/api/start",
      payload: { keyword: "missing" },
    });
    const kickoff = start.json() as { sessionId: string };
    const session = await waitForSessionReady(app, kickoff.sessionId);

    const response = await app.inject({
      method: "GET",
      url: `/api/trace/${session.sessionId}/event/does-not-exist`,
    });

    expect(response.statusCode).toBe(404);
  });

  it("serves client and shared browser modules", async () => {
    const client = await app.inject({ method: "GET", url: "/client.js" });
    expect(client.statusCode).toBe(200);
    expect(client.headers["content-type"]).toContain("javascript");
    expect(client.body).toContain("buildTreeLayout");

    const displayTree = await app.inject({ method: "GET", url: "/shared/display-tree.js" });
    expect(displayTree.statusCode).toBe(200);
    expect(displayTree.body).toContain("buildSessionDisplayTree");

    const treeLayout = await app.inject({ method: "GET", url: "/shared/tree-layout.js" });
    expect(treeLayout.statusCode).toBe(200);
    expect(treeLayout.body).toContain("buildTreeLayout");

    const starLayout = await app.inject({ method: "GET", url: "/shared/star-layout.js" });
    expect(starLayout.statusCode).toBe(200);
    expect(starLayout.body).toContain("buildStarLayout");
  });

  it("backtraces through the HTTP API", async () => {
    const start = await app.inject({
      method: "POST",
      url: "/api/start",
      payload: { keyword: "backtrace" },
    });
    const kickoff = start.json() as { sessionId: string };
    const session = await waitForSessionReady(app, kickoff.sessionId);
    const leafId = session.rounds[0].topNodeIds[0];

    await app.inject({
      method: "POST",
      url: "/api/expand",
      payload: { sessionId: session.sessionId, rootNodeId: leafId },
    });
    await waitForSessionReady(app, session.sessionId);

    const response = await app.inject({
      method: "POST",
      url: "/api/backtrace",
      payload: { sessionId: session.sessionId, nodeId: session.rootNodeId },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json() as { rounds: unknown[] };
    expect(body.rounds).toHaveLength(1);
  });
});
