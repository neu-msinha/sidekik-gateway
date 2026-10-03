# sidekik-gateway

The public API for **Sidekik**, an AI apprentice ([sidekik.live](https://sidekik.live)). It is also the only path from the backend to the browser.

**Owner:** Mayukh · **Reviewer:** Aadil · **Public host:** `api.sidekik.live` · **Local port:** 8080

## What it does

- **Tenancy and sessions:** orgs, members, workflows, sessions, phases, and `sk_token` minting.
- **Trust:** consent, off-record state (the single source of truth), and Presidio PII redaction of transcript turns before they reach the bus.
- **Egress:** consumes `sk:agent.commands`, filters by off-record state, debounces spoken commands, and broadcasts them to Supabase Realtime `session:{sid}`.
- **Glue:** proxies ElevenLabs webhook tools, the MiniERP pre-save check, Work Map publish/export, and meeting-bot requests.
- **Ops:** the cost ledger (`sk:usage`) and replay mode (`POST /v1/replay/:sid`).

The full spec is in `docs/DESIGN.md`. System design and contracts are in `docs/ARCHITECTURE.md`, and the database is in `docs/SCHEMA.md`. All three are synced from [`sidekik-docs`](../sidekik-docs).

## Stack

Node 20, TypeScript (strict), Fastify, zod, pino, vitest, pnpm, and Docker (`node:20-slim`). Contracts come from `@sidekik/contracts`, pinned to a `sidekik-platform` git tag.

## Setup

```bash
# 1. Sync docs, CLAUDE.md and .env.example from sidekik-docs
cd ../sidekik-docs
bash scripts/sync-docs.sh .. --only sidekik-gateway

# 2. Configure env (values come from the team vault; never commit .env)
cd ../sidekik-gateway
cp .env.example .env

# 3. Start the shared dev stack (Redis + Presidio) from a sidekik-platform clone
docker compose -f ../sidekik-platform/dev/docker-compose.yml up -d
```

## Status

Not started. Tickets are built in the order listed in `docs/DESIGN.md` §10, beginning with ticket 1 (scaffold).
