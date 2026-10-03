import { beforeEach, describe, expect, it } from 'vitest';
import { STREAMS } from '../src/contracts/index.js';
import { createOffRecordController, OffRecordState } from '../src/services/off-record.js';
import type { SessionRow } from '../src/store/types.js';
import { IDS, fakeBroadcaster, fakeBus, memoryStore } from './fakes/index.js';

const SID = '60000000-0000-4000-8000-000000000001';
const STARTED = Date.parse('2026-10-03T10:00:00.000Z');

const session = (over: Partial<SessionRow> = {}): SessionRow => ({
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
  consent_at: new Date(STARTED).toISOString(),
  started_at: new Date(STARTED).toISOString(),
  ended_at: null,
  ...over,
});

const log = { info: () => {}, error: () => {} };

let clock: number;
let store: ReturnType<typeof memoryStore>;
let bus: ReturnType<typeof fakeBus>;
let broadcaster: ReturnType<typeof fakeBroadcaster>;
let state: OffRecordState;
let scheduled: { fn: () => void; ms: number }[];
let controller: ReturnType<typeof createOffRecordController>;

beforeEach(() => {
  clock = STARTED + 120_000; // two minutes into the session
  store = memoryStore({ sessions: [session()] });
  bus = fakeBus();
  broadcaster = fakeBroadcaster();
  state = new OffRecordState();
  scheduled = [];
  controller = createOffRecordController({
    store,
    bus,
    broadcaster,
    state,
    now: () => clock,
    schedule: (fn, ms) => scheduled.push({ fn, ms }),
  });
});

const row = () => store.data.sessions[0]!;
const lifecycleEvents = () => bus.published.map((p) => (p.ev.data as { event: string }).event);
const pageCommands = () => broadcaster.sent.map((s) => s.cmd);

describe('off-record on', () => {
  it('switches state, tells the page, persists a span and publishes offrecord_on', async () => {
    const res = await controller.set(session(), { on: true, source: 'ui' }, log);

    expect(res).toEqual({ session_id: SID, off_record: true, changed: true });
    expect(state.isOn(SID)).toBe(true);
    expect(pageCommands()).toEqual([{ type: 'offrecord', on: true }]);
    expect(row().off_record).toBe(true);
    expect(store.data.spans).toEqual([{ session_id: SID, start_t_ms: 120_000, end_t_ms: null, source: 'ui' }]);
    expect(lifecycleEvents()).toEqual(['offrecord_on']);
    expect(bus.published[0]!).toMatchObject({ stream: STREAMS.lifecycle, ev: { session_id: SID, t_ms: 120_000 } });
  });

  it('is idempotent but re-sends the page command', async () => {
    await controller.set(session(), { on: true, source: 'ui' }, log);
    const again = await controller.set(session({ off_record: true }), { on: true, source: 'agent' }, log);

    expect(again.changed).toBe(false);
    expect(store.data.spans).toHaveLength(1);
    expect(lifecycleEvents()).toEqual(['offrecord_on']);
    expect(pageCommands()).toEqual([
      { type: 'offrecord', on: true },
      { type: 'offrecord', on: true },
    ]);
  });

  it('keeps dropping and still saves when the page broadcast fails', async () => {
    broadcaster.fail = new Error('realtime down');
    await expect(controller.set(session(), { on: true, source: 'brain' }, log)).rejects.toThrow('realtime down');
    expect(state.isOn(SID)).toBe(true);
    expect(row().off_record).toBe(true);
    expect(lifecycleEvents()).toEqual(['offrecord_on']);

    broadcaster.fail = undefined;
    const retry = await controller.set(session(), { on: true, source: 'brain' }, log);
    expect(retry.changed).toBe(false);
    expect(pageCommands()).toEqual([{ type: 'offrecord', on: true }]);
  });

  it('saves on retry when the database write failed', async () => {
    const setOffRecord = store.setOffRecord;
    store.setOffRecord = async () => {
      throw new Error('db down');
    };
    await expect(controller.set(session(), { on: true, source: 'ui' }, log)).rejects.toThrow('db down');
    expect(state.isOn(SID)).toBe(true);
    expect(row().off_record).toBe(false);

    store.setOffRecord = setOffRecord;
    await controller.set(session(), { on: true, source: 'ui' }, log);
    expect(row().off_record).toBe(true);
    expect(lifecycleEvents()).toEqual(['offrecord_on']);
  });
});

