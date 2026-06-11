import { describe, expect, it } from "vitest";
import {
  buildFrontierDisplayTree,
  buildPathBreadcrumb,
  buildSessionDisplayTree,
  computeActivePath,
  isBacktraceTarget,
  isCurrentRootBacktraceTarget,
  parentBacktraceNodeId,
  resolveKeepThroughRound,
} from "../src/shared/display-tree.js";

function mockSession(roundCount: number) {
  const rootId = "root";
  const nodes: Record<string, { id: string; keyword: string; roundId: number; score?: { popularity: number } }> = {
    root: { id: rootId, keyword: "seed", roundId: 0 },
  };
  const rounds = [];

  let parentId = rootId;
  for (let roundId = 1; roundId <= roundCount; roundId += 1) {
    const topNodeIds = Array.from({ length: 5 }, (_, index) => {
      const id = `r${roundId}-l${index}`;
      nodes[id] = { id, keyword: `${parentId}-leaf-${index}`, roundId, score: { popularity: 0.5 } };
      return id;
    });
    rounds.push({ roundId, rootNodeId: parentId, topNodeIds });
    parentId = topNodeIds[0];
  }

  return { rootNodeId: rootId, nodes, rounds };
}

describe("buildFrontierDisplayTree", () => {
  it("shows only current root and latest leaves", () => {
    const state = mockSession(2);
    const tree = buildFrontierDisplayTree(state);
    expect(tree.id).toBe(state.rounds[1].rootNodeId);
    expect(tree.children).toHaveLength(5);
    expect(tree.children.every((child) => child.kind === "leaf")).toBe(true);
    expect(tree.children.every((child) => child.children.length === 0)).toBe(true);
  });

  it("shows seed only before any round completes", () => {
    const state = { rootNodeId: "root", nodes: { root: { id: "root", keyword: "seed", roundId: 0 } }, rounds: [] };
    const tree = buildFrontierDisplayTree(state);
    expect(tree.id).toBe("root");
    expect(tree.children).toHaveLength(0);
  });
});

describe("path navigation", () => {
  it("builds breadcrumb from active path", () => {
    const state = mockSession(3);
    const crumbs = buildPathBreadcrumb(state);
    expect(crumbs).toHaveLength(3);
    expect(crumbs.at(-1)?.isCurrent).toBe(true);
  });

  it("resolves parent for one-step backtrace from current root", () => {
    const state = mockSession(2);
    const currentRoot = state.rounds[1].rootNodeId;
    expect(isCurrentRootBacktraceTarget(state, currentRoot)).toBe(true);
    expect(parentBacktraceNodeId(state)).toBe("root");
  });

  it("resolves backtrace keep-through round", () => {
    const state = mockSession(3);
    expect(resolveKeepThroughRound(state, "root")).toBe(0);
    expect(resolveKeepThroughRound(state, state.rounds[1].rootNodeId)).toBe(1);
    expect(resolveKeepThroughRound(state, state.rounds[2].rootNodeId)).toBe(2);
  });
});

describe("buildSessionDisplayTree (legacy)", () => {
  it("still builds full history tree when needed", () => {
    const state = mockSession(2);
    const tree = buildSessionDisplayTree(state);
    expect(tree.children[0].children).toHaveLength(5);
  });
});

describe("computeActivePath", () => {
  it("follows chosen round roots", () => {
    const state = mockSession(3);
    const path = computeActivePath(state);
    expect(path[0]).toBe("root");
    expect(path).toHaveLength(3);
  });
});

describe("isBacktraceTarget (legacy)", () => {
  it("detects frontier leaves as expand targets, not backtrace targets", () => {
    const state = mockSession(2);
    const frontier = state.rounds[1].topNodeIds[0];
    expect(isBacktraceTarget(state, frontier)).toBe(false);
    expect(isBacktraceTarget(state, "root")).toBe(true);
  });
});
