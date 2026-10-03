import { describe, expect, it } from 'vitest';
import { makeEvent, signSessionToken, STREAMS } from '../src/contracts/index.js';
import { OffRecordState } from '../src/services/off-record.js';
import type { SessionRow } from '../src/store/types.js';
import { IDS, fakeBroadcaster, fakeBus, memoryStore } from './fakes/index.js';
import { SECRETS, TEST_USER, VALID_JWT, buildTestApp } from './helpers.js';

const SID = '60000000-0000-4000-8000-000000000001';

const session: SessionRow = {
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
  started_at: new Date().toISOString(),
  ended_at: null,
};

function setup() {
  const bus = fakeBus();
  const broadcaster = fakeBroadcaster();
  const offRecord = new OffRecordState();
  const store = memoryStore({
    sessions: [{ ...session }],
    members: [{ org_id: IDS.org, user_id: TEST_USER.id, role: 'expert' }],
  });
  return { bus, broadcaster, offRecord, store, app: buildTestApp({ bus, broadcaster, offRecord, store }) };
}

const ask = makeEvent({
  type: 'agent.command',
  org_id: IDS.org,
  session_id: SID,
  t_ms: 4200,
  producer: 'brain',
  data: { type: 'ask', question_id: 'q1', text: 'Why 0400?', qtype: 'why' },
});

describe('egress wiring', () => {
  it('consumes sk:agent.commands once ready and broadcasts to the page', async () => {
    const { bus, broadcaster, app } = setup();
    const a = await app;
    expect(bus.consuming(STREAMS.commands)).toBe(false);
    await a.ready();
    expect(bus.consuming(STREAMS.commands)).toBe(true);

    await bus.deliver(STREAMS.commands, ask);
    expect(broadcaster.sent).toEqual([{ sessionId: SID, cmd: ask.data }]);

    await a.close();
    expect(bus.consuming(STREAMS.commands)).toBe(false);
  });

  it('opens the Realtime channel when the page connects', async () => {
    const { broadcaster, app } = setup();
    const a = await app;
    await a.ready();
    const t = await signSessionToken({ sid: SID, org: IDS.org, role: 'expert', kind: 'capture' }, SECRETS.session);
    const ws = await a.injectWS(`/ws/client/${SID}?t=${t}`);
    expect(broadcaster.warmed).toEqual([SID]);
    ws.terminate();
  });

  it('releases per-session state when the session ends', async () => {
    const { bus, broadcaster, offRecord, app } = setup();
    const a = await app;
    await a.ready();
    offRecord.set(SID, true);

    const res = await a.inject({
      method: 'POST',
      url: `/v1/sessions/${SID}/end`,
      headers: { authorization: `Bearer ${VALID_JWT}` },
    });
    expect(res.statusCode).toBe(200);
    expect(broadcaster.released).toEqual([SID]);
    expect(offRecord.has(SID)).toBe(false);
    expect(bus.published.map((p) => p.stream)).toEqual([STREAMS.lifecycle]);
  });
});
