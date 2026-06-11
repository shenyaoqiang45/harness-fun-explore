Status: ready-for-agent

# 05 — HTTP API integration test suite

## Parent

`.scratch/keyword-star-atlas-mvp/PRD.md`

## What to build

Vitest suite exercising `/api/start`, `/api/expand`, `/api/confirm`, `/api/session/:id`, `/api/trace/:id` through Fastify inject with mock engine deps.

## Acceptance criteria

- [ ] Happy path: start → session + trace
- [ ] expand returns await-user-click with 5 top nodes
- [ ] confirm returns confirmed status
- [ ] 404 for unknown session/trace event

## Blocked by

01-confirm-session (confirm route stable)
