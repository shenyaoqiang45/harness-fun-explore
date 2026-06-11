# PRD: Keyword Star Atlas MVP Completion

**Status:** ready-for-agent  
**Feature slug:** `keyword-star-atlas-mvp`

## Problem Statement

Users with fuzzy research intent need a guided exploration tool—not a single search result. The prototype validates the core loop (expand → rank → visualize → recurse) but several MVP commitments from the product README and ADRs are incomplete: users cannot confirm/freeze a path in the UI, trace and tree lack bidirectional linkage, and test coverage stops at one engine scenario.

## Solution

Complete the MVP closed loop so a user can launch from a seed keyword, recurse through ranked branches, inspect direction/persona/trace each round, confirm a final path, and replay why that path was chosen—all with behavior verified by integration-style tests.

## User Stories

1. As an explorer, I want to enter a seed keyword and see Top 5 branches on a star-map tree, so that I can compare directions visually.
2. As an explorer, I want to click a leaf to expand the next round, so that I can recurse until my intent is clear.
3. As an explorer, I want direction summary and persona hypothesis each round, so that I understand how the system interprets my path.
4. As an explorer, I want to confirm a node and freeze my path, so that I can stop exploration with a clear outcome.
5. As an explorer, I want confirmed sessions to reject further expansion, so that my final choice stays stable.
6. As an explorer, I want leaf labels to show heat scores, so that I can compare candidate popularity quickly.
7. As an explorer, I want a chronological trace of LLM and tool events, so that I trust the ranking.
8. As an explorer, I want clicking a trace row to highlight the related tree node (and vice versa), so that I can audit decisions interactively.
9. As a developer, I want HTTP API tests for start/expand/confirm/session/trace, so that refactors stay safe.
10. As a developer, I want persona inference to reflect the current round, so that early-round summaries are not empty.

## Implementation Decisions

### Modules to build or modify

- **ExplorationEngine** — fix persona timing; harden confirm behavior (already partially implemented).
- **Fastify app (`buildApp`)** — expose confirm cleanly; optional error mapping.
- **Client (`client.ts`)** — confirm button, confirmed-path display, trace↔tree highlight.
- **Tests** — engine confirm/multi-round cases; API integration via `app.inject`.

### Engine confirm contract

```
confirm(sessionId, nodeId) → SessionState
  - walks parent chain to root
  - sets confirmedPath (root → chosen node)
  - sets status = "confirmed"
  - appends round-checkpoint trace
expand after confirmed → throws
```

### Persona timing fix

Call `inferPersona` with rounds including the in-progress round context (direction inputs from current top keywords), not the pre-round history only.

### Tree display (existing ADR-004)

Keep round-root chain + latest leaves; on confirm, visually mark the confirmed node.

## Testing Decisions

- **Style:** Integration tests through public interfaces (`ExplorationEngine`, `buildApp().inject`).
- **Modules under test:** Engine (round + confirm), HTTP routes, scoring (existing).
- **Prior art:** `test/engine.test.ts`, `test/scoring.test.ts`.
- **Avoid:** Mocking internal engine methods; testing CSS/D3 layout pixels.

## Out of Scope

- Enterprise auth, multi-user collaboration, ops rule engine
- Real web search API (mock evidence remains)
- Persistent session storage across server restarts
- Mobile-native app

## Further Notes

- LLM providers (MiniMax/Kimi/mock) are wired; offline dev uses mock deps automatically.
- Run `npm run build` before `npm run dev` so `/client.js` is served.
