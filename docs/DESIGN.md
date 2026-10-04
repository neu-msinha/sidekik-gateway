# sidekik-gateway: DESIGN

**Owner:** Mayukh · **Reviewer:** Aadil · **Public host:** `api.sidekik.live` · **Local port:** 8080

## 1. Purpose

The gateway is the **only public API** and the **only path from backend to browser**. It owns:

- **Tenancy and sessions:** orgs, members, workflows, sessions, phases.
- **Trust:**
  - consent
  - the off-record state (the single source of truth)
  - PII redaction of transcript turns before they reach the bus
- **Egress:** it consumes `sk:agent.commands`, filters them by off-record state, and broadcasts them to Supabase Realtime `session:{sid}`.
- **Glue:**
  - proxies ElevenLabs webhook tools to mapper and tutor
  - forwards the MiniERP pre-save check to tutor
  - handles meeting bot requests
- **Ops:** the cost ledger and replay mode.

## 2. Public API (`/v1`, Supabase JWT unless noted)

| Method | Path | Body → Response | Notes |
|---|---|---|---|
| POST | `/v1/sessions` | `{workflow_id, kind, mode, language, workmap_id?}` → `{session_id, sk_token, el:{conversation_token, agent_id, dynamic_variables}, ingest_url}` | Inserts `sessions` (phase `capture` or `tutoring`), loads `expert_memory` for `prior_summary` and `open_items`, calls voice `/internal/token`, publishes lifecycle `started` |
| POST | `/v1/sessions/:id/consent` | `{text_version, scopes:["audio","screen","storage"]}` | Sets `sessions.consent_at`. Perception and `/ws/client` reject connections until it's set (one DB lookup on connect). |
| POST | `/v1/sessions/:id/phase` | `{event:"task_done"}` | Phase becomes `building`; publishes lifecycle `task_done` |
| POST | `/v1/sessions/:id/off-record` | `{on, source:"ui"\|"agent"\|"chat"}` | See §4 |
| POST | `/v1/sessions/:id/end` | | Lifecycle `ended`; removes the bot if one is present |
| POST | `/v1/sessions/:id/meeting-bot` | `{meeting_url}` | → meetbot |
| POST | `/v1/sessions/:id/presave` | `{state: InvoiceState}` → `{allow, guardrail_id?, quote?, step_id?}` | → tutor, 300 ms timeout |
| GET | `/v1/sessions/:id/timeline` | | Merged events, turns, questions and decisions, ordered by `t_ms` |
| POST | `/v1/workmaps/:id/publish` | → `{job_id}` | → mapper (async) |
| GET | `/v1/workmaps/:id/export?format=agent` | | → mapper |
| GET | `/v1/workmaps/:id/steps/:step/clip` | → `{url}` | Signed URL, 10 min |
| GET | `/v1/costs/:sid` | → ledger + counterfactual | |
| POST | `/v1/replay/:sid` | `{speed}` | Re-publishes `replay_events` |
| POST | `/v1/agent-host/claim` | `{t}` (no JWT) → `{sk_token, el}` | One-time token; marks it used. The `sk_token` carries the session's own role (`expert` for capture, `learner` for tutor): `SessionRole` has no agent-host role. |
| POST | `/v1/tools/recall_context` | (ElevenLabs tool, `X-Sidekik-Tool-Secret`) | → mapper |
| POST | `/v1/tools/check_guardrails`, `/get_step`, `/get_expert_moment` | (ElevenLabs tool) | → tutor |
| WS | `/ws/client/:sid?t=sk_token` | in: `turn`, `speech`, `dom`, `agent_event` | §3 |

## 3. Inbound WebSocket (from the room or agent-host page)

| Message | Handling |
|---|---|
| `turn` | If off-record, store only `[off the record]` and don't publish. Otherwise redact with `redact(text, lang, { analyzerUrl, anonymizerUrl, keep: [supplier of the record on screen] })` from `@sidekik/contracts` and publish `sk:transcript.turns`. It fails closed: if Presidio errors, don't publish the turn. Presidio NER redacts PERSON only (suppliers, places and dates are business data); `keep` stops spaCy from tagging the supplier as a person. |
| `speech` | Publish `sk:speech.signals`. |
| `dom` | Publish `sk:dom.events`. |
| `agent_event` | Status and tool-call telemetry; log only. |

