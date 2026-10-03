import { beforeEach, describe, expect, it } from 'vitest';
import { makeEvent, STREAMS, UsageRecordSchema, type UsageRecord } from '../src/contracts/index.js';
import { createCostLedger, eventUuid, summarizeCosts } from '../src/services/costs.js';
import type { CostEntry } from '../src/store/types.js';
import { IDS, fakeBus, memoryStore } from './fakes/index.js';
import { TEST_USER, VALID_JWT, buildTestApp } from './helpers.js';

const SID = '60000000-0000-4000-8000-000000000001';
const quiet = { info: () => {}, warn: () => {} };

const usage = (data: UsageRecord, session_id = SID, org_id = IDS.org) =>
  makeEvent({ type: 'usage', org_id, session_id, t_ms: 0, producer: 'brain', data });

const jev: UsageRecord = {
  service: 'brain',
  vendor: 'typesafe',
  units: 1200,
  unit: 'tokens_in',
  cost_usd: 0.00012,
  counterfactual_usd: 0.0036,
};
const voiceMinutes: UsageRecord = { service: 'voice', vendor: 'elevenlabs', units: 4.5, unit: 'minutes', cost_usd: 0.36 };

describe('eventUuid', () => {
  it('is a stable, valid UUID per event id', () => {
    const a = eventUuid('01J9ZQ3X7K8M2N4P6R8T0V2W4Y');
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(eventUuid('01J9ZQ3X7K8M2N4P6R8T0V2W4Y')).toBe(a);
    expect(eventUuid('01J9ZQ3X7K8M2N4P6R8T0V2W4Z')).not.toBe(a);
  });
});

describe('UsageRecordSchema', () => {
  it('uses the v0.2 vendor list (no gemini)', () => {
    expect(UsageRecordSchema.safeParse({ ...jev, vendor: 'gemini' }).success).toBe(false);
    expect(UsageRecordSchema.safeParse(jev).success).toBe(true);
  });
});

describe('cost ledger handler', () => {
  let store: ReturnType<typeof memoryStore>;
  let handle: ReturnType<typeof createCostLedger>;
  beforeEach(() => {
    store = memoryStore();
    handle = createCostLedger({ store, log: quiet });
  });

  it('records one row per usage event', async () => {
    const ev = usage(jev);
    await handle(ev);
    expect(store.data.costs).toEqual([
      expect.objectContaining({
        id: eventUuid(ev.id),
        org_id: IDS.org,
        session_id: SID,
        service: 'brain',
        vendor: 'typesafe',
        units: 1200,
        unit: 'tokens_in',
        cost_usd: 0.00012,
        counterfactual_usd: 0.0036,
      }),
    ]);
  });

  it('records a redelivered event only once', async () => {
    const ev = usage(jev);
    await handle(ev);
    await handle(ev);
    expect(store.data.costs).toHaveLength(1);
  });

  it('stores null for a missing counterfactual and a non-session usage event', async () => {
    await handle(usage(voiceMinutes, 'publish-job-7'));
    expect(store.data.costs[0]).toMatchObject({ session_id: null, counterfactual_usd: null });
  });

  it('drops an event whose org_id is not a uuid', async () => {
    await handle(usage(jev, SID, 'org-1'));
    expect(store.data.costs).toHaveLength(0);
  });
});

describe('summarizeCosts', () => {
  const entry = (u: UsageRecord, created_at: string): CostEntry => ({
    id: created_at,
    org_id: IDS.org,
    session_id: SID,
    ...u,
    counterfactual_usd: u.counterfactual_usd ?? null,
    created_at,
  });

  it('totals actual and LLM-only counterfactual costs', () => {
    const summary = summarizeCosts(SID, [
      entry(jev, '2026-10-03T10:00:01Z'),
      entry(jev, '2026-10-03T10:00:02Z'),
      entry(voiceMinutes, '2026-10-03T10:00:03Z'),
    ]);
    expect(summary.totals).toEqual({
      cost_usd: 0.36024,
      counterfactual_usd: 0.3672,
      savings_usd: 0.00696,
      records: 3,
    });
    expect(summary.by_vendor).toEqual([
      { vendor: 'elevenlabs', cost_usd: 0.36, counterfactual_usd: 0.36, records: 1 },
      { vendor: 'typesafe', cost_usd: 0.00024, counterfactual_usd: 0.0072, records: 2 },
    ]);
    expect(summary.by_service.map((s) => s.service)).toEqual(['voice', 'brain']);
    expect(summary.entries).toHaveLength(3);
    expect(summary.entries[0]).not.toHaveProperty('org_id');
  });

  it('returns zeros for a session without usage', () => {
    expect(summarizeCosts(SID, []).totals).toEqual({ cost_usd: 0, counterfactual_usd: 0, savings_usd: 0, records: 0 });
  });
});

describe('cost ledger wiring and GET /v1/costs/:sid', () => {
  const session = {
    id: SID,
    org_id: IDS.org,
    workflow_id: IDS.workflow,
    kind: 'capture' as const,
    mode: 'browser' as const,
    phase: 'capture' as const,
    expert_id: null,
    learner_id: null,
    workmap_id: null,
    language: 'de',
    el_agent_id: null,
    off_record: false,
    consent_at: null,
    started_at: new Date().toISOString(),
    ended_at: null,
  };

  it('consumes sk:usage and serves the summary', async () => {
    const store = memoryStore({
      sessions: [session],
      members: [{ org_id: IDS.org, user_id: TEST_USER.id, role: 'admin' }],
    });
    const bus = fakeBus();
    const app = await buildTestApp({ store, bus });
    await app.ready();
    expect(bus.consuming(STREAMS.usage)).toBe(true);

    await bus.deliver(STREAMS.usage, usage(jev));
    await bus.deliver(STREAMS.usage, usage(voiceMinutes));

    const res = await app.inject({ method: 'GET', url: `/v1/costs/${SID}`, headers: { authorization: `Bearer ${VALID_JWT}` } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ session_id: SID, currency: 'USD', totals: { records: 2, cost_usd: 0.36012 } });

    store.data.members = [];
    expect(
      (await app.inject({ method: 'GET', url: `/v1/costs/${SID}`, headers: { authorization: `Bearer ${VALID_JWT}` } }))
        .statusCode,
    ).toBe(404);
    expect((await app.inject({ method: 'GET', url: `/v1/costs/${SID}` })).statusCode).toBe(401);
    await app.close();
    expect(bus.consuming(STREAMS.usage)).toBe(false);
  });
});
