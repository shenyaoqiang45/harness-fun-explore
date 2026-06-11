import { describe, expect, it } from "vitest";
import { resolveTraceNodeId } from "../src/shared/trace-linkage.js";

describe("resolveTraceNodeId", () => {
  const session = {
    nodes: {
      root: { id: "root", keyword: "ai", roundId: 0 },
      leaf: { id: "leaf", keyword: "ai trend", roundId: 1 },
    },
    rounds: [{ roundId: 1, rootNodeId: "root" }],
    confirmedPath: ["root", "leaf"],
  };

  it("uses explicit nodeId from payload", () => {
    expect(
      resolveTraceNodeId(session, {
        roundId: 1,
        type: "tool-call-end",
        payload: { nodeId: "leaf" },
      }),
    ).toBe("leaf");
  });

  it("resolves searchEvidence by keyword and round", () => {
    expect(
      resolveTraceNodeId(session, {
        roundId: 1,
        type: "tool-call-end",
        toolName: "searchEvidence",
        payload: { keyword: "ai trend" },
      }),
    ).toBe("leaf");
  });

  it("resolves llm-output to round root", () => {
    expect(
      resolveTraceNodeId(session, {
        roundId: 1,
        type: "llm-output",
        payload: {},
      }),
    ).toBe("root");
  });

  it("resolves confirm checkpoint to last confirmed node", () => {
    expect(
      resolveTraceNodeId(session, {
        roundId: 1,
        type: "round-checkpoint",
        payload: { confirmedPath: ["root", "leaf"] },
      }),
    ).toBe("leaf");
  });
});
