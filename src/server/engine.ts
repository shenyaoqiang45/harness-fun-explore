import { randomUUID } from "node:crypto";
import { scoreKeyword } from "../shared/scoring.js";
import type {
  DirectionSummary,
  EvidenceItem,
  EvidenceProviderId,
  KeywordNode,
  LlmProviderId,
  PersonaHypothesis,
  RoundResult,
  SessionState,
} from "../shared/types.js";
import { resolveKeepThroughRound } from "../shared/display-tree.js";
import { TraceStore } from "./trace-store.js";

export interface EngineDeps {
  expandKeywords: (seed: string) => Promise<string[]>;
  searchEvidence: (keyword: string) => Promise<EvidenceItem[]>;
  summarizeRound: (
    rootKeyword: string,
    topKeywords: string[],
    priorRounds: RoundResult[],
  ) => Promise<{ directionSummary: DirectionSummary; personaHypothesis: PersonaHypothesis }>;
}

export interface EngineDepsSource {
  defaultProvider: LlmProviderId;
  defaultEvidenceProvider: EvidenceProviderId;
  resolve(session: Pick<SessionState, "llmProvider" | "evidenceProvider">): EngineDeps;
}

export type EngineBinding = EngineDeps | EngineDepsSource;

function isDepsSource(binding: EngineBinding): binding is EngineDepsSource {
  return "resolve" in binding;
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
    private readonly binding: EngineBinding,
    private readonly traces: TraceStore,
  ) {}

  getDefaultProvider(): LlmProviderId {
    return isDepsSource(this.binding) ? this.binding.defaultProvider : "kimi";
  }

  getDefaultEvidenceProvider(): EvidenceProviderId {
    return isDepsSource(this.binding) ? this.binding.defaultEvidenceProvider : "openalex";
  }

  private resolveDeps(session: SessionState): EngineDeps {
    return isDepsSource(this.binding)
      ? this.binding.resolve({
          llmProvider: session.llmProvider,
          evidenceProvider: session.evidenceProvider,
        })
      : this.binding;
  }

  createSession(
    keyword: string,
    llmProvider?: LlmProviderId,
    evidenceProvider?: EvidenceProviderId,
  ): SessionState {
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
      llmProvider: llmProvider ?? this.getDefaultProvider(),
      evidenceProvider: evidenceProvider ?? this.getDefaultEvidenceProvider(),
      currentRootNodeId: rootNodeId,
      rootNodeId,
      nodes: { [rootNodeId]: rootNode },
      rounds: [],
      confirmedPath: [],
    };

    this.sessions.set(sessionId, initialState);
    return initialState;
  }

  async start(keyword: string, llmProvider?: LlmProviderId): Promise<SessionState> {
    const session = this.createSession(keyword, llmProvider);
    return this.expand(session.sessionId, session.rootNodeId);
  }

  markExpanding(sessionId: string): void {
    const session = this.mustGetSession(sessionId);
    session.status = "expanding";
  }

  scheduleExpand(sessionId: string, rootNodeId: string): void {
    this.markExpanding(sessionId);
    void this.expand(sessionId, rootNodeId).catch((error: unknown) => {
      this.markFailed(sessionId, error);
    });
  }

  markFailed(sessionId: string, error: unknown): void {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return;
    }

    session.status = "error";
    const message = error instanceof Error ? error.message : String(error);
    this.traces.append({
      sessionId,
      roundId: session.rounds.length + 1,
      type: "tool-call-error",
      toolName: "expand",
      status: "error",
      summary: message.slice(0, 200),
      payload: { message },
    });
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
    const deps = this.resolveDeps(session);

    const t1 = Date.now();
    this.traces.append({
      sessionId,
      roundId,
      type: "tool-call-start",
      toolName: "expandKeywords",
      summary: "Expanding into 5 candidates",
      payload: { rootKeyword: rootNode.keyword, rootNodeId },
    });

    const candidates = (await deps.expandKeywords(rootNode.keyword)).slice(0, 5);
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

    const scored = await Promise.all(
      candidates.map(async (keyword) => {
        const t2 = Date.now();
        this.traces.append({
          sessionId,
          roundId,
          type: "tool-call-start",
          toolName: "searchEvidence",
          summary: `Searching evidence · ${keyword}`,
          payload: { keyword },
        });

        const evidence = await deps.searchEvidence(keyword);

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
          summary: `Evidence collected · ${keyword}`,
          payload: { keyword, evidenceCount: evidence.length, nodeId: node.id },
        });

        return { keyword, node };
      }),
    );

    const top = scored
      .sort((a, b) => b.node.score.compositeScore - a.node.score.compositeScore)
      .slice(0, 5);

    for (const item of top) {
      session.nodes[item.node.id] = item.node;
      rootNode.children.push(item.node.id);
    }

    const topKeywords = top.map((item) => item.keyword);
    const t3 = Date.now();
    this.traces.append({
      sessionId,
      roundId,
      type: "tool-call-start",
      toolName: "summarizeRound",
      summary: "Summarizing direction and persona",
      payload: { rootKeyword: rootNode.keyword, topKeywords },
    });

    const { directionSummary, personaHypothesis } = await deps.summarizeRound(
      rootNode.keyword,
      topKeywords,
      session.rounds,
    );

    this.traces.append({
      sessionId,
      roundId,
      type: "tool-call-end",
      toolName: "summarizeRound",
      status: "ok",
      durationMs: Date.now() - t3,
      summary: "Direction summary and persona updated",
      payload: { directionSummary, personaHypothesis },
    });

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
