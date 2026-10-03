import { createHash } from 'node:crypto';
import type { Envelope, UsageRecord } from '../contracts/index.js';
import type { CostEntry, Store } from '../store/types.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * A stable UUID (version 5 layout) for a bus event, used as the cost_ledger row id. The table has
 * no event-id column, so this is what makes the `sk:usage` handler idempotent across restarts.
 */
export function eventUuid(eventId: string): string {
  const h = createHash('sha1').update(`sidekik:cost_ledger:${eventId}`).digest();
  h[6] = (h[6]! & 0x0f) | 0x50;
  h[8] = (h[8]! & 0x3f) | 0x80;
  const x = h.subarray(0, 16).toString('hex');
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20)}`;
}

type Log = { info(obj: object, msg: string): void; warn(obj: object, msg: string): void };

/** Handler for `sk:usage`: one cost_ledger row per usage event. */
export function createCostLedger(deps: { store: Pick<Store, 'insertCost'>; log: Log }) {
  return async function handle(ev: Envelope<UsageRecord>): Promise<void> {
    const ctx = { event_id: ev.id, session_id: ev.session_id, org_id: ev.org_id };
    if (!UUID.test(ev.org_id)) {
      deps.log.warn(ctx, 'usage event dropped: org_id is not a uuid');
      return;
    }
    const u = ev.data;
    const inserted = await deps.store.insertCost({
      id: eventUuid(ev.id),
      org_id: ev.org_id,
      // Usage outside a session (e.g. a publish job) has no session row to reference.
      session_id: UUID.test(ev.session_id) ? ev.session_id : null,
      service: u.service,
      vendor: u.vendor,
      units: u.units,
      unit: u.unit,
      cost_usd: u.cost_usd,
      counterfactual_usd: u.counterfactual_usd ?? null,
    });
    if (inserted) deps.log.info({ ...ctx, vendor: u.vendor, cost_usd: u.cost_usd }, 'usage recorded');
  };
}

type Money = { cost_usd: number; counterfactual_usd: number; records: number };

const round = (n: number) => Math.round(n * 1e6) / 1e6;

/**
 * Totals for the admin cost card. The counterfactual is what the session would have cost with
 * every decision made by an LLM instead of Jev: records without a counterfactual (voice, vision,
 * Recall) cost the same either way, so they count at their actual cost.
 */
export function summarizeCosts(sessionId: string, entries: CostEntry[]) {
  const group = (key: 'vendor' | 'service') => {
    const acc = new Map<string, Money>();
    for (const e of entries) {
      const m = acc.get(e[key]) ?? { cost_usd: 0, counterfactual_usd: 0, records: 0 };
      m.cost_usd += e.cost_usd;
      m.counterfactual_usd += e.counterfactual_usd ?? e.cost_usd;
      m.records += 1;
      acc.set(e[key], m);
    }
    return [...acc.entries()]
      .map(([name, m]) => ({ [key]: name, cost_usd: round(m.cost_usd), counterfactual_usd: round(m.counterfactual_usd), records: m.records }))
      .sort((a, b) => b.cost_usd - a.cost_usd);
  };

  const cost = entries.reduce((s, e) => s + e.cost_usd, 0);
  const counterfactual = entries.reduce((s, e) => s + (e.counterfactual_usd ?? e.cost_usd), 0);
  return {
    session_id: sessionId,
    currency: 'USD',
    totals: {
      cost_usd: round(cost),
      counterfactual_usd: round(counterfactual),
      savings_usd: round(counterfactual - cost),
      records: entries.length,
    },
    by_vendor: group('vendor'),
    by_service: group('service'),
    entries: entries.map(({ service, vendor, units, unit, cost_usd, counterfactual_usd, created_at }) => ({
      service,
      vendor,
      units,
      unit,
      cost_usd,
      counterfactual_usd,
      created_at,
    })),
  };
}
