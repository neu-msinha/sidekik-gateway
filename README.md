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

# 4. Install and run
pnpm install
pnpm dev            # tsx watch, reads .env
```

| Script | What it does |
|---|---|
| `pnpm dev` | Run from source with reload (reads `.env`) |
| `pnpm build` / `pnpm start` | Compile to `dist/` / run the compiled server |
| `pnpm typecheck` | `tsc --noEmit` |
| `pnpm test` | vitest |

The service validates every env var at boot (`src/env.ts`) and exits with a list of what is missing. `GET /healthz` returns `{ok, version, deps}`, with 503 when a dependency is down.

## Roadmap

One PR per ticket from `docs/DESIGN.md` §10. Each PR leaves the service booting with typecheck and tests green.

| PR | Branch | Ticket | Needs |
|---|---|---|---|
| 1 | `feat/scaffold` | Fastify, CORS, Supabase JWT auth, internal/tool secrets, zod validation, `/healthz`, Dockerfile | — |
| 2 | `feat/sessions` | Sessions, consent, `sk_token` minting, voice token call, lifecycle publishing | `@sidekik/contracts`, migration 0001 |
| 3 | `feat/ws-client` | `/ws/client`: turn redaction (Presidio) and publishing | Presidio in dev stack |
| 4 | `feat/egress` | `sk:agent.commands` consumer: off-record filter, debounce, Realtime broadcast; `pnpm dev:mock` | dev fixtures |
| | | **Checkpoint 1 (H6):** session starts, turns redacted on the bus, `ask` reaches the page in < 200 ms | |
| 5 | `feat/off-record` | All triggers, spans, retroactive delete | |
| 6 | `feat/phase` | Phase API (public + internal) | |
| 7 | `feat/proxies` | Presave, tools, workmap publish/export, meeting bot, agent-host claim | |
| 8 | `feat/cost-ledger` | Cost ledger and `GET /v1/costs/:sid` | |
| 9 | `feat/replay` | Replay recorder and replayer | |
| 10 | `feat/rate-limit-logging` | Per-user rate limiting (20 req/s), structured logging | |
