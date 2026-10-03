import { beforeEach, describe, expect, it } from 'vitest';
import { STREAMS } from '../src/contracts/index.js';
import { HttpError } from '../src/errors.js';
import { OffRecordState } from '../src/services/off-record.js';
import type { SessionRow } from '../src/store/types.js';
import { IDS, fakeBroadcaster, fakeBus, fakeVoice, memoryStore } from './fakes/index.js';
import { SECRETS, TEST_USER, VALID_JWT, buildTestApp } from './helpers.js';

const SID = '60000000-0000-4000-8000-000000000001';

const sessionRow = (over: Partial<SessionRow> = {}): SessionRow => ({
  id: SID,
  org_id: IDS.org,
  workflow_id: IDS.workflow,
  kind: 'capture',
  mode: 'browser',
  phase: 'capture',
  expert_id: IDS.expert,
  learner_id: null,
  workmap_id: null,
  language: 'de',
  el_agent_id: 'agent-interviewer',
  off_record: false,
  consent_at: new Date().toISOString(),
  started_at: new Date(Date.now() - 600_000).toISOString(),
  ended_at: null,
  ...over,
});

let store: ReturnType<typeof memoryStore>;
let bus: ReturnType<typeof fakeBus>;
let broadcaster: ReturnType<typeof fakeBroadcaster>;
let voice: ReturnType<typeof fakeVoice>;
let offRecord: OffRecordState;

beforeEach(() => {
  store = memoryStore({
    sessions: [sessionRow()],
    workflows: [{ id: IDS.workflow, org_id: IDS.org, name: 'Supplier invoice coding', current_workmap_id: null }],
    experts: [{ id: IDS.expert, org_id: IDS.org, user_id: TEST_USER.id, display_name: 'Sabine' }],
    members: [{ org_id: IDS.org, user_id: TEST_USER.id, role: 'expert' }],
  });
  bus = fakeBus();
  broadcaster = fakeBroadcaster();
  voice = fakeVoice();
  offRecord = new OffRecordState();
});

async function app() {
  const a = await buildTestApp({ store, bus, broadcaster, voice, offRecord });
  await a.ready();
  return a;
}

const setPhase = (phase: SessionRow['phase']) => (store.data.sessions[0]!.phase = phase);
const lifecycle = () =>
  bus.published
    .filter((p) => p.stream === STREAMS.lifecycle)
    .map((p) => ({ event: (p.ev.data as { event: string }).event, phase: (p.ev.data as { phase: string }).phase }));

async function taskDone(payload: object = { event: 'task_done' }, headers: Record<string, string> = { authorization: `Bearer ${VALID_JWT}` }) {
  return (await app()).inject({ method: 'POST', url: `/v1/sessions/${SID}/phase`, headers, payload });
}

async function mapperPhase(payload: object, headers: Record<string, string> = { 'x-internal-token': SECRETS.internal }, sid = SID) {
  return (await app()).inject({ method: 'POST', url: `/internal/sessions/${sid}/phase`, headers, payload });
}

describe('POST /v1/sessions/:id/phase (task_done)', () => {
  it('moves capture to building and publishes task_done', async () => {
    const res = await taskDone();
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ session_id: SID, phase: 'building', changed: true });
    expect(store.data.sessions[0]!.phase).toBe('building');
    expect(lifecycle()).toEqual([{ event: 'task_done', phase: 'building' }]);
  });

  it('is a no-op when already building', async () => {
    await taskDone();
    const again = await taskDone();
    expect(again.json()).toEqual({ session_id: SID, phase: 'building', changed: false });
    expect(lifecycle()).toHaveLength(1);
  });

  it('returns 409 once the debrief has started', async () => {
    setPhase('debrief');
    const res = await taskDone();
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('invalid_phase');
  });

  it('returns 409 for a tutor session', async () => {
    store.data.sessions[0] = sessionRow({ kind: 'tutor', phase: 'tutoring' });
    expect((await taskDone()).statusCode).toBe(409);
  });

  it('returns 409 for an ended session', async () => {
    store.data.sessions[0]!.ended_at = new Date().toISOString();
    expect((await taskDone()).statusCode).toBe(409);
  });

  it('validates the event and the caller', async () => {
    expect((await taskDone({ event: 'debrief' })).statusCode).toBe(400);
    expect((await taskDone({ event: 'task_done' }, {})).statusCode).toBe(401);
    store.data.members = [];
    expect((await taskDone()).statusCode).toBe(404);
  });
});

