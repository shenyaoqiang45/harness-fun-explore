Status: ready-for-agent

# 01 — Confirm session end-to-end

## Parent

`.scratch/keyword-star-atlas-mvp/PRD.md`

## What to build

A user can confirm exploration by choosing a node. The engine records `confirmedPath`, sets `status: confirmed`, rejects further `expand`, and the UI exposes a Confirm action on clickable nodes.

## Acceptance criteria

- [ ] Engine test: confirm builds root→node path and blocks expand
- [ ] API test: `POST /api/confirm` returns confirmed session
- [ ] UI: Confirm control calls API and shows frozen status

## Blocked by

None — can start immediately.
