export interface DisplayNodeInput {
  id: string;
  keyword: string;
  roundId: number;
  kind: "round-root" | "leaf" | "node";
  popularity?: number;
  onPath?: boolean;
  children: DisplayNodeInput[];
}

export interface SessionNodeLike {
  id: string;
  keyword: string;
  roundId: number;
  score?: { popularity?: number };
}

export interface SessionRoundLike {
  roundId: number;
  rootNodeId: string;
  topNodeIds: string[];
}

export interface SessionTreeLike {
  rootNodeId: string;
  nodes: Record<string, SessionNodeLike>;
  rounds: SessionRoundLike[];
}

export function computeActivePath(state: SessionTreeLike): string[] {
  const path = [state.rootNodeId];
  for (let index = 1; index < state.rounds.length; index += 1) {
    const nextRoot = state.rounds[index].rootNodeId;
    const prevTop = state.rounds[index - 1]?.topNodeIds ?? [];
    if (prevTop.includes(nextRoot)) {
      path.push(nextRoot);
    }
  }
  return path;
}

export function resolveKeepThroughRound(state: SessionTreeLike, nodeId: string): number {
  if (!state.nodes[nodeId]) {
    throw new Error("Node not found.");
  }

  if (nodeId === state.rootNodeId) {
    return state.rounds.length === 0 ? -1 : 0;
  }

  for (let index = 0; index < state.rounds.length; index += 1) {
    if (state.rounds[index].rootNodeId === nodeId) {
      return index;
    }
  }

  for (let index = 0; index < state.rounds.length; index += 1) {
    if (state.rounds[index].topNodeIds.includes(nodeId)) {
      return index;
    }
  }

  throw new Error("Node is not reachable in the current exploration tree.");
}

export function isBacktraceTarget(state: SessionTreeLike, nodeId: string): boolean {
  const lastRound = state.rounds.at(-1);
  if (!lastRound) {
    return false;
  }

  if (lastRound.topNodeIds.includes(nodeId)) {
    return false;
  }

  const path = computeActivePath(state);
  const onPath = path.includes(nodeId);
  const isRoundRoot = state.rounds.some((round) => round.rootNodeId === nodeId);

  if (!onPath && !isRoundRoot) {
    return false;
  }

  if (nodeId === state.rootNodeId) {
    return state.rounds.length > 0;
  }

  if (isRoundRoot) {
    return true;
  }

  return onPath;
}

export function buildFrontierDisplayTree(state: SessionTreeLike): DisplayNodeInput {
  const lastRound = state.rounds.at(-1);
  if (!lastRound) {
    const root = state.nodes[state.rootNodeId];
    return {
      id: root.id,
      keyword: root.keyword,
      roundId: 0,
      kind: "node",
      onPath: true,
      children: [],
    };
  }

  const rootNode = state.nodes[lastRound.rootNodeId];
  const children = lastRound.topNodeIds
    .map((childId) => state.nodes[childId])
    .filter((child): child is SessionNodeLike => Boolean(child))
    .sort((a, b) => (b.score?.popularity ?? 0) - (a.score?.popularity ?? 0))
    .map((child) => ({
      id: child.id,
      keyword: child.keyword,
      roundId: child.roundId,
      kind: "leaf" as const,
      popularity: child.score?.popularity,
      onPath: true,
      children: [],
    }));

  return {
    id: rootNode.id,
    keyword: rootNode.keyword,
    roundId: rootNode.roundId,
    kind: rootNode.id === state.rootNodeId ? "node" : "round-root",
    onPath: true,
    children,
  };
}

export function buildPathBreadcrumb(
  state: SessionTreeLike,
): Array<{ id: string; keyword: string; isCurrent: boolean }> {
  const path = computeActivePath(state);
  return path.map((id, index) => ({
    id,
    keyword: state.nodes[id]?.keyword ?? id,
    isCurrent: index === path.length - 1,
  }));
}

export function isCurrentRootBacktraceTarget(state: SessionTreeLike, nodeId: string): boolean {
  const lastRound = state.rounds.at(-1);
  if (!lastRound || state.rounds.length <= 1) {
    return false;
  }
  return nodeId === lastRound.rootNodeId;
}

export function parentBacktraceNodeId(state: SessionTreeLike): string | undefined {
  const path = computeActivePath(state);
  if (path.length < 2) {
    return undefined;
  }
  return path[path.length - 2];
}

/** @deprecated Full history tree; main UI uses buildFrontierDisplayTree per ADR-004. */
export function buildSessionDisplayTree(state: SessionTreeLike): DisplayNodeInput {
  const path = new Set(computeActivePath(state));

  function buildFrom(nodeId: string): DisplayNodeInput {
    const node = state.nodes[nodeId];
    const round = state.rounds.find((item) => item.rootNodeId === nodeId);
    const onPath = path.has(nodeId);
    const isSeed = nodeId === state.rootNodeId;

    if (!round) {
      return {
        id: nodeId,
        keyword: node.keyword,
        roundId: node.roundId,
        kind: isSeed ? "node" : "leaf",
        popularity: node.score?.popularity,
        onPath,
        children: [],
      };
    }

    const children = round.topNodeIds
      .map((childId) => state.nodes[childId])
      .filter((child): child is SessionNodeLike => Boolean(child))
      .sort((a, b) => (b.score?.popularity ?? 0) - (a.score?.popularity ?? 0))
      .map((child) => {
        const childOnPath = path.has(child.id);
        const hasNextRound = state.rounds.some((item) => item.rootNodeId === child.id);
        if (hasNextRound && childOnPath) {
          return buildFrom(child.id);
        }
        return {
          id: child.id,
          keyword: child.keyword,
          roundId: child.roundId,
          kind: "leaf" as const,
          popularity: child.score?.popularity,
          onPath: childOnPath,
          children: [],
        };
      });

    return {
      id: nodeId,
      keyword: isSeed ? node.keyword : node.keyword,
      roundId: node.roundId,
      kind: isSeed ? "node" : "round-root",
      onPath,
      children,
    };
  }

  return buildFrom(state.rootNodeId);
}
