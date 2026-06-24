# Domain Glossary — Keyword Star Atlas

## Core concepts

| Term | Definition |
| ---- | ---------- |
| **Session** | A single exploration run from seed keyword to optional confirmation. |
| **Round** | One expand cycle: 5 candidate keywords → evidence scoring → Top 5 leaves. |
| **Keyword node** | A node in the exploration tree (root, round root, or leaf). |
| **Round root** | The keyword the user chose to expand in a given round. |
| **Leaf node** | A Top-5 candidate from the latest round; clickable to start the next round. |
| **Direction summary** | LLM output describing where exploration is converging. |
| **Persona hypothesis** | LLM output inferring the user's exploratory intent. |
| **Trace event** | A recorded LLM output or tool-call step for transparency. |
| **Confirmed path** | Frozen chain of node IDs from root to the user's final choice. |
| **Heat (热度)** | Leaf bibliometric score scaled 0–100 for display; from OpenAlex (发文量、被引、趋势、共现词, ADR-007). Fails loudly if unavailable. |

## Session statuses

`draft` → `expanding` → `await-user-click` → (repeat) → `confirmed`

## Architecture modules

| Module | Role |
| ------ | ---- |
| **ExplorationEngine** | Session state, round orchestration, confirm. |
| **TraceStore** | Append-only trace timeline per session. |
| **EngineDeps** | Injectable LLM + evidence providers. |
| **OpenAlexEvidenceProvider** | `searchEvidence` impl fetching bibliometric heat from OpenAlex REST API. |
| **scoreKeyword** | Composite ranking from relevance, popularity, authority. |
