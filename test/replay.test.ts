import { beforeEach, describe, expect, it, vi } from 'vitest';
import { makeEvent, STREAMS, type AgentCommand, type Envelope, type StreamKey } from '../src/contracts/index.js';
import { OffRecordState } from '../src/services/off-record.js';
import { createReplay } from '../src/services/replay.js';
import type { SessionRow } from '../src/store/types.js';
import { IDS, fakeBroadcaster, fakeBus, memoryStore } from './fakes/index.js';
import { TEST_USER, VALID_JWT, buildTestApp } from './helpers.js';

const SID = '60000000-0000-4000-8000-000000000001';
const quiet = { info: () => {}, error: () => {}, warn: () => {} };

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
  el_agent_id: null,
  off_record: false,
  consent_at: '2026-10-03T10:00:00.000Z',
  started_at: '2026-10-03T10:00:00.000Z',
  ended_at: null,
  ...over,
});

const event = (type: string, t_ms: number, data: unknown, session_id = SID) =>
  makeEvent({ type, org_id: IDS.org, session_id, t_ms, producer: 'gateway', data });
const lifecycle = (ev: string, t_ms: number) =>
  event('session.lifecycle', t_ms, {
    event: ev,
    kind: 'capture',
    phase: 'capture',
    workflow_id: IDS.workflow,
    mode: 'browser',
    language: 'de',
  });
const ask = (t_ms: number, text: string): Envelope<AgentCommand> =>
  event('agent.command', t_ms, { type: 'ask', question_id: text, text, qtype: 'why' }) as Envelope<AgentCommand>;

describe('replay recorder', () => {
  let store: ReturnType<typeof memoryStore>;
  let offRecord: OffRecordState;
  let replay: ReturnType<typeof createReplay>;

  beforeEach(() => {
    store = memoryStore({ sessions: [sessionRow()] });
    offRecord = new OffRecordState();
    replay = createReplay({ store, bus: fakeBus(), offRecord, log: quiet });
  });

  it('records an event once, keyed by stream and event id', async () => {
    const ev = event('transcript.turn', 1200, { text: 'hi' });
    expect(await replay.record(STREAMS.turns, ev)).toBe(true);
    expect(await replay.record(STREAMS.turns, ev)).toBe(false);
    expect(store.data.replayEvents).toEqual([
      expect.objectContaining({ session_id: SID, org_id: IDS.org, stream: STREAMS.turns, t_ms: 1200, envelope: ev }),
    ]);
  });

  it('skips unknown sessions, replay sessions and off-record time', async () => {
    expect(await replay.record(STREAMS.turns, event('t', 0, {}, 'fixture-session'))).toBe(false);
    expect(await replay.record(STREAMS.turns, event('t', 0, {}, '60000000-0000-4000-8000-0000000000ff'))).toBe(false);

    const replaySid = '60000000-0000-4000-8000-000000000009';
    store.data.sessions.push(sessionRow({ id: replaySid, mode: 'replay' }));
    expect(await replay.record(STREAMS.turns, event('t', 0, {}, replaySid))).toBe(false);

    offRecord.set(SID, true);
    expect(await replay.record(STREAMS.turns, event('t', 0, {}))).toBe(false);
    expect(store.data.replayEvents).toHaveLength(0);
  });
});

