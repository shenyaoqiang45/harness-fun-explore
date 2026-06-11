import { afterAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/server/app.js";

describe("HTTP API", () => {
  const app = buildApp();

  afterAll(async () => {
    await app.close();
  });

  it("starts a session with one ranked round", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/start",
      payload: { keyword: "harness" },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json() as {
      sessionId: string;
      rounds: Array<{ candidateKeywords: string[]; topNodeIds: string[] }>;
      status: string;
    };

    expect(body.sessionId).toBeTruthy();
    expect(body.rounds).toHaveLength(1);
    expect(body.rounds[0].candidateKeywords).toHaveLength(10);
    expect(body.rounds[0].topNodeIds).toHaveLength(5);
    expect(body.status).toBe("await-user-click");
  });

  it("expands from a leaf and confirms the chosen path", async () => {
    const start = await app.inject({
      method: "POST",
      url: "/api/start",
      payload: { keyword: "harness" },
    });
    const session = start.json() as {
      sessionId: string;
      rounds: Array<{ topNodeIds: string[] }>;
    };

    const leafId = session.rounds[0].topNodeIds[0];
    const expand = await app.inject({
      method: "POST",
      url: "/api/expand",
      payload: { sessionId: session.sessionId, rootNodeId: leafId },
    });

    expect(expand.statusCode).toBe(200);
    const expanded = expand.json() as { rounds: unknown[]; status: string };
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
    const session = start.json() as { sessionId: string };

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
    const session = start.json() as { sessionId: string };

    const response = await app.inject({
      method: "GET",
      url: `/api/trace/${session.sessionId}/event/does-not-exist`,
    });

    expect(response.statusCode).toBe(404);
  });
});
