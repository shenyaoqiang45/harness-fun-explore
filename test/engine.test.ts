import { describe, expect, it } from "vitest";
import { ExplorationEngine } from "../src/server/engine.js";
import { TraceStore } from "../src/server/trace-store.js";

describe("ExplorationEngine", () => {
  it("creates a round with 10 candidates and 5 selected nodes", async () => {
    const traces = new TraceStore();
    const engine = new ExplorationEngine(makeDeps(), traces);

    const session = await engine.start("harness");
    expect(session.rounds).toHaveLength(1);
    expect(session.rounds[0].candidateKeywords).toHaveLength(10);
    expect(session.rounds[0].topNodeIds).toHaveLength(5);
    expect(session.status).toBe("await-user-click");

    const timeline = traces.getTimeline(session.sessionId);
    const hasLlm = timeline.some((event) => event.type === "llm-output");
    const hasTool = timeline.some(
      (event) => event.type === "tool-call-start" && event.toolName === "expandKeywords",
    );

    expect(hasLlm).toBe(true);
    expect(hasTool).toBe(true);
  });

  it("confirms a path from root to the chosen node and blocks further expansion", async () => {
    const engine = new ExplorationEngine(makeDeps(), new TraceStore());
    const session = await engine.start("harness");
    const leafId = session.rounds[0].topNodeIds[0];

    const confirmed = engine.confirm(session.sessionId, leafId);

    expect(confirmed.status).toBe("confirmed");
    expect(confirmed.confirmedPath[0]).toBe(session.rootNodeId);
    expect(confirmed.confirmedPath.at(-1)).toBe(leafId);

    await expect(engine.expand(session.sessionId, leafId)).rejects.toThrow(
      "Session is already confirmed.",
    );
  });

  it("creates a second round when expanding from a leaf node", async () => {
    const engine = new ExplorationEngine(makeDeps(), new TraceStore());
    const session = await engine.start("harness");
    const leafId = session.rounds[0].topNodeIds[0];

    const expanded = await engine.expand(session.sessionId, leafId);

    expect(expanded.rounds).toHaveLength(2);
    expect(expanded.rounds[1].rootNodeId).toBe(leafId);
    expect(expanded.rounds[1].topNodeIds).toHaveLength(5);
    expect(expanded.status).toBe("await-user-click");
  });

  it("passes current round context to persona inference on the first round", async () => {
    let roundsSeen = -1;
    const engine = new ExplorationEngine(
      {
        ...makeDeps(),
        async inferPersona(rounds) {
          roundsSeen = rounds.length;
          return { label: "Explorer", confidence: 0.6, reason: "Testing" };
        },
      },
      new TraceStore(),
    );

    await engine.start("harness");
    expect(roundsSeen).toBe(1);
  });
});

function makeDeps() {
  return {
    async expandKeywords(seed: string) {
      return Array.from({ length: 10 }, (_, index) => `${seed}-${index + 1}`);
    },
    async searchEvidence(keyword: string) {
      return [
        {
          source: "test-web",
          title: keyword,
          url: `https://example.com/${keyword}`,
          popularity: 0.4 + ((keyword.length % 5) * 0.1),
          sourceAuthority: 0.5,
        },
      ];
    },
    async summarizeDirection(rootKeyword: string, topKeywords: string[]) {
      return {
        label: `Focus ${rootKeyword}`,
        reason: topKeywords.join(", "),
      };
    },
    async inferPersona(rounds: { roundId: number }[]) {
      return {
        label: rounds.length > 0 ? "Focused" : "Exploring",
        confidence: 0.7,
        reason: "Testing",
      };
    },
  };
}
