import type { Bus } from '../contracts/index.js';
import type { CaptureTable, OffRecordSource, SessionRow, Store } from '../store/types.js';
import { publishLifecycle } from './lifecycle.js';
import type { Broadcaster } from './realtime.js';

/**
 * In-process view of `sessions.off_record`, read on every inbound message and agent command.
 * The gateway is the only writer of that column (DESIGN §4), so this cache stays in step
 * as long as every toggle goes through {@link createOffRecordController}.
 */
export class OffRecordState {
  private readonly state = new Map<string, boolean>();

  /** Seeds the cache from the database row; a value already set in this process wins. */
  seed(sessionId: string, offRecord: boolean): void {
    if (!this.state.has(sessionId)) this.state.set(sessionId, offRecord);
  }

  set(sessionId: string, on: boolean): void {
    this.state.set(sessionId, on);
  }

  has(sessionId: string): boolean {
    return this.state.has(sessionId);
  }

  isOn(sessionId: string): boolean {
    return this.state.get(sessionId) ?? false;
  }

  forget(sessionId: string): void {
    this.state.delete(sessionId);
  }
}

export type SetOffRecordInput = {
  on: boolean;
  source: Exclude<OffRecordSource, 'retroactive'>;
  /** With on: also delete what was captured in the last back_s seconds. */
  back_s?: number;
};

export type SetOffRecordResult = {
  session_id: string;
  off_record: boolean;
  changed: boolean;
  deleted?: Record<CaptureTable, number>;
};

type Log = { info(obj: object, msg: string): void; error(obj: object, msg: string): void };

export type OffRecordControllerDeps = {
  store: Store;
  bus: Bus;
  broadcaster: Broadcaster;
  state: OffRecordState;
  now?: () => number;
  /** Delay before the second retroactive purge, which catches rows owners saved late. */
  purgeAgainAfterMs?: number;
  schedule?: (fn: () => void, ms: number) => void;
};

/**
 * The single place off-record is switched (DESIGN §4), for every trigger: UI toggle, the agent's
 * mark_off_record tool, brain D7, and the meeting-chat command.
 */
export function createOffRecordController(deps: OffRecordControllerDeps) {
  const now = deps.now ?? Date.now;
  const schedule = deps.schedule ?? ((fn, ms) => void setTimeout(fn, ms).unref());
  const purgeAgainAfterMs = deps.purgeAgainAfterMs ?? 5000;
  const queues = new Map<string, Promise<unknown>>();
  // Sessions whose last state change failed to save; the next request with that state saves it.
  const unsaved = new Set<string>();

  /** Runs toggles for one session one at a time, so on/off requests can't interleave. */
  function serialized<T>(sessionId: string, fn: () => Promise<T>): Promise<T> {
    const prev = queues.get(sessionId) ?? Promise.resolve();
    const next = prev.catch(() => {}).then(fn);
    queues.set(sessionId, next);
    void next.finally(() => {
      if (queues.get(sessionId) === next) queues.delete(sessionId);
    });
    return next;
  }

  async function set(session: SessionRow, input: SetOffRecordInput, log: Log): Promise<SetOffRecordResult> {
    return serialized(session.id, async () => {
      const ctx = { session_id: session.id, org_id: session.org_id, source: input.source };
      const tMs = Math.max(0, now() - Date.parse(session.started_at));
      const wasOn = deps.state.has(session.id) ? deps.state.isOn(session.id) : session.off_record;
      const changed = wasOn !== input.on;
      const save = changed || unsaved.has(session.id);

      if (input.on) {
        // From this instant /ws/client drops turns, speech and DOM, and egress drops commands.
        deps.state.set(session.id, true);
      }

      // The page command goes out even when nothing changed: a retried request re-shows the badge.
      await allOrFirstError([
        deps.broadcaster.send(session.id, { type: 'offrecord', on: input.on }),
        save ? persist(session, input, tMs) : Promise.resolve(),
      ]);

      if (!input.on) deps.state.set(session.id, false);
      if (changed) log.info({ ...ctx, t_ms: tMs }, input.on ? 'off the record' : 'back on the record');

      const result: SetOffRecordResult = { session_id: session.id, off_record: input.on, changed };
      if (input.on && input.back_s) {
        result.deleted = await purge(session, Math.max(0, tMs - input.back_s * 1000), tMs, log);
      }
      return result;
    });
  }

  async function persist(session: SessionRow, input: SetOffRecordInput, tMs: number) {
    unsaved.add(session.id);
    await deps.store.setOffRecord(session.id, input.on);
    if (input.on) {
      await deps.store.openOffRecordSpan({ session, start_t_ms: tMs, source: input.source });
    } else {
      await deps.store.closeOffRecordSpans(session.id, tMs);
    }
    await publishLifecycle(
      deps.bus,
      { ...session, off_record: input.on },
      input.on ? 'offrecord_on' : 'offrecord_off',
      now(),
    );
    unsaved.delete(session.id);
  }

  async function purge(session: SessionRow, cutoffTms: number, tMs: number, log: Log) {
    const ctx = { session_id: session.id, org_id: session.org_id, cutoff_t_ms: cutoffTms };
    // A closed span over the window, so voice also drops post-call webhook turns from it.
    await deps.store.openOffRecordSpan({ session, start_t_ms: cutoffTms, end_t_ms: tMs, source: 'retroactive' });
    const deleted = await deps.store.deleteCaptureSince(session, cutoffTms);
    log.info({ ...ctx, deleted }, 'retroactive off-record purge');

    schedule(() => {
      deps.store
        .deleteCaptureSince(session, cutoffTms)
        .then((again) => log.info({ ...ctx, deleted: again }, 'retroactive off-record purge (second pass)'))
        .catch((err) => log.error({ ...ctx, err }, 'retroactive off-record purge (second pass) failed'));
    }, purgeAgainAfterMs);
    return deleted;
  }

  return { set };
}

export type OffRecordController = ReturnType<typeof createOffRecordController>;

/** Waits for every promise, then rethrows the first failure, so one failing step can't cut others short. */
async function allOrFirstError(promises: Promise<unknown>[]) {
  const results = await Promise.allSettled(promises);
  const failed = results.find((r): r is PromiseRejectedResult => r.status === 'rejected');
  if (failed) throw failed.reason;
}
