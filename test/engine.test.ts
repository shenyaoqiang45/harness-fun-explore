import { describe, expect, it } from "vitest";
import { ExplorationEngine } from "../src/server/engine.js";
import { TraceStore } from "../src/server/trace-store.js";

describe("ExplorationEngine", () => {
  it("creates a round with 5 candidates and 5 selected nodes", async () => {
    const traces = new TraceStore();
    const engine = new ExplorationEngine(makeDeps(), traces);

    const session = await engine.start("harness");
    expect(session.rounds).toHaveLength(1);
    expect(session.rounds[0].candidateKeywords).toHaveLength(5);
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

  it("backtraces to an earlier layer and removes deeper rounds", async () => {
    const engine = new ExplorationEngine(makeDeps(), new TraceStore());
    const session = await engine.start("harness");
    const firstLeaf = session.rounds[0].topNodeIds[0];
    const expanded = await engine.expand(session.sessionId, firstLeaf);
    expect(expanded.rounds).toHaveLength(2);

    const rewound = engine.backtrace(session.sessionId, session.rootNodeId);
    expect(rewound.rounds).toHaveLength(1);
    expect(Object.keys(rewound.nodes)).toHaveLength(6);
    expect(rewound.currentRootNodeId).toBe(session.rootNodeId);
  });

  it("switches branch when expanding from a sibling leaf", async () => {
    const engine = new ExplorationEngine(makeDeps(), new TraceStore());
    const session = await engine.start("harness");
    const firstLeaf = session.rounds[0].topNodeIds[0];
    const siblingLeaf = session.rounds[0].topNodeIds[1];
    await engine.expand(session.sessionId, firstLeaf);
    const switched = await engine.expand(session.sessionId, siblingLeaf);

    expect(switched.rounds).toHaveLength(2);
    expect(switched.rounds[1].rootNodeId).toBe(siblingLeaf);
  });

  it("searches evidence for all candidates in parallel", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const baseDeps = makeDeps();

    const engine = new ExplorationEngine(
      {
        ...baseDeps,
        async searchEvidence(keyword: string) {
          inFlight += 1;
          maxInFlight = Math.max(maxInFlight, inFlight);
          await new Promise((resolve) => setTimeout(resolve, 20));
          inFlight -= 1;
          return baseDeps.searchEvidence(keyword);
        },
      },
      new TraceStore(),
    );

    await engine.start("harness");
    expect(maxInFlight).toBeGreaterThan(1);
  });

  it("passes prior rounds to summarizeRound on the first round", async () => {
    let priorRoundsSeen = -1;
    const engine = new ExplorationEngine(
      {
        ...makeDeps(),
        async summarizeRound(_rootKeyword, _topKeywords, priorRounds) {
          priorRoundsSeen = priorRounds.length;
          return {
            directionSummary: { label: "Focus", reason: "Testing" },
            personaHypothesis: { label: "Explorer", confidence: 0.6, reason: "Testing" },
          };
        },
      },
      new TraceStore(),
    );

    await engine.start("harness");
    expect(priorRoundsSeen).toBe(0);
  });
});

function makeDeps() {
  return {
    async expandKeywords(seed: string) {
      return Array.from({ length: 5 }, (_, index) => `${seed}-${index + 1}`);
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
