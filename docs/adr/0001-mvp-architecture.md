# ADR-001: Recursive Clarification Over Single-Shot Retrieval

- **Status:** Accepted
- **Decision:** Input keyword → expand 10 candidates → rank Top 5 → user clicks to recurse.
- **Consequence:** Session round state, tree history, and confirm mechanism required.

# ADR-002: Process Transparency Over Black-Box Intelligence

- **Status:** Accepted
- **Decision:** UI shows LLM output and tool-call trace with bidirectional tree linkage.
- **Consequence:** TraceEvent model, timeline API, highlight interactions.

# ADR-003: Top-Down Frontier Layout

- **Status:** Accepted (supersedes horizontal depth axis)
- **Decision:** Current root at top, decision leaves on the bottom row.

# ADR-004: Frontier View (Current Root + Leaves)

- **Status:** Accepted
- **Decision:** Main tree shows only the **current round root** and its **Top-5 leaves**. Full exploration history stays in session state and side panels; path navigation uses a breadcrumb with backtrace.
- **Consequence:** `buildFrontierDisplayTree`, breadcrumb UI, `/api/backtrace`.

# ADR-005: Leaf Heat Display

- **Status:** Accepted
- **Decision:** Leaf labels include popularity heat (0–100).

# ADR-006: Switchable LLM Providers

- **Status:** Accepted (amended — no mock LLM)
- **Decision:** MiniMax or Kimi via environment variables. Missing API key fails at startup with an explicit error; no silent mock path.

# ADR-007: Academic Heat Evidence (OpenAlex)

- **Status:** Accepted (supersedes Baidu web heat, ADR-007 v1)
- **Context:** General web search volume (百度热搜/联想) does not reflect scholarly interest. The product needs bibliometric signals aligned with academic exploration.
- **Decision:** `searchEvidence` uses **OpenAlex** (`api.openalex.org`) as the MVP academic provider — free, official REST API, no key required (optional `OPENALEX_MAILTO` for polite pool). Metrics map to existing score dimensions:
  | Dimension | OpenAlex signal | Evidence source tag |
  | --------- | --------------- | ------------------- |
  | **Popularity (基础热度)** | Total matching works (`meta.count`), log-normalized | `openalex-corpus` |
  | **Trend (流行趋势)** | Publication counts in recent 3y vs prior 3y (`group_by=publication_year`) | `openalex-trend` |
  | **Authority (权威度)** | Median `cited_by_count` of top-25 works | `openalex-citations` |
  | **Relevance (关联度)** | Co-occurring keywords/concepts from top works | `openalex-cooccurrence` |
- **Future tiers (not MVP):** Semantic Scholar (AI/CS precision), arXiv (frontier preprints), commercial corpora — see product brief; no scraping.
- **Failure mode:** per-request 8s timeout; if OpenAlex is unreachable, throw `EvidenceUnavailableError` — no mock. Tests inject stub `EngineDeps` via `buildApp({ deps })`.
- **Consequence:** `createOpenAlexEvidenceProvider` in `src/server/evidence.ts`; leaf 热度 reflects bibliometric composite, trace panel links to openalex.org.
