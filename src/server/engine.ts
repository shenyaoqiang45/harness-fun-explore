import { randomUUID } from "node:crypto";
import { scoreKeyword } from "../shared/scoring.js";
import type {
  DirectionSummary,
  EvidenceItem,
  KeywordNode,
  PersonaHypothesis,
  RoundResult,
  SessionState,
} from "../shared/types.js";
import { resolveKeepThroughRound } from "../shared/display-tree.js";
import { TraceStore } from "./trace-store.js";

export interface EngineDeps {
  expandKeywords: (seed: string) => Promise<string[]>;
  searchEvidence: (keyword: string) => Promise<EvidenceItem[]>;
  summarizeDirection: (rootKeyword: string, topKeywords: string[]) => Promise<DirectionSummary>;
  inferPersona: (rounds: RoundResult[]) => Promise<PersonaHypothesis>;
}

function topAuthority(evidence: EvidenceItem[]): number {
  return evidence.reduce((max, item) => Math.max(max, item.sourceAuthority), 0);
}

function avgPopularity(evidence: EvidenceItem[]): number {
  if (evidence.length === 0) {
    return 0;
  }
  const total = evidence.reduce((sum, item) => sum + item.popularity, 0);
  return total / evidence.length;
}

function semanticRelevance(seed: string, keyword: string): number {
  const seedTokens = new Set(seed.toLowerCase().split(/\s+/));
  const keywordTokens = keyword.toLowerCase().split(/\s+/);
  const overlap = keywordTokens.filter((token) => seedTokens.has(token)).length;
  return Math.max(0.2, Math.min(1, overlap / Math.max(seedTokens.size, 1) + 0.3));
}

export class ExplorationEngine {
  private readonly sessions = new Map<string, SessionState>();

  constructor(
    private readonly deps: EngineDeps,
    private readonly traces: TraceStore,
  ) {}

  async start(keyword: string): Promise<SessionState> {
    const sessionId = randomUUID();
    const rootNodeId = randomUUID();

    const rootNode: KeywordNode = {
      id: rootNodeId,
      keyword,
      roundId: 0,
      parentId: null,
      score: {
        semanticRelevance: 1,
        popularity: 0,
        sourceAuthority: 0,
        compositeScore: 1,
      },
      evidence: [],
      children: [],
    };

    const initialState: SessionState = {
      sessionId,
      status: "draft",
      currentRootNodeId: rootNodeId,
      rootNodeId,
      nodes: { [rootNodeId]: rootNode },
      rounds: [],
      confirmedPath: [],
    };

    this.sessions.set(sessionId, initialState);
    return this.expand(sessionId, rootNodeId);
  }

  async expand(sessionId: string, rootNodeId: string): Promise<SessionState> {
    const session = this.mustGetSession(sessionId);
    if (session.status === "confirmed") {
      throw new Error("Session is already confirmed.");
    }

    const rootNode = session.nodes[rootNodeId];
    if (!rootNode) {
      throw new Error("Root node not found.");
    }

    const existingRoundIndex = session.rounds.findIndex((round) => round.rootNodeId === rootNodeId);
    if (existingRoundIndex >= 0) {
      this.truncateSession(session, existingRoundIndex - 1);
    } else {
      const parentRoundIndex = session.rounds.findIndex((round) => round.topNodeIds.includes(rootNodeId));
      if (parentRoundIndex >= 0 && parentRoundIndex < session.rounds.length - 1) {
        this.truncateSession(session, parentRoundIndex);
      }
    }

    const roundId = session.rounds.length + 1;
    session.status = "expanding";

    const t1 = Date.now();
    this.traces.append({
      sessionId,
      roundId,
      type: "tool-call-start",
      toolName: "expandKeywords",
      summary: "Expanding into 10 candidates",
      payload: { rootKeyword: rootNode.keyword, rootNodeId },
    });

    const candidates = (await this.deps.expandKeywords(rootNode.keyword)).slice(0, 10);
    this.traces.append({
      sessionId,
      roundId,
      type: "tool-call-end",
      toolName: "expandKeywords",
      status: "ok",
      durationMs: Date.now() - t1,
      summary: "Generated candidate keywords",
      payload: { candidates, rootNodeId },
    });

    const scored = [] as Array<{ keyword: string; node: KeywordNode }>;

    for (const keyword of candidates) {
      const t2 = Date.now();
      this.traces.append({
        sessionId,
        roundId,
        type: "tool-call-start",
        toolName: "searchEvidence",
        summary: "Searching evidence",
        payload: { keyword },
      });

      const evidence = await this.deps.searchEvidence(keyword);

      const score = scoreKeyword({
        semanticRelevance: semanticRelevance(rootNode.keyword, keyword),
        popularity: avgPopularity(evidence),
        sourceAuthority: topAuthority(evidence),
      });

      const node: KeywordNode = {
        id: randomUUID(),
        keyword,
        roundId,
        parentId: rootNodeId,
        score,
        evidence,
        children: [],
      };

      this.traces.append({
        sessionId,
        roundId,
        type: "tool-call-end",
        toolName: "searchEvidence",
        status: "ok",
        durationMs: Date.now() - t2,
        summary: "Evidence collected",
        payload: { keyword, evidenceCount: evidence.length, nodeId: node.id },
      });

      scored.push({ keyword, node });
    }

    const top = scored
      .sort((a, b) => b.node.score.compositeScore - a.node.score.compositeScore)
      .slice(0, 5);

    for (const item of top) {
      session.nodes[item.node.id] = item.node;
      rootNode.children.push(item.node.id);
    }

    const topKeywords = top.map((item) => item.keyword);
    const directionSummary = await this.deps.summarizeDirection(rootNode.keyword, topKeywords);
    const personaHypothesis = await this.deps.inferPersona([
      ...session.rounds,
      {
        roundId,
        rootNodeId,
        candidateKeywords: candidates,
        topNodeIds: top.map((item) => item.node.id),
        directionSummary,
        personaHypothesis: {
          label: "",
          confidence: 0,
          reason: "",
        },
      },
    ]);

    this.traces.append({
      sessionId,
      roundId,
      type: "llm-output",
      summary: "Direction summary and persona updated",
      payload: { directionSummary, personaHypothesis, rootNodeId },
    });

    const round: RoundResult = {
      roundId,
      rootNodeId,
      candidateKeywords: candidates,
      topNodeIds: top.map((item) => item.node.id),
      directionSummary,
      personaHypothesis,
    };

    session.rounds.push(round);
    session.currentRootNodeId = rootNodeId;
    session.status = "await-user-click";

    this.traces.append({
      sessionId,
      roundId,
      type: "round-checkpoint",
      summary: "Round completed",
      payload: {
        candidateCount: candidates.length,
        selectedCount: round.topNodeIds.length,
        rootNodeId,
        topNodeIds: round.topNodeIds,
      },
    });

    return session;
  }

