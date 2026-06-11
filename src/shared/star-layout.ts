export interface DisplayNodeInput {
  id: string;
  keyword: string;
  roundId: number;
  kind: "round-root" | "leaf" | "node";
  popularity?: number;
  children: DisplayNodeInput[];
}

export interface PlacedNode {
  id: string;
  keyword: string;
  roundId: number;
  kind: DisplayNodeInput["kind"];
  popularity?: number;
  x: number;
  y: number;
}

/** @deprecated Use WaveRowConfig for serpentine rows. Kept for arc-length helpers. */
export interface WaveConfig {
  startX: number;
  waveLength: number;
  baseY: number;
  amplitude: number;
  cycles: number;
}

export interface WaveRowConfig extends WaveConfig {
  rowIndex: number;
  direction: 1 | -1;
}

export type LayoutLink =
  | { kind: "spine"; row: WaveRowConfig; tStart: number; tEnd: number }
  | { kind: "turn"; x1: number; y1: number; x2: number; y2: number }
  | { kind: "leaf"; x1: number; y1: number; x2: number; y2: number };

const TARGET_ARC_GAP = 128;
const MIN_WAVE_LENGTH = 220;
const WAVE_AMPLITUDE = 42;
const WAVE_CYCLES = 1.35;
const BASE_Y = 200;
const START_X = 24;
const MAX_NODES_PER_ROW = 4;
const ROW_STRIDE = WAVE_AMPLITUDE * 2 + 72;

export function splitChainAndLeaves(data: DisplayNodeInput): {
  chain: DisplayNodeInput[];
  leaves: DisplayNodeInput[];
} {
  const chain: DisplayNodeInput[] = [];
  let current: DisplayNodeInput | undefined = data;
  while (current) {
    chain.push(current);
    const next: DisplayNodeInput | undefined = current.children[0];
    if (!next || next.kind === "leaf") {
      break;
    }
    current = next;
  }
  const leaves = current?.children.filter((child) => child.kind === "leaf") ?? [];
  return { chain, leaves };
}

export function wavePoint(t: number, wave: WaveConfig): { x: number; y: number } {
  return {
    x: wave.startX + t * wave.waveLength,
    y: wave.baseY + wave.amplitude * Math.sin(t * wave.cycles * Math.PI * 2),
  };
}

export function wavePointOnRow(geomT: number, row: WaveRowConfig): { x: number; y: number } {
  return wavePoint(geomT, row);
}

interface ArcSample {
  t: number;
  x: number;
  y: number;
  arc: number;
}

export function buildArcTable(wave: WaveConfig, samples = 256): {
  rows: ArcSample[];
  totalLength: number;
} {
  const rows: ArcSample[] = [];
  let arc = 0;

  for (let index = 0; index <= samples; index += 1) {
    const t = index / samples;
    const point = wavePoint(t, wave);
    if (index > 0) {
      const prev = rows[index - 1];
      arc += Math.hypot(point.x - prev.x, point.y - prev.y);
    }
    rows.push({ t, x: point.x, y: point.y, arc });
  }

  return { rows, totalLength: arc };
}

export function resolveWaveConfig(spineCount: number): WaveConfig {
  const probe: WaveConfig = {
    startX: START_X,
    waveLength: 400,
    baseY: BASE_Y,
    amplitude: WAVE_AMPLITUDE,
    cycles: WAVE_CYCLES,
  };
  const probeTable = buildArcTable(probe);
  const arcPerPixel = probeTable.totalLength / probe.waveLength;
  const gaps = Math.max(1, spineCount - 1);
  const neededArc = gaps * TARGET_ARC_GAP;
  const waveLength = Math.max(MIN_WAVE_LENGTH, neededArc / arcPerPixel);

  return {
    startX: START_X,
    waveLength,
    baseY: BASE_Y,
    amplitude: WAVE_AMPLITUDE,
    cycles: WAVE_CYCLES,
  };
}

export function resolveRowWaveLength(nodesInRow: number): number {
  return resolveWaveConfig(Math.min(nodesInRow, MAX_NODES_PER_ROW)).waveLength;
}

export function splitChainIntoRows<T>(chain: T[]): T[][] {
  const rows: T[][] = [];
  for (let index = 0; index < chain.length; index += MAX_NODES_PER_ROW) {
    rows.push(chain.slice(index, index + MAX_NODES_PER_ROW));
  }
  return rows;
}

export function buildRowConfig(rowIndex: number, nodesInRow: number): WaveRowConfig {
  return {
    rowIndex,
    direction: rowIndex % 2 === 0 ? 1 : -1,
    startX: START_X,
    waveLength: resolveRowWaveLength(nodesInRow),
    baseY: BASE_Y + rowIndex * ROW_STRIDE,
    amplitude: WAVE_AMPLITUDE,
    cycles: WAVE_CYCLES,
  };
}

export function tForArcLength(rows: ArcSample[], targetArc: number): number {
  if (targetArc <= 0) {
    return 0;
  }

  const total = rows[rows.length - 1]?.arc ?? 0;
  if (targetArc >= total) {
    return 1;
  }

  let low = 0;
  let high = rows.length - 1;
  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    if (rows[mid].arc < targetArc) {
      low = mid + 1;
    } else {
      high = mid;
    }
  }

  const after = rows[low];
  const before = rows[low - 1] ?? rows[0];
  const span = after.arc - before.arc || 1;
  const ratio = (targetArc - before.arc) / span;
  return before.t + (after.t - before.t) * ratio;
}

