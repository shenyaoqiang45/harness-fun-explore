import { describe, expect, it } from "vitest";
import {
  buildArcTable,
  buildStarLayout,
  resolveWaveConfig,
  spineArcGaps,
  spineVerticalSpan,
  splitChainAndLeaves,
  splitChainIntoRows,
  tForArcLength,
  type DisplayNodeInput,
} from "../src/shared/star-layout.js";

function chainData(roundCount: number, leafCount = 5): DisplayNodeInput {
  const leaves = Array.from({ length: leafCount }, (_, index) => ({
    id: `l${index}`,
    keyword: `leaf-${index}`,
    roundId: roundCount,
    kind: "leaf" as const,
    children: [],
  }));

  let root: DisplayNodeInput = {
    id: `r${roundCount}`,
    keyword: `round-${roundCount}`,
    roundId: roundCount,
    kind: "round-root",
    children: leaves,
  };

  for (let roundId = roundCount - 1; roundId >= 1; roundId -= 1) {
    root = {
      id: `r${roundId}`,
      keyword: `round-${roundId}`,
      roundId,
      kind: "round-root",
      children: [root],
    };
  }

  return root;
}

describe("buildStarLayout", () => {
  it("fans leaves from the wave endpoint", () => {
    const { nodes, links } = buildStarLayout(chainData(2, 5));
    const spine = nodes.filter((node) => node.kind === "round-root");
    const fan = nodes.filter((node) => node.kind === "leaf");

    expect(spine).toHaveLength(2);
    expect(fan).toHaveLength(5);
    expect(links.filter((link) => link.kind === "leaf")).toHaveLength(5);

    for (const leaf of fan) {
      expect(leaf.x).toBeGreaterThan(spine.at(-1)!.x);
    }
  });

  it("spaces spine nodes evenly within each serpentine row", () => {
    const { nodes } = buildStarLayout(chainData(4, 3));
    const spine = nodes.filter((node) => node.kind === "round-root");
    const gaps = spineArcGaps(spine);
    const average = gaps.reduce((sum, gap) => sum + gap, 0) / gaps.length;

    for (const gap of gaps) {
      expect(Math.abs(gap - average) / average).toBeLessThan(0.15);
    }
  });

  it("wraps spine into multiple rows instead of stretching horizontally forever", () => {
    const short = buildStarLayout(chainData(3, 3));
    const long = buildStarLayout(chainData(10, 3));
    const shortSpine = short.nodes.filter((node) => node.kind === "round-root");
    const longSpine = long.nodes.filter((node) => node.kind === "round-root");

    const { chain } = splitChainAndLeaves(chainData(10, 3));
    expect(splitChainIntoRows(chain)).toHaveLength(3);
    expect(long.rows).toHaveLength(3);
    expect(long.links.some((link) => link.kind === "turn")).toBe(true);
    expect(spineVerticalSpan(longSpine)).toBeGreaterThan(spineVerticalSpan(shortSpine) + 80);
    expect(Math.max(...longSpine.map((node) => node.x))).toBeLessThan(
      Math.max(...shortSpine.map((node) => node.x)) * 2.5,
    );
  });

  it("resolves row wave length from node density", () => {
    const shortWave = resolveWaveConfig(2);
    const longWave = resolveWaveConfig(4);
    expect(longWave.waveLength).toBeGreaterThan(shortWave.waveLength);
  });

  it("samples arc length monotonically across the wave", () => {
    const wave = resolveWaveConfig(3);
    const table = buildArcTable(wave);
    const quarter = tForArcLength(table.rows, table.totalLength * 0.25);
    const half = tForArcLength(table.rows, table.totalLength * 0.5);
    const threeQuarter = tForArcLength(table.rows, table.totalLength * 0.75);

    expect(quarter).toBeGreaterThan(0);
    expect(half).toBeGreaterThan(quarter);
    expect(threeQuarter).toBeGreaterThan(half);
    expect(threeQuarter).toBeLessThan(1);
  });

  it("splits chain roots from leaf children", () => {
    const data = chainData(3, 5);
    const { chain, leaves } = splitChainAndLeaves(data);
    expect(chain).toHaveLength(3);
    expect(leaves).toHaveLength(5);
  });
});
