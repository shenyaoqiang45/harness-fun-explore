import { describe, expect, it } from "vitest";
import { buildTreeLayout, measureTreeWidth } from "../src/shared/tree-layout.js";
import type { DisplayNodeInput } from "../src/shared/display-tree.js";

function sampleTree(): DisplayNodeInput {
  return {
    id: "root",
    keyword: "seed",
    roundId: 0,
    kind: "node",
    children: [
      {
        id: "a",
        keyword: "leaf-a",
        roundId: 1,
        kind: "leaf",
        children: [],
      },
      {
        id: "b",
        keyword: "leaf-b",
        roundId: 1,
        kind: "leaf",
        children: [
          {
            id: "b1",
            keyword: "leaf-b1",
            roundId: 2,
            kind: "leaf",
            children: [],
          },
          {
            id: "b2",
            keyword: "leaf-b2",
            roundId: 2,
            kind: "leaf",
            children: [],
          },
        ],
      },
    ],
  };
}

describe("buildTreeLayout", () => {
  it("places root above children in top-down order", () => {
    const { nodes } = buildTreeLayout(sampleTree());
    const root = nodes.find((node) => node.id === "root");
    const leaf = nodes.find((node) => node.id === "a");
    expect(root).toBeTruthy();
    expect(leaf).toBeTruthy();
    expect(root!.y).toBeLessThan(leaf!.y);
  });

  it("centers parent over its subtree", () => {
    const { nodes } = buildTreeLayout(sampleTree());
    const branch = nodes.find((node) => node.id === "b");
    const childA = nodes.find((node) => node.id === "b1");
    const childB = nodes.find((node) => node.id === "b2");
    expect(branch!.x).toBeCloseTo((childA!.x + childB!.x) / 2, 0);
  });

  it("measures subtree width by leaf count", () => {
    expect(measureTreeWidth(sampleTree())).toBe(3);
  });
});