  backtrace(sessionId: string, nodeId: string): SessionState {
    const session = this.mustGetSession(sessionId);
    if (session.status === "confirmed") {
      throw new Error("Session is already confirmed.");
    }

    const keepThrough = resolveKeepThroughRound(session, nodeId);
    this.truncateSession(session, keepThrough);

    this.traces.append({
      sessionId,
      roundId: session.rounds.length,
      type: "round-checkpoint",
      summary: "Backtrace to earlier layer",
      payload: {
        nodeId,
        keepThroughRound: keepThrough,
        currentRootNodeId: session.currentRootNodeId,
      },
    });

    session.status = "await-user-click";
    return session;
  }

  confirm(sessionId: string, nodeId: string): SessionState {
    const session = this.mustGetSession(sessionId);
    const path: string[] = [];

    let current: KeywordNode | undefined = session.nodes[nodeId];
    if (!current) {
      throw new Error("Node not found for confirmation.");
    }

    while (current) {
      path.push(current.id);
      current = current.parentId ? session.nodes[current.parentId] : undefined;
    }

    session.confirmedPath = path.reverse();
    session.status = "confirmed";

    this.traces.append({
      sessionId,
      roundId: session.rounds.length,
      type: "round-checkpoint",
      summary: "Session confirmed",
      payload: {
        confirmedPath: session.confirmedPath,
        confirmedNodeId: nodeId,
      },
    });

    return session;
  }

  getSession(sessionId: string): SessionState | undefined {
    return this.sessions.get(sessionId);
  }

  private mustGetSession(sessionId: string): SessionState {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error("Session not found.");
    }
    return session;
  }

  private truncateSession(session: SessionState, keepThroughRoundIndex: number): void {
    if (keepThroughRoundIndex < 0) {
      const root = session.nodes[session.rootNodeId];
      root.children = [];
      session.rounds = [];
      session.currentRootNodeId = session.rootNodeId;

      for (const id of Object.keys(session.nodes)) {
        if (id !== session.rootNodeId) {
          delete session.nodes[id];
        }
      }
      return;
    }

    const keptRounds = session.rounds.slice(0, keepThroughRoundIndex + 1);
    const keepIds = new Set<string>([session.rootNodeId]);

    for (const round of keptRounds) {
      keepIds.add(round.rootNodeId);
      for (const id of round.topNodeIds) {
        keepIds.add(id);
      }
    }

    session.rounds = keptRounds;

    for (const id of Object.keys(session.nodes)) {
      if (!keepIds.has(id)) {
        delete session.nodes[id];
      }
    }

    for (const id of keepIds) {
      const node = session.nodes[id];
      if (node) {
        node.children = node.children.filter((childId) => keepIds.has(childId));
      }
    }

    session.currentRootNodeId =
      keptRounds[keptRounds.length - 1]?.rootNodeId ?? session.rootNodeId;
  }
}

export const defaultEngineDeps: EngineDeps = {
  async expandKeywords(seed) {
    return [
      `${seed} trend`,
      `${seed} strategy`,
      `${seed} use case`,
      `${seed} workflow`,
      `${seed} platform`,
      `${seed} benchmark`,
      `${seed} framework`,
      `${seed} roadmap`,
      `${seed} architecture`,
      `${seed} adoption`,
    ];
  },

  async searchEvidence(keyword) {
    const normalized = keyword.length % 10;
    const popularity = Math.min(1, 0.3 + normalized / 10);
    const authority = Math.min(1, 0.4 + (keyword.split(" ").length % 5) / 10);
    return [
      {
        source: "public-web",
        title: `${keyword} insight`,
        url: `https://example.com/search?q=${encodeURIComponent(keyword)}`,
        popularity,
        sourceAuthority: authority,
      },
    ];
  },

  async summarizeDirection(rootKeyword, topKeywords) {
    return {
      label: `Exploring ${rootKeyword}`,
      reason: `Top branches emphasize: ${topKeywords.slice(0, 3).join(", ")}`,
    };
  },

  async inferPersona(rounds) {
    const confidence = Math.min(0.95, 0.55 + rounds.length * 0.08);
    return {
      label: rounds.length > 1 ? "Decision-focused explorer" : "Early-stage explorer",
      confidence,
      reason: "User keeps refining branches to reduce ambiguity.",
    };
  },
};
