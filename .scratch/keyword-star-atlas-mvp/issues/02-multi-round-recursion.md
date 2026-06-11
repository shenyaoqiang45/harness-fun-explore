Status: ready-for-agent

# 02 — Multi-round recursion behavior

## Parent

`.scratch/keyword-star-atlas-mvp/PRD.md`

## What to build

Clicking a leaf starts a new round rooted at that node. Engine and API tests prove two-round sessions produce two rounds, new leaves, and updated trace timeline.

## Acceptance criteria

- [ ] Engine test: expand from leaf creates round 2 with correct root
- [ ] API test: start → expand leaf → second round has 5 new leaves

## Blocked by

None — can start immediately.