describe('replayer', () => {
  let store: ReturnType<typeof memoryStore>;
  let bus: ReturnType<typeof fakeBus>;
  let timers: { fn: () => void; ms: number; cancelled: boolean }[];
  let finished: SessionRow[];
  let replay: ReturnType<typeof createReplay>;

  beforeEach(async () => {
    store = memoryStore({ sessions: [sessionRow()] });
    bus = fakeBus();
    timers = [];
    finished = [];
    replay = createReplay({
      store,
      bus,
      offRecord: new OffRecordState(),
      log: quiet,
      schedule: (fn, ms) => {
        const t = { fn, ms, cancelled: false };
        timers.push(t);
        return () => (t.cancelled = true);
      },
      onFinished: async (s) => void finished.push(s),
    });
    const recordings: [StreamKey, Envelope<unknown>][] = [
      [STREAMS.lifecycle, lifecycle('started', 0)],
      [STREAMS.turns, event('transcript.turn', 2000, { text: 'Warum 0400?' })],
      [STREAMS.commands, ask(4000, 'q1')],
      [STREAMS.lifecycle, lifecycle('task_done', 6000)],
    ];
    for (const [stream, ev] of recordings) await replay.record(stream, ev);
  });

  const runAll = async () => {
    for (const t of [...timers].sort((a, b) => a.ms - b.ms)) if (!t.cancelled) t.fn();
    await vi.waitFor(() => expect(finished).toHaveLength(1));
  };

  it('creates a replay session and schedules events at t_ms ÷ speed', async () => {
    const started = await replay.start(sessionRow(), 2);
    const rs = started.session;
    expect(rs).toMatchObject({ mode: 'replay', kind: 'capture', org_id: IDS.org, consent_at: '2026-10-03T10:00:00.000Z' });
    expect(rs.id).not.toBe(SID);
    expect(started).toMatchObject({ events: 3, duration_ms: 3000 });
    expect(timers.map((t) => t.ms)).toEqual([1000, 2000, 3000, 3001]);

    // The replay session's own `started` goes out immediately, flagged as a replay.
    expect(bus.published).toHaveLength(1);
    expect(bus.published[0]!.ev).toMatchObject({ session_id: rs.id, data: { event: 'started', mode: 'replay' } });
  });

  it('re-publishes the recording under the replay session, in order, then ends it', async () => {
    const { session: rs } = await replay.start(sessionRow(), 1);
    await runAll();

    const out = bus.published.slice(1);
    expect(out.map((p) => p.stream)).toEqual([STREAMS.turns, STREAMS.commands, STREAMS.lifecycle, STREAMS.lifecycle]);
    expect(out.every((p) => p.ev.session_id === rs.id)).toBe(true);
    expect(out[0]!.ev).toMatchObject({ type: 'transcript.turn', t_ms: 2000, data: { text: 'Warum 0400?' } });
    expect(out[0]!.ev.id).not.toBe(store.data.replayEvents[1]!.envelope.id);
    expect(out[2]!.ev.data).toMatchObject({ event: 'task_done', mode: 'replay' });
    expect(out[3]!.ev.data).toMatchObject({ event: 'ended', mode: 'replay' });

    expect(store.data.sessions.find((s) => s.id === rs.id)!.ended_at).not.toBeNull();
    expect(finished.map((s) => s.id)).toEqual([rs.id]);
    expect(replay.isRunning(rs.id)).toBe(false);
  });

  it('refuses a session with nothing recorded, and a replay of a replay', async () => {
    store.data.replayEvents = [];
    await expect(replay.start(sessionRow(), 1)).rejects.toMatchObject({ statusCode: 409, code: 'nothing_to_replay' });
    await expect(replay.start(sessionRow({ mode: 'replay' }), 1)).rejects.toMatchObject({ code: 'is_replay' });
  });

  it('cancels scheduled publishes on stopAll', async () => {
    const { session: rs } = await replay.start(sessionRow(), 1);
    replay.stopAll();
    expect(timers.every((t) => t.cancelled)).toBe(true);
    expect(replay.isRunning(rs.id)).toBe(false);
  });
});

