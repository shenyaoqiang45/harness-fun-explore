export interface TraceLinkageNode {
  id: string;
  keyword: string;
  roundId: number;
}

export interface TraceLinkageRound {
  roundId: number;
  rootNodeId: string;
}

export interface TraceLinkageSession {
  nodes: Record<string, TraceLinkageNode>;
  rounds: TraceLinkageRound[];
  confirmedPath?: string[];
}

export interface TraceLinkageEvent {
  roundId: number;
  type: string;
  toolName?: string;
  payload?: Record<string, unknown>;
}

export function resolveTraceNodeId(
  session: TraceLinkageSession,
  event: TraceLinkageEvent,
): string | undefined {
  const payload = event.payload ?? {};
  const explicitNodeId = payload.nodeId ?? payload.rootNodeId ?? payload.confirmedNodeId;
  if (typeof explicitNodeId === "string" && session.nodes[explicitNodeId]) {
    return explicitNodeId;
  }

  const round = session.rounds.find((item) => item.roundId === event.roundId);

  if (event.type === "round-checkpoint" && Array.isArray(payload.confirmedPath)) {
    const path = payload.confirmedPath as string[];
    return path.at(-1);
  }

  if (event.toolName === "searchEvidence" && typeof payload.keyword === "string") {
    const match = Object.values(session.nodes).find(
      (node) => node.keyword === payload.keyword && node.roundId === event.roundId,
    );
    return match?.id;
  }

  if (event.toolName === "expandKeywords" || event.type === "llm-output") {
    return round?.rootNodeId;
  }

  if (event.type === "round-checkpoint") {
    return round?.rootNodeId;
  }

  return round?.rootNodeId;
}
