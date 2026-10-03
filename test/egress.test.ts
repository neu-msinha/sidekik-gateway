import { beforeEach, describe, expect, it } from 'vitest';
import { makeEvent, type AgentCommand, type Envelope } from '../src/contracts/index.js';
import { createEgress, SPOKEN_WINDOW_MS } from '../src/services/egress.js';
import { OffRecordState } from '../src/services/off-record.js';
import type { SessionRow } from '../src/store/types.js';
import { IDS, fakeBroadcaster, memoryStore } from './fakes/index.js';

const SID = '60000000-0000-4000-8000-000000000001';
const SID2 = '60000000-0000-4000-8000-000000000002';

const row = (id: string, off_record = false): SessionRow => ({
  id,
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
  off_record,
  consent_at: new Date().toISOString(),
  started_at: new Date().toISOString(),
  ended_at: null,
});

const COMMANDS: Record<AgentCommand['type'], AgentCommand> = {
  ctx: { type: 'ctx', text: 'Invoice #4471 open, cost center 4711' },
  ask: { type: 'ask', question_id: 'q1', text: 'Why 0400 instead of 4711?', qtype: 'why' },
  followup: { type: 'followup', open_item_id: 'o1', text: 'What about leasing?' },
  teachback: { type: 'teachback', workmap_id: 'w1', script: 'Step 1…' },
  predict: { type: 'predict', step_id: 's4', prompt: 'Which cost center?' },
  intervene: { type: 'intervene', guardrail_id: 'g1', step_id: 's4', text: 'Hold on before you save.', field: 'cost_center' },
  replay: { type: 'replay', step_id: 's4', clip_url: 'https://x/clip.mp4', quote: 'Über 5.000 immer 0400.', label: 'S4' },
  summary: {
    type: 'summary',
    mastery: {
      session_id: SID,
      workmap_id: 'w1',
      learner_id: 'l1',
      steps: [],
      practice_next: [],
      counts: { independent_correct: 0, prompted_correct: 0, corrected_after_intervention: 0, not_attempted: 0 },
    },
  },
  offrecord: { type: 'offrecord', on: true },
  phase: { type: 'phase', phase: 'debrief', conversation_token: 'ct', agent_id: 'ag', dynamic_variables: {} },
};

let clock: number;
let broadcaster: ReturnType<typeof fakeBroadcaster>;
let offRecord: OffRecordState;
let store: ReturnType<typeof memoryStore>;
let logs: string[];
let egress: ReturnType<typeof createEgress>;

beforeEach(() => {
  clock = 1_000_000;
  broadcaster = fakeBroadcaster();
  offRecord = new OffRecordState();
  store = memoryStore({ sessions: [row(SID), row(SID2)] });
  logs = [];
  const log = { info: (_o: object, m: string) => logs.push(m), warn: (_o: object, m: string) => logs.push(m) };
  egress = createEgress({ broadcaster, offRecord, store, log, now: () => clock });
});

const ev = (cmd: AgentCommand, sid = SID): Envelope<AgentCommand> =>
  makeEvent({ type: 'agent.command', org_id: IDS.org, session_id: sid, t_ms: 0, producer: 'brain', data: cmd });

const sentTypes = () => broadcaster.sent.map((s) => s.cmd.type);

describe('egress', () => {
  it('broadcasts an ask to the session', async () => {
    expect(await egress.handle(ev(COMMANDS.ask))).toBe('sent');
    expect(broadcaster.sent).toEqual([{ sessionId: SID, cmd: COMMANDS.ask }]);
  });

  it('broadcasts each event id only once', async () => {
    const e = ev(COMMANDS.ctx);
    await egress.handle(e);
    expect(await egress.handle(e)).toBe('duplicate');
    expect(broadcaster.sent).toHaveLength(1);
  });

  it('drops a command for an unknown session', async () => {
    const unknown = '60000000-0000-4000-8000-0000000000ff';
    expect(await egress.handle(ev(COMMANDS.ask, unknown))).toBe('unknown_session');
    expect(broadcaster.sent).toHaveLength(0);
  });
});

describe('egress off the record', () => {
  it('sends no command except offrecord after offrecord_on', async () => {
    offRecord.set(SID, true);
    for (const cmd of Object.values(COMMANDS)) await egress.handle(ev(cmd));
    expect(sentTypes()).toEqual(['offrecord']);
  });

  it('resumes once off-record is switched off', async () => {
    offRecord.set(SID, true);
    expect(await egress.handle(ev(COMMANDS.ask))).toBe('off_record');
    offRecord.set(SID, false);
    expect(await egress.handle(ev(COMMANDS.ask))).toBe('sent');
  });

  it('reads the state from the session row when this process has not seen the session', async () => {
    store.data.sessions[0]!.off_record = true;
    expect(await egress.handle(ev(COMMANDS.intervene))).toBe('off_record');
    expect(offRecord.isOn(SID)).toBe(true);
  });

  it('only affects the session that is off the record', async () => {
    offRecord.set(SID, true);
    expect(await egress.handle(ev(COMMANDS.ask, SID2))).toBe('sent');
  });
});

describe('egress spoken-command debounce', () => {
  it('allows one of ask/followup/predict per 8 s per session', async () => {
    expect(await egress.handle(ev(COMMANDS.ask))).toBe('sent');
    clock += 3000;
    expect(await egress.handle(ev(COMMANDS.followup))).toBe('debounced');
    clock += 3000;
    expect(await egress.handle(ev(COMMANDS.predict))).toBe('debounced');
    clock += SPOKEN_WINDOW_MS - 6000;
    expect(await egress.handle(ev(COMMANDS.predict))).toBe('sent');
  });

  it('never debounces intervene, teachback or unspoken commands', async () => {
    await egress.handle(ev(COMMANDS.ask));
    for (const type of ['intervene', 'teachback', 'ctx', 'replay', 'summary', 'phase'] as const) {
      expect(await egress.handle(ev(COMMANDS[type]))).toBe('sent');
    }
  });

  it('counts each session separately', async () => {
    await egress.handle(ev(COMMANDS.ask, SID));
    expect(await egress.handle(ev(COMMANDS.ask, SID2))).toBe('sent');
  });

  it('does not debounce the retry of a broadcast that failed', async () => {
    const e = ev(COMMANDS.ask);
    broadcaster.fail = new Error('realtime down');
    await expect(egress.handle(e)).rejects.toThrow('realtime down');
    broadcaster.fail = undefined;
    expect(await egress.handle(e)).toBe('sent');
  });

  it('resets when the session is forgotten', async () => {
    await egress.handle(ev(COMMANDS.ask));
    egress.forget(SID);
    expect(await egress.handle(ev(COMMANDS.followup))).toBe('sent');
  });
});