describe('off-record off', () => {
  it('closes the span, tells the page and publishes offrecord_off', async () => {
    await controller.set(session(), { on: true, source: 'ui' }, log);
    clock += 30_000;
    const res = await controller.set(session({ off_record: true }), { on: false, source: 'ui' }, log);

    expect(res).toEqual({ session_id: SID, off_record: false, changed: true });
    expect(state.isOn(SID)).toBe(false);
    expect(row().off_record).toBe(false);
    expect(store.data.spans).toEqual([{ session_id: SID, start_t_ms: 120_000, end_t_ms: 150_000, source: 'ui' }]);
    expect(lifecycleEvents()).toEqual(['offrecord_on', 'offrecord_off']);
    expect(pageCommands().at(-1)).toEqual({ type: 'offrecord', on: false });
  });

  it('uses the database row when this process has not seen the session', async () => {
    store.data.sessions[0]!.off_record = true;
    const res = await controller.set(session({ off_record: true }), { on: false, source: 'chat' }, log);
    expect(res.changed).toBe(true);
    expect(lifecycleEvents()).toEqual(['offrecord_off']);
  });

  it('runs concurrent toggles in arrival order', async () => {
    await Promise.all([
      controller.set(session(), { on: true, source: 'ui' }, log),
      controller.set(session(), { on: false, source: 'ui' }, log),
      controller.set(session(), { on: true, source: 'agent' }, log),
    ]);
    expect(lifecycleEvents()).toEqual(['offrecord_on', 'offrecord_off', 'offrecord_on']);
    expect(state.isOn(SID)).toBe(true);
    expect(row().off_record).toBe(true);
  });
});

describe('retroactive off-record (back_s)', () => {
  beforeEach(() => {
    const at = (t_ms: number, extra: object = {}) => ({ session_id: SID, t_ms, ...extra });
    store.data.capture = {
      transcript_turns: [at(30_000), at(70_000), at(110_000)],
      screen_events: [at(50_000), at(65_000)],
      keyframes: [
        at(40_000, { storage_path: `org/${IDS.org}/sessions/${SID}/keyframes/40000.webp` }),
        at(90_000, { storage_path: `org/${IDS.org}/sessions/${SID}/keyframes/90000.webp` }),
      ],
      questions: [at(100_000), { session_id: 'another-session', t_ms: 100_000 }],
    };
  });

  it('deletes the last back_s seconds of capture data and records a retroactive span', async () => {
    const res = await controller.set(session(), { on: true, source: 'ui', back_s: 60 }, log);

    expect(res.deleted).toEqual({ transcript_turns: 2, screen_events: 1, keyframes: 1, questions: 1, replay_events: 0 });
    expect(store.data.capture.transcript_turns.map((r) => r.t_ms)).toEqual([30_000]);
    expect(store.data.capture.screen_events.map((r) => r.t_ms)).toEqual([50_000]);
    expect(store.data.capture.questions).toEqual([{ session_id: 'another-session', t_ms: 100_000 }]);
    expect(store.data.removedObjects).toEqual([`org/${IDS.org}/sessions/${SID}/keyframes/90000.webp`]);
    expect(store.data.spans).toEqual(
      expect.arrayContaining([
        { session_id: SID, start_t_ms: 120_000, end_t_ms: null, source: 'ui' },
        { session_id: SID, start_t_ms: 60_000, end_t_ms: 120_000, source: 'retroactive' },
      ]),
    );
  });

  it('purges again later to catch rows saved after the switch', async () => {
    await controller.set(session(), { on: true, source: 'ui', back_s: 60 }, log);
    expect(scheduled).toHaveLength(1);
    expect(scheduled[0]!.ms).toBe(5000);

    // Voice persisted a turn that was published just before off-record.
    store.data.capture.transcript_turns.push({ session_id: SID, t_ms: 119_500 });
    scheduled[0]!.fn();
    await new Promise((r) => setTimeout(r, 0));
    expect(store.data.capture.transcript_turns.map((r) => r.t_ms)).toEqual([30_000]);
  });

  it('applies back_s even when already off the record', async () => {
    await controller.set(session(), { on: true, source: 'ui' }, log);
    const res = await controller.set(session({ off_record: true }), { on: true, source: 'ui', back_s: 30 }, log);
    expect(res.changed).toBe(false);
    // Cutoff 90 000 ms: the keyframe at exactly 90 000 ms is inside the window.
    expect(res.deleted).toEqual({ transcript_turns: 1, screen_events: 0, keyframes: 1, questions: 1, replay_events: 0 });
  });

  it('clamps the window at the session start', async () => {
    const res = await controller.set(session(), { on: true, source: 'ui', back_s: 300 }, log);
    expect(Object.values(res.deleted!).reduce((a, b) => a + b, 0)).toBe(8);
    expect(store.data.spans).toContainEqual({ session_id: SID, start_t_ms: 0, end_t_ms: 120_000, source: 'retroactive' });
  });
});