describe('POST /internal/sessions/:id/phase (debrief)', () => {
  beforeEach(() => setPhase('building'));

  it('gets a debrief token, moves to debrief and sends the phase command', async () => {
    const res = await mapperPhase({ phase: 'debrief', dynamic_variables: { open_items: '3', expert_name: 'Sabine K.' } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ session_id: SID, phase: 'debrief', changed: true, delivered: true });

    const dynamic_variables = {
      session_id: SID,
      language: 'de',
      workflow_name: 'Supplier invoice coding',
      expert_name: 'Sabine K.',
      open_items: '3',
    };
    expect(voice.calls).toEqual([
      { agent: 'interviewer', phase: 'debrief', session_id: SID, dynamic_variables, language: 'de' },
    ]);
    expect(store.data.sessions[0]!.phase).toBe('debrief');
    expect(lifecycle()).toEqual([{ event: 'phase_changed', phase: 'debrief' }]);
    expect(broadcaster.sent).toEqual([
      {
        sessionId: SID,
        cmd: {
          type: 'phase',
          phase: 'debrief',
          conversation_token: 'el-token-interviewer',
          agent_id: 'agent-interviewer',
          dynamic_variables,
        },
      },
    ]);
  });

  it('re-sends the command on a retry without a second lifecycle event', async () => {
    await mapperPhase({ phase: 'debrief' });
    const again = await mapperPhase({ phase: 'debrief' });
    expect(again.json()).toMatchObject({ phase: 'debrief', changed: false, delivered: true });
    expect(broadcaster.sent).toHaveLength(2);
    expect(lifecycle()).toHaveLength(1);
  });

  it('changes nothing when voice fails', async () => {
    voice.fail = new HttpError(504, 'upstream_timeout', '/internal/token timed out after 500 ms');
    const res = await mapperPhase({ phase: 'debrief' });
    expect(res.statusCode).toBe(504);
    expect(store.data.sessions[0]!.phase).toBe('building');
    expect(lifecycle()).toHaveLength(0);
    expect(broadcaster.sent).toHaveLength(0);
  });

  it('returns 409 before task_done', async () => {
    setPhase('capture');
    expect((await mapperPhase({ phase: 'debrief' })).statusCode).toBe(409);
    expect(voice.calls).toHaveLength(0);
  });

  it('holds the command while off the record and sends it with a fresh token afterwards', async () => {
    const internal = { 'x-internal-token': SECRETS.internal };
    const a = await app();
    offRecord.set(SID, true);

    const res = await a.inject({
      method: 'POST',
      url: `/internal/sessions/${SID}/phase`,
      headers: internal,
      payload: { phase: 'debrief' },
    });
    expect(res.json()).toMatchObject({ phase: 'debrief', changed: true, delivered: false });
    expect(broadcaster.sent).toHaveLength(0);

    await a.inject({
      method: 'POST',
      url: `/v1/sessions/${SID}/off-record`,
      headers: { authorization: `Bearer ${VALID_JWT}` },
      payload: { on: false },
    });
    expect(broadcaster.sent.map((s) => s.cmd.type)).toEqual(['offrecord', 'phase']);
    expect(voice.calls).toHaveLength(2);

    // Delivered once: switching off again sends nothing more.
    await a.inject({
      method: 'POST',
      url: `/v1/sessions/${SID}/off-record`,
      headers: { authorization: `Bearer ${VALID_JWT}` },
      payload: { on: false },
    });
    expect(broadcaster.sent.filter((s) => s.cmd.type === 'phase')).toHaveLength(1);
  });
});

describe('POST /internal/sessions/:id/phase (confirmed)', () => {
  it('moves debrief to confirmed', async () => {
    setPhase('debrief');
    const res = await mapperPhase({ phase: 'confirmed' });
    expect(res.json()).toEqual({ session_id: SID, phase: 'confirmed', changed: true });
    expect(store.data.sessions[0]!.phase).toBe('confirmed');
    expect(lifecycle()).toEqual([{ event: 'phase_changed', phase: 'confirmed' }]);

    const again = await mapperPhase({ phase: 'confirmed' });
    expect(again.json().changed).toBe(false);
    expect(lifecycle()).toHaveLength(1);
  });

  it('returns 409 before the debrief', async () => {
    setPhase('building');
    expect((await mapperPhase({ phase: 'confirmed' })).statusCode).toBe(409);
  });
});

describe('internal phase endpoint checks', () => {
  it('requires X-Internal-Token', async () => {
    expect((await mapperPhase({ phase: 'confirmed' }, {})).statusCode).toBe(401);
  });

  it('rejects unknown phases and sessions', async () => {
    expect((await mapperPhase({ phase: 'done' })).statusCode).toBe(400);
    expect((await mapperPhase({ phase: 'confirmed' }, undefined, '60000000-0000-4000-8000-0000000000ff')).statusCode).toBe(404);
  });
});

describe('full capture flow', () => {
  it('capture → building → debrief → confirmed', async () => {
    await taskDone();
    await mapperPhase({ phase: 'debrief' });
    await mapperPhase({ phase: 'confirmed' });
    expect(lifecycle()).toEqual([
      { event: 'task_done', phase: 'building' },
      { event: 'phase_changed', phase: 'debrief' },
      { event: 'phase_changed', phase: 'confirmed' },
    ]);
  });
});
