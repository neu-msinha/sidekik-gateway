import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { WebSocket } from 'ws';
import { signSessionToken } from '../src/contracts/index.js';
import { OffRecordState } from '../src/services/off-record.js';
import type { Redactor } from '../src/services/redact.js';
import type { SessionRow } from '../src/store/types.js';
import { IDS, fakeBus, memoryStore } from './fakes/index.js';
import { SECRETS, buildTestApp } from './helpers.js';

const SID = '60000000-0000-4000-8000-000000000001';
const OTHER_SID = '60000000-0000-4000-8000-000000000002';

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
  started_at: new Date(Date.now() - 5000).toISOString(),
  ended_at: null,
  ...over,
});

/** Uppercases the text so tests can see redaction happened; `delays` slows specific inputs. */
const fakeRedactor = (delays: Record<string, number> = {}): Redactor & { calls: string[] } => {
  const calls: string[] = [];
  return {
    calls,
    async redact(text, language) {
      calls.push(`${language}:${text}`);
      await new Promise((r) => setTimeout(r, delays[text] ?? 0));
      return { text: `[R]${text}`, engine: 'presidio', entities: [] };
    },
  };
};

let store: ReturnType<typeof memoryStore>;
let bus: ReturnType<typeof fakeBus>;
let offRecord: OffRecordState;
let redactor: ReturnType<typeof fakeRedactor>;

beforeEach(() => {
  store = memoryStore({ sessions: [sessionRow()] });
  bus = fakeBus();
  offRecord = new OffRecordState();
  redactor = fakeRedactor();
});

const app = () => buildTestApp({ store, bus, offRecord, redactor });
const token = (sid = SID, org = IDS.org) =>
  signSessionToken({ sid, org, role: 'expert', kind: 'capture' }, SECRETS.session);

async function connect(): Promise<{ ws: WebSocket; replies: any[] }> {
  const a = await app();
  await a.ready();
  const replies: any[] = [];
  const ws = await a.injectWS(`/ws/client/${SID}?t=${await token()}`);
  ws.on('message', (m) => replies.push(JSON.parse(m.toString())));
  return { ws, replies };
}

const send = (ws: WebSocket, msg: unknown) => ws.send(JSON.stringify(msg));
const streams = () => bus.published.map((p) => p.stream);

describe('WS /ws/client/:sid connection checks', () => {
  async function status(url: string) {
    const a = await app();
    return (await a.inject({ method: 'GET', url })).statusCode;
  }

  it('rejects a missing token', async () => {
    expect(await status(`/ws/client/${SID}`)).toBe(401);
  });

  it('rejects a token signed with another secret', async () => {
    const bad = await signSessionToken({ sid: SID, org: IDS.org, role: 'expert', kind: 'capture' }, 'x'.repeat(64));
    expect(await status(`/ws/client/${SID}?t=${bad}`)).toBe(401);
  });

  it('rejects a token for another session', async () => {
    expect(await status(`/ws/client/${SID}?t=${await token(OTHER_SID)}`)).toBe(403);
  });

  it('rejects a token whose org does not own the session', async () => {
    expect(await status(`/ws/client/${SID}?t=${await token(SID, IDS.otherOrg)}`)).toBe(404);
  });

  it('rejects until consent is recorded', async () => {
    store.data.sessions[0]!.consent_at = null;
    expect(await status(`/ws/client/${SID}?t=${await token()}`)).toBe(409);
  });

  it('rejects an ended session', async () => {
    store.data.sessions[0]!.ended_at = new Date().toISOString();
    expect(await status(`/ws/client/${SID}?t=${await token()}`)).toBe(409);
  });

  it('refuses the upgrade for a bad token', async () => {
    const a = await app();
    await a.ready();
    await expect(a.injectWS(`/ws/client/${SID}?t=nope`)).rejects.toThrow(/401/);
  });
});

