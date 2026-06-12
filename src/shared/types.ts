export type SessionStatus =
  | "draft"
  | "expanding"
  | "ranked"
  | "await-user-click"
  | "confirmed"
  | "error";

export type LlmProviderId = "kimi" | "deepseek" | "minimax";

export interface LlmProviderInfo {
  id: LlmProviderId;
  label: string;
  model: string;
}

export type EvidenceProviderId = "openalex" | "semantic-scholar" | "arxiv";

export interface EvidenceProviderInfo {
  id: EvidenceProviderId;
  label: string;
}

export interface ScoreBreakdown {
  semanticRelevance: number;
  popularity: number;
  sourceAuthority: number;
  compositeScore: number;
}

export interface EvidenceItem {
  source: string;
  title: string;
  url: string;
  popularity: number;
  sourceAuthority: number;
}

export interface KeywordNode {
  id: string;
  keyword: string;
  roundId: number;
  parentId: string | null;
  score: ScoreBreakdown;
  evidence: EvidenceItem[];
  children: string[];
}

export interface DirectionSummary {
  label: string;
  reason: string;
}

export interface PersonaHypothesis {
  label: string;
  confidence: number;
  reason: string;
}

export interface RoundResult {
  roundId: number;
  rootNodeId: string;
  candidateKeywords: string[];
  topNodeIds: string[];
  directionSummary: DirectionSummary;
  personaHypothesis: PersonaHypothesis;
}

export type TraceEventType =
  | "llm-output"
  | "tool-call-start"
  | "tool-call-end"
  | "tool-call-error"
  | "round-checkpoint";

export interface TraceEvent {
  id: string;
  sessionId: string;
  roundId: number;
  sequence: number;
  type: TraceEventType;
  toolName?: string;
  status?: "ok" | "error";
  timestamp: string;
  durationMs?: number;
  summary: string;
  payload: Record<string, unknown>;
}

export interface SessionState {
  sessionId: string;
  status: SessionStatus;
  llmProvider: LlmProviderId;
  evidenceProvider: EvidenceProviderId;
  currentRootNodeId: string;
  rootNodeId: string;
  nodes: Record<string, KeywordNode>;
  rounds: RoundResult[];
  confirmedPath: string[];
}

export interface ExpandRequest {
  sessionId: string;
  rootNodeId: string;
}

export interface StartSessionRequest {
  keyword: string;
  llmProvider?: LlmProviderId;
  evidenceProvider?: EvidenceProviderId;
}

export interface ConfirmRequest {
  sessionId: string;
  nodeId: string;
}

export interface BacktraceRequest {
  sessionId: string;
  nodeId: string;
}
