Status: ready-for-agent

# 04 — Trace ↔ tree bidirectional highlight

## Parent

`.scratch/keyword-star-atlas-mvp/PRD.md`

## What to build

Clicking a trace row highlights the related tree node; clicking a highlighted node filters or scrolls trace. Payload fields (`rootKeyword`, `keyword`, checkpoint node ids) drive linkage.

## Acceptance criteria

- [ ] Click trace item highlights corresponding SVG node
- [ ] Click tree node filters trace list to same round
- [ ] Works for expand/search/llm/checkpoint events

## Blocked by

01-confirm-session (stable session UI patterns)
