import type { DisplayNodeInput } from "./display-tree.js";

export interface PlacedNode {
  id: string;
  keyword: string;
  roundId: number;
  kind: DisplayNodeInput["kind"];
  popularity?: number;
  onPath?: boolean;
  x: number;
  y: number;
}

export interface TreeLink {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

const NODE_WIDTH = 118;
const LEVEL_HEIGHT = 92;
const ORIGIN_X = 48;
const ORIGIN_Y = 44;

export function measureTreeWidth(node: DisplayNodeInput): number {
  if (node.children.length === 0) {
    return 1;
  }
  return node.children.reduce((sum, child) => sum + measureTreeWidth(child), 0);
}

function placeTree(
  node: DisplayNodeInput,
  depth: number,
  left: number,
  nodes: PlacedNode[],
  links: TreeLink[],
  parent?: { x: number; y: number },
): void {
  const width = measureTreeWidth(node);
  const center = left + width / 2;
  const x = ORIGIN_X + center * NODE_WIDTH;
  const y = ORIGIN_Y + depth * LEVEL_HEIGHT;

  nodes.push({
    id: node.id,
    keyword: node.keyword,
    roundId: node.roundId,
    kind: node.kind,
    popularity: node.popularity,
    onPath: node.onPath,
    x,
    y,
  });

  if (parent) {
    links.push({ x1: parent.x, y1: parent.y, x2: x, y2: y });
  }

  let cursor = left;
  for (const child of node.children) {
    const childWidth = measureTreeWidth(child);
    placeTree(child, depth + 1, cursor, nodes, links, { x, y });
    cursor += childWidth;
  }
}

export function buildTreeLayout(root: DisplayNodeInput): {
  nodes: PlacedNode[];
  links: TreeLink[];
} {
  const nodes: PlacedNode[] = [];
  const links: TreeLink[] = [];
  placeTree(root, 0, 0, nodes, links);
  return { nodes, links };
}

export function computeViewBox(nodes: PlacedNode[]): { viewBox: string; pixelHeight: number } {
  const xs = nodes.map((node) => node.x);
  const ys = nodes.map((node) => node.y);
  const pad = { left: 32, top: 56, right: 48, bottom: 64 };
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

export function treeLinkPath(link: TreeLink): string {
  const midY = (link.y1 + link.y2) / 2;
  return `M${link.x1},${link.y1} C${link.x1},${midY} ${link.x2},${midY} ${link.x2},${link.y2}`;
}
