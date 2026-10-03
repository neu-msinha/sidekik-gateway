import { beforeEach, describe, expect, it, vi } from 'vitest';
import { makeEvent, signSessionToken, STREAMS, type AgentCommand } from '../src/contracts/index.js';
import { OffRecordState } from '../src/services/off-record.js';
import type { SessionRow } from '../src/store/types.js';
import { IDS, fakeBroadcaster, fakeBus, memoryStore } from './fakes/index.js';
import { SECRETS, TEST_USER, VALID_JWT, buildTestApp } from './helpers.js';

const SID = '60000000-0000-4000-8000-000000000001';

const sessionRow = (): SessionRow => ({
  id: SID,
  org_id: IDS.org,
  workflow_id: IDS.workflow,
  kind: 'capture',
  mode: 'browser',
  phase: 'capture',
  expert_id: null,
  learner_id: null,
  workmap_id: null,
  language: 'de',
  el_agent_id: null,
  off_record: false,
  consent_at: new Date().toISOString(),
  started_at: new Date(Date.now() - 90_000).toISOString(),
  ended_at: null,
});

let store: ReturnType<typeof memoryStore>;
let bus: ReturnType<typeof fakeBus>;
let broadcaster: ReturnType<typeof fakeBroadcaster>;
let offRecord: OffRecordState;

beforeEach(() => {
  store = memoryStore({
    sessions: [sessionRow()],
    members: [
      { org_id: IDS.org, user_id: TEST_USER.id, role: 'expert' },
    ],
  });
  bus = fakeBus();
  broadcaster = fakeBroadcaster();
  offRecord = new OffRecordState();
});

async function app() {
  const a = await buildTestApp({ store, bus, broadcaster, offRecord });
  await a.ready();
  return a;
}

const user = { authorization: `Bearer ${VALID_JWT}` };
const internal = { 'x-internal-token': SECRETS.internal };

describe('POST /v1/sessions/:id/off-record', () => {
  const call = async (payload: object, headers: Record<string, string> = user, sid = SID) =>
    (await app()).inject({ method: 'POST', url: `/v1/sessions/${sid}/off-record`, headers, payload });

  it('switches off the record with source ui by default', async () => {
    const res = await call({ on: true });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ session_id: SID, off_record: true, changed: true });
    expect(store.data.spans).toEqual([expect.objectContaining({ source: 'ui', end_t_ms: null })]);
  });

  it('accepts the agent tool as a source', async () => {
    await call({ on: true, source: 'agent' });
    expect(store.data.spans[0]!.source).toBe('agent');
  });

  it('rejects sources reserved for services', async () => {
    expect((await call({ on: true, source: 'brain' })).statusCode).toBe(400);
  });

  it('rejects back_s when switching back on the record', async () => {
    const res = await call({ on: false, back_s: 60 });
    expect(res.statusCode).toBe(400);
    expect(res.json().issues[0].path).toBe('/back_s');
  });

  it('returns deletion counts for a retroactive request', async () => {
    store.data.capture.transcript_turns.push({ session_id: SID, t_ms: 80_000 }, { session_id: SID, t_ms: 10_000 });
    const res = await call({ on: true, back_s: 60 });
    expect(res.json().deleted).toEqual({ transcript_turns: 1, screen_events: 0, keyframes: 0, questions: 0 });
  });

  it('requires a user in the session org', async () => {
    expect((await call({ on: true }, {})).statusCode).toBe(401);
    store.data.members = [];
    expect((await call({ on: true })).statusCode).toBe(404);
    expect(offRecord.isOn(SID)).toBe(false);
  });

  it('returns 409 for an ended session', async () => {
    store.data.sessions[0]!.ended_at = new Date().toISOString();
    expect((await call({ on: true })).statusCode).toBe(409);
  });
});

describe('POST /internal/sessions/:id/off-record', () => {
  const call = async (payload: object, headers: Record<string, string> = internal, sid = SID) =>
    (await app()).inject({ method: 'POST', url: `/internal/sessions/${sid}/off-record`, headers, payload });

  it('lets brain switch off the record (D7)', async () => {
    const res = await call({ on: true });
    expect(res.statusCode).toBe(200);
    expect(store.data.spans[0]!.source).toBe('brain');
  });

  it('lets meetbot use the chat command', async () => {
    await call({ on: true, source: 'chat' });
    await call({ on: false, source: 'chat' });
    expect(store.data.spans).toEqual([expect.objectContaining({ source: 'chat', end_t_ms: expect.any(Number) })]);
  });

  it('requires X-Internal-Token', async () => {
    expect((await call({ on: true }, {})).statusCode).toBe(401);
    expect((await call({ on: true }, user)).statusCode).toBe(401);
  });

  it('returns 404 for an unknown session', async () => {
    expect((await call({ on: true }, internal, '60000000-0000-4000-8000-0000000000ff')).statusCode).toBe(404);
  });
});

describe('off the record, end to end', () => {
  const command = (data: AgentCommand) =>
    makeEvent({ type: 'agent.command', org_id: IDS.org, session_id: SID, t_ms: 0, producer: 'brain', data });

  it('sends no command or event after offrecord_on until it is switched off', async () => {
    const a = await app();
    const t = await signSessionToken({ sid: SID, org: IDS.org, role: 'expert', kind: 'capture' }, SECRETS.session);
    const ws = await a.injectWS(`/ws/client/${SID}?t=${t}`);

    await bus.deliver(STREAMS.commands, command({ type: 'ctx', text: 'before' }));
    await a.inject({ method: 'POST', url: `/v1/sessions/${SID}/off-record`, headers: user, payload: { on: true } });

    await bus.deliver(STREAMS.commands, command({ type: 'ask', question_id: 'q', text: 'Why?', qtype: 'why' }));
    await bus.deliver(STREAMS.commands, command({ type: 'intervene', guardrail_id: 'g', step_id: 's', text: 'Stop' }));
    ws.send(JSON.stringify({ type: 'turn', role: 'user', text: 'private' }));
    ws.send(JSON.stringify({ type: 'speech', kind: 'user_speech_start' }));
    await new Promise((r) => setTimeout(r, 50));

    expect(broadcaster.sent.map((s) => s.cmd)).toEqual([
      { type: 'ctx', text: 'before' },
      { type: 'offrecord', on: true },
    ]);
    expect(bus.published.map((p) => p.stream)).toEqual([STREAMS.lifecycle]);

    await a.inject({ method: 'POST', url: `/v1/sessions/${SID}/off-record`, headers: user, payload: { on: false } });
    await bus.deliver(STREAMS.commands, command({ type: 'ctx', text: 'after' }));
    ws.send(JSON.stringify({ type: 'speech', kind: 'user_speech_end' }));

    await vi.waitFor(() => expect(bus.published.map((p) => p.stream)).toContain(STREAMS.speech));
    expect(broadcaster.sent.map((s) => s.cmd).slice(2)).toEqual([
      { type: 'offrecord', on: false },
      { type: 'ctx', text: 'after' },
    ]);
    ws.terminate();
  });

  it('closes the open span when the session ends', async () => {
    const a = await app();
    await a.inject({ method: 'POST', url: `/v1/sessions/${SID}/off-record`, headers: user, payload: { on: true } });
    await a.inject({ method: 'POST', url: `/v1/sessions/${SID}/end`, headers: user });
    expect(store.data.spans[0]!.end_t_ms).toEqual(expect.any(Number));
  });
});