function geomTForChainIndex(localIndex: number, count: number, row: WaveRowConfig): number {
  const arcTable = buildArcTable(row);
  const targetArc =
    count === 1 ? arcTable.totalLength / 2 : (arcTable.totalLength * localIndex) / (count - 1);
  const tAlong = tForArcLength(arcTable.rows, targetArc);
  return row.direction === 1 ? tAlong : 1 - tAlong;
}

function leafFanMetrics(leafCount: number): { length: number; spreadDeg: number } {
  if (leafCount <= 1) {
    return { length: 160, spreadDeg: 0 };
  }
  return {
    length: Math.max(150, 210 - leafCount * 5),
    spreadDeg: Math.min(118, 58 + leafCount * 11),
  };
}

function leafFanCenterRad(row: WaveRowConfig): number {
  return row.direction === 1 ? 0 : Math.PI;
}

export function buildStarLayout(data: DisplayNodeInput): {
  nodes: PlacedNode[];
  links: LayoutLink[];
  rows: WaveRowConfig[];
} {
  const { chain, leaves } = splitChainAndLeaves(data);
  const rowSegments = splitChainIntoRows(chain);
  const rows = rowSegments.map((segment, rowIndex) => buildRowConfig(rowIndex, segment.length));

  const spineNodes: PlacedNode[] = [];
  const geomTs: Array<{ row: WaveRowConfig; t: number }> = [];

  rowSegments.forEach((segment, rowIndex) => {
    const row = rows[rowIndex];
    segment.forEach((item, localIndex) => {
      const geomT = geomTForChainIndex(localIndex, segment.length, row);
      const point = wavePointOnRow(geomT, row);
      geomTs.push({ row, t: geomT });
      spineNodes.push({
        id: item.id,
        keyword: item.keyword,
        roundId: item.roundId,
        kind: item.kind,
        popularity: item.popularity,
        x: point.x,
        y: point.y,
      });
    });
  });

  const links: LayoutLink[] = [];
  for (let index = 0; index < geomTs.length - 1; index += 1) {
    const start = geomTs[index];
    const end = geomTs[index + 1];
    if (start.row.rowIndex === end.row.rowIndex) {
      links.push({
        kind: "spine",
        row: start.row,
        tStart: start.t,
        tEnd: end.t,
      });
    } else {
      const from = spineNodes[index];
      const to = spineNodes[index + 1];
      links.push({
        kind: "turn",
        x1: from.x,
        y1: from.y,
        x2: to.x,
        y2: to.y,
      });
    }
  }

  const hub = spineNodes[spineNodes.length - 1];
  const lastRow = rows[rows.length - 1];
  const { length: leafLength, spreadDeg } = leafFanMetrics(leaves.length);
  const centerRad = leafFanCenterRad(lastRow);
  const leafNodes: PlacedNode[] = [];

  leaves.forEach((leaf, index) => {
    const angleDeg =
      leaves.length === 1 ? 0 : -spreadDeg / 2 + (spreadDeg / (leaves.length - 1)) * index;
    const angleRad = centerRad + (angleDeg * Math.PI) / 180;
    const placed: PlacedNode = {
      id: leaf.id,
      keyword: leaf.keyword,
      roundId: leaf.roundId,
      kind: leaf.kind,
      popularity: leaf.popularity,
      x: hub.x + leafLength * Math.cos(angleRad),
      y: hub.y + leafLength * Math.sin(angleRad),
    };
    leafNodes.push(placed);
    links.push({
      kind: "leaf",
      x1: hub.x,
      y1: hub.y,
      x2: placed.x,
      y2: placed.y,
    });
  });

  return { nodes: [...spineNodes, ...leafNodes], links, rows };
}

export function spineWavePath(
  tStart: number,
  tEnd: number,
  row: WaveRowConfig,
  steps = 14,
): string {
  const segments: string[] = [];
  for (let index = 0; index <= steps; index += 1) {
    const t = tStart + ((tEnd - tStart) * index) / steps;
    const point = wavePointOnRow(t, row);
    segments.push(index === 0 ? `M${point.x},${point.y}` : `L${point.x},${point.y}`);
  }
  return segments.join(" ");
}

export function computeViewBox(nodes: PlacedNode[]): { viewBox: string; pixelHeight: number } {
  const xs = nodes.map((node) => node.x);
  const ys = nodes.map((node) => node.y);
  const pad = { left: 24, top: 52, right: 320, bottom: 56 };
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  const width = maxX - minX + pad.left + pad.right;
  const height = maxY - minY + pad.top + pad.bottom;
  return {
    viewBox: `${minX - pad.left} ${minY - pad.top} ${width} ${height}`,
    pixelHeight: Math.max(320, Math.min(height + 40, 960)),
  };
}

export function spineArcGaps(nodes: PlacedNode[]): number[] {
  const gaps: number[] = [];
  for (let index = 1; index < nodes.length; index += 1) {
    const prev = nodes[index - 1];
    const next = nodes[index];
    gaps.push(Math.hypot(next.x - prev.x, next.y - prev.y));
  }
  return gaps;
}

export function spineVerticalSpan(nodes: PlacedNode[]): number {
  const ys = nodes.map((node) => node.y);
  return Math.max(...ys) - Math.min(...ys);
}