**Latency budget:** under 150 ms from receiving a turn to publishing it, with Presidio running in the private network.

## 4. Off the record (single source of truth)

**Triggers:** the UI toggle, the agent's `mark_off_record` tool, brain D7 (`POST /internal/sessions/:id/off-record`), or the `/off` chat command (via meetbot).

**On (complete within 500 ms):**
1. Set `sessions.off_record = true` and open an `off_record_spans` row.
2. Publish lifecycle `offrecord_on`: perception stops and clears its buffer, and brain freezes.
3. Broadcast the `offrecord` command to the page: mute the mic and stop frames.
4. Drop all other agent commands until it's turned off again.

**Retroactive:** `POST /v1/sessions/:id/off-record {on:true, back_s:60}` also deletes `transcript_turns`, `screen_events`, `keyframes` and `questions` from the last 60 s (calling each owner's internal delete endpoint, or deleting directly with a documented exception). Do this as a single transaction per table.

## 5. Phases

| Trigger | What the gateway does |
|---|---|
| `task_done` (from the UI) | Phase becomes `building`; lifecycle `task_done` is published. Mapper builds the draft. |
| Mapper calls `POST /internal/sessions/:id/phase {phase:"debrief", dynamic_variables}` | Gateway gets a voice token with the debrief override, sets phase `debrief`, broadcasts the `phase` command (new token) to the page, and publishes lifecycle `phase_changed` |
| Mapper calls `.../phase {phase:"confirmed"}` | Phase becomes `confirmed`; the UI shows "Work Map ready" |

## 6. Internal endpoints

- `POST /internal/sessions/:id/phase`
- `POST /internal/sessions/:id/off-record`
- `POST /internal/redact {text, lang?, keep?}` → `{text}` (used by voice for webhook turns). Fails closed: **503 `redaction_unavailable`** when Presidio fails; the caller must not keep or forward the text.
- `POST /internal/agent-host-token {sid}` → `{t}`

All of these require `X-Internal-Token`.

## 7. Bus consumers

| Stream | Handling |
|---|---|
| `sk:agent.commands` | Off-record filter, then a debounce: at most 1 spoken command (`ask`, `followup`, `predict`) per 8 s per session, except `intervene` and `teachback`. Then `supabase.channel('session:'+sid).send({type:'broadcast', event:'cmd', payload})`. |
| `sk:usage` | Insert into `cost_ledger`. |
| All streams | Append to `replay_events(session_id, stream, envelope)` for replay mode. |

## 8. Replay mode

`POST /v1/replay/:sid` creates a new session with `mode:"replay"`. It then re-publishes every recorded envelope for the original session onto the bus with its original timing ×`speed`, **including the recorded `agent.commands`**. The page renders the replayed commands.

All other services must **ignore events for any session whose lifecycle `started` had `mode:"replay"`**, so they don't make vision, Jev or LLM calls a second time. The demo still works when vendors throttle.

## 9. Env

`PORT, REDIS_URL, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SK_SESSION_SECRET, SK_INTERNAL_TOKEN, SK_TOOL_SECRET, PRESIDIO_ANALYZER_URL, PRESIDIO_ANONYMIZER_URL, VOICE_URL, MEETBOT_URL, MAPPER_URL, TUTOR_URL, BRAIN_URL, CORS_ORIGIN=https://app.sidekik.live`

## 10. Claude Code tickets

1. Scaffold: Fastify, CORS, Supabase JWT auth, zod request validation, `/healthz`.
2. Sessions, consent and `sk_token` minting; voice token call; lifecycle publishing.
3. `/ws/client`: turn redaction pipeline and publishing.
4. Egress consumer: off-record filter, debounce, Realtime broadcast.
5. Off-record: all triggers, spans, retroactive delete.
6. Phase API (public + internal).
7. Proxies: presave, tools, workmap publish/export, meeting bot, agent-host claim.
8. Cost ledger and `GET /v1/costs/:sid` with the counterfactual sum.
9. Replay recorder and replayer.
10. Rate limiting (per user, 20 req/s) and structured logging.

## 11. Definition of done

- **Checkpoint 1:** a session starts from the web app, turns appear redacted on the bus, and an `ask` command reaches the page within 200 ms of being published.
- **Off-record:** the badge shows in under 500 ms and no further commands or events arrive until it's turned off.