describe('WS /ws/client/:sid messages', () => {
  it('redacts a turn and publishes it to sk:transcript.turns', async () => {
    const { ws } = await connect();
    send(ws, { type: 'turn', role: 'user', text: 'Sabine recodes it to 0400', t_ms: 3120 });

    await vi.waitFor(() => expect(bus.published).toHaveLength(1));
    const { stream, ev } = bus.published[0]!;
    expect(stream).toBe('sk:transcript.turns');
    expect(ev).toMatchObject({
      type: 'transcript.turn',
      org_id: IDS.org,
      session_id: SID,
      t_ms: 3120,
      producer: 'gateway',
      data: { role: 'user', text: '[R]Sabine recodes it to 0400', lang: 'de', source: 'live', redacted: true },
    });
    expect((ev.data as { turn_id: string }).turn_id).toHaveLength(26);
    expect(redactor.calls).toEqual(['de:Sabine recodes it to 0400']);
    ws.terminate();
  });

  it('keeps the client turn_id when one is sent', async () => {
    const { ws } = await connect();
    send(ws, { type: 'turn', role: 'agent', text: 'Why 0400?', turn_id: 'el-turn-7' });
    await vi.waitFor(() => expect(bus.published).toHaveLength(1));
    expect(bus.published[0]!.ev.data).toMatchObject({ turn_id: 'el-turn-7', role: 'agent' });
    ws.terminate();
  });

  it('publishes turns in the order they arrive even when redaction is slower for the first', async () => {
    redactor = fakeRedactor({ first: 80 });
    const { ws } = await connect();
    send(ws, { type: 'turn', role: 'user', text: 'first' });
    send(ws, { type: 'turn', role: 'user', text: 'second' });
    await vi.waitFor(() => expect(bus.published).toHaveLength(2));
    expect(bus.published.map((p) => (p.ev.data as { text: string }).text)).toEqual(['[R]first', '[R]second']);
    ws.terminate();
  });

  it('publishes speech signals with a server-side t_ms when the page sends none', async () => {
    const { ws } = await connect();
    send(ws, { type: 'speech', kind: 'user_speech_end' });
    await vi.waitFor(() => expect(bus.published).toHaveLength(1));
    const { stream, ev } = bus.published[0]!;
    expect(stream).toBe('sk:speech.signals');
    expect(ev).toMatchObject({ type: 'speech.signal', data: { kind: 'user_speech_end', source: 'sdk' } });
    expect(ev.t_ms).toBeGreaterThanOrEqual(5000);
    ws.terminate();
  });

  it('publishes DOM events without the message envelope fields', async () => {
    const { ws } = await connect();
    send(ws, {
      type: 'dom',
      kind: 'field_change',
      t_ms: 4000,
      field: 'cost_center',
      before: '4711',
      after: '0400',
      state: { invoice_id: '4471', net_amount: 6350, cost_center: '0400' },
    });
    await vi.waitFor(() => expect(bus.published).toHaveLength(1));
    expect(bus.published[0]).toMatchObject({
      stream: 'sk:dom.events',
      ev: {
        type: 'dom.event',
        t_ms: 4000,
        data: {
          kind: 'field_change',
          field: 'cost_center',
          before: '4711',
          after: '0400',
          state: { invoice_id: '4471', net_amount: 6350, cost_center: '0400' },
        },
      },
    });
    expect(bus.published[0]!.ev.data).not.toHaveProperty('type');
    expect(bus.published[0]!.ev.data).not.toHaveProperty('t_ms');
    ws.terminate();
  });

  it('logs agent events without publishing', async () => {
    const { ws } = await connect();
    send(ws, { type: 'agent_event', status: 'connected' });
    send(ws, { type: 'speech', kind: 'agent_speech_start' });
    await vi.waitFor(() => expect(bus.published).toHaveLength(1));
    expect(streams()).toEqual(['sk:speech.signals']);
    ws.terminate();
  });

  it('replies with an error for bad messages and keeps the socket open', async () => {
    const { ws, replies } = await connect();
    ws.send('not json');
    send(ws, { type: 'turn', role: 'robot', text: 'hi' });
    send(ws, { type: 'unknown' });
    ws.send(Buffer.from([1, 2, 3]), { binary: true });
    send(ws, { type: 'speech', kind: 'typing' });

    await vi.waitFor(() => expect(replies).toHaveLength(4));
    expect(replies.every((r) => r.type === 'error' && r.error === 'bad_message')).toBe(true);
    expect(replies[1].message).toMatch(/^role:/);
    await vi.waitFor(() => expect(streams()).toEqual(['sk:speech.signals']));
    ws.terminate();
  });
});

describe('WS /ws/client/:sid off the record', () => {
  it('drops turns, speech and DOM events while off the record', async () => {
    const { ws } = await connect();
    offRecord.set(SID, true);
    send(ws, { type: 'turn', role: 'user', text: 'secret salary talk' });
    send(ws, { type: 'speech', kind: 'user_speech_start' });
    send(ws, { type: 'dom', kind: 'field_focus', field: 'iban' });
    // Let the server handle those before switching back on the record.
    await new Promise((r) => setTimeout(r, 50));

    offRecord.set(SID, false);
    send(ws, { type: 'turn', role: 'user', text: 'back on' });

    await vi.waitFor(() => expect(bus.published).toHaveLength(1));
    expect((bus.published[0]!.ev.data as { text: string }).text).toBe('[R]back on');
    expect(redactor.calls).toEqual(['de:back on']);
    ws.terminate();
  });

  it('drops a turn when off-record is switched on during redaction', async () => {
    redactor = fakeRedactor({ 'said just before': 60 });
    const { ws } = await connect();
    send(ws, { type: 'turn', role: 'user', text: 'said just before' });
    await vi.waitFor(() => expect(redactor.calls).toHaveLength(1));
    offRecord.set(SID, true);

    await new Promise((r) => setTimeout(r, 120));
    expect(bus.published).toHaveLength(0);
    ws.terminate();
  });

  it('starts off the record when the session row says so', async () => {
    store.data.sessions[0]!.off_record = true;
    const { ws } = await connect();
    send(ws, { type: 'speech', kind: 'user_speech_start' });
    send(ws, { type: 'agent_event', status: 'probe' });
    await new Promise((r) => setTimeout(r, 50));
    expect(bus.published).toHaveLength(0);
    expect(offRecord.isOn(SID)).toBe(true);
    ws.terminate();
  });
});
