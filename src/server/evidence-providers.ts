import type { EvidenceProviderId, EvidenceProviderInfo } from "../shared/types.js";
import type { EngineDeps } from "./engine.js";
import { createArxivEvidenceProvider } from "./evidence-arxiv.js";
import { createOpenAlexEvidenceProvider } from "./evidence.js";
import { createSemanticScholarEvidenceProvider } from "./evidence-semantic-scholar.js";

export const EVIDENCE_PROVIDER_CATALOG: EvidenceProviderInfo[] = [
  { id: "openalex", label: "OpenAlex" },
  { id: "semantic-scholar", label: "Semantic Scholar" },
  { id: "arxiv", label: "arXiv" },
];

export function listAvailableEvidenceProviders(): EvidenceProviderInfo[] {
  return [...EVIDENCE_PROVIDER_CATALOG];
}

export function resolveDefaultEvidenceProvider(
  envValue: string | undefined,
  available: EvidenceProviderInfo[] = listAvailableEvidenceProviders(),
): EvidenceProviderId {
  const candidate = (envValue ?? process.env.EVIDENCE_PROVIDER ?? "openalex").trim();
  const match = available.find((item) => item.id === candidate);
  return match?.id ?? "openalex";
}

export interface EvidenceProviderFactoryOptions {
  openAlexMailto?: string;
  semanticScholarApiKey?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export function createEvidenceProvider(
  id: EvidenceProviderId,
  options: EvidenceProviderFactoryOptions = {},
): EngineDeps["searchEvidence"] {
  const shared = {
    fetchImpl: options.fetchImpl,
    timeoutMs: options.timeoutMs,
  };

  switch (id) {
    case "openalex":
      return createOpenAlexEvidenceProvider({
        ...shared,
        mailto: options.openAlexMailto,
      });
    case "semantic-scholar":
      return createSemanticScholarEvidenceProvider({
        ...shared,
        apiKey: options.semanticScholarApiKey,
      });
    case "arxiv":
      return createArxivEvidenceProvider(shared);
    default: {
      const _exhaustive: never = id;
      return _exhaustive;
    }
  }
}