describe('replay end to end', () => {
  let store: ReturnType<typeof memoryStore>;
  let bus: ReturnType<typeof fakeBus>;
  let broadcaster: ReturnType<typeof fakeBroadcaster>;
  const user = { authorization: `Bearer ${VALID_JWT}` };

  beforeEach(() => {
    store = memoryStore({
      sessions: [sessionRow({ started_at: new Date().toISOString() })],
      members: [{ org_id: IDS.org, user_id: TEST_USER.id, role: 'expert' }],
    });
    bus = fakeBus();
    broadcaster = fakeBroadcaster();
  });

  async function app() {
    const a = await buildTestApp({ store, bus, broadcaster });
    await a.ready();
    return a;
  }

  it('records what the page received and replays it without the debounce', async () => {
    const a = await app();
    await bus.deliver(STREAMS.lifecycle, lifecycle('started', 0));
    await bus.deliver(STREAMS.turns, event('transcript.turn', 1000, { text: 'turn' }));
    await bus.deliver(STREAMS.commands, ask(1500, 'sent'));
    await bus.deliver(STREAMS.commands, ask(2000, 'debounced')); // < 8 s after the first ask, by wall clock

    // Only what reached the page is recorded.
    const texts = () =>
      store.data.replayEvents
        .filter((r) => r.stream === STREAMS.commands)
        .map((r) => (r.envelope.data as { text: string }).text);
    expect(texts()).toEqual(['sent']);

    // An ask that reached the page 8.1 s later in the original session.
    const later = ask(9600, 'sent-later');
    await store.insertReplayEvent({
      id: 'later',
      org_id: IDS.org,
      session_id: SID,
      stream: STREAMS.commands,
      t_ms: 9600,
      envelope: later,
    });

    // Replay at 10×: both asks land 810 ms apart, inside the 8 s window, and both still reach the page.
    bus.loopback = true;
    broadcaster.sent.length = 0;
    const res = await a.inject({ method: 'POST', url: `/v1/replay/${SID}`, headers: user, payload: { speed: 10 } });
    expect(res.statusCode).toBe(202);
    const body = res.json();
    expect(body).toMatchObject({ replay_of: SID, speed: 10, events: 3, duration_ms: 960 });

    await vi.waitFor(() => expect(broadcaster.sent).toHaveLength(2), { timeout: 3000 });
    expect(broadcaster.sent.map((s) => [s.sessionId, (s.cmd as { text: string }).text])).toEqual([
      [body.session_id, 'sent'],
      [body.session_id, 'sent-later'],
    ]);
    // Replayed events are never recorded again.
    expect(store.data.replayEvents.every((r) => r.session_id === SID)).toBe(true);
    await vi.waitFor(() => expect(store.data.sessions.find((s) => s.id === body.session_id)!.ended_at).not.toBeNull());
    await a.close();
  });

  it('does not record commands dropped while off the record', async () => {
    const a = await app();
    await a.inject({ method: 'POST', url: `/v1/sessions/${SID}/off-record`, headers: user, payload: { on: true } });
    await bus.deliver(STREAMS.commands, ask(1000, 'while off'));
    await bus.deliver(STREAMS.turns, event('transcript.turn', 1100, { text: 'from another producer' }));
    expect(store.data.replayEvents.filter((r) => r.stream !== STREAMS.lifecycle)).toHaveLength(0);
  });

  it('purges the recording on a retroactive off-record request', async () => {
    store.data.sessions[0]!.started_at = new Date(Date.now() - 120_000).toISOString();
    const a = await app();
    await bus.deliver(STREAMS.turns, event('transcript.turn', 10_000, { text: 'kept' }));
    await bus.deliver(STREAMS.turns, event('transcript.turn', 110_000, { text: 'purged' }));
    const res = await a.inject({
      method: 'POST',
      url: `/v1/sessions/${SID}/off-record`,
      headers: user,
      payload: { on: true, back_s: 30 },
    });
    expect(res.json().deleted.replay_events).toBe(1);
    expect(store.data.replayEvents.map((r) => (r.envelope.data as { text?: string }).text)).toEqual(['kept']);
  });

  it('checks the caller', async () => {
    const a = await app();
    expect((await a.inject({ method: 'POST', url: `/v1/replay/${SID}`, payload: {} })).statusCode).toBe(401);
    store.data.members[0]!.role = 'learner';
    expect((await a.inject({ method: 'POST', url: `/v1/replay/${SID}`, headers: user, payload: {} })).statusCode).toBe(403);
    store.data.members = [];
    expect((await a.inject({ method: 'POST', url: `/v1/replay/${SID}`, headers: user, payload: {} })).statusCode).toBe(404);
  });

  it('returns 409 when nothing was recorded and 400 for an out-of-range speed', async () => {
    const a = await app();
    expect((await a.inject({ method: 'POST', url: `/v1/replay/${SID}`, headers: user, payload: {} })).statusCode).toBe(409);
    expect((await a.inject({ method: 'POST', url: `/v1/replay/${SID}`, headers: user, payload: { speed: 50 } })).statusCode).toBe(400);
  });
});
