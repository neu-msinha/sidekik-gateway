import type { AgentCommand, Envelope } from '../contracts/index.js';
import type { Store } from '../store/types.js';
import type { OffRecordState } from './off-record.js';
import type { Broadcaster } from './realtime.js';

/** Commands the agent speaks; at most one per {@link SPOKEN_WINDOW_MS} per session. */
const DEBOUNCED = new Set<AgentCommand['type']>(['ask', 'followup', 'predict']);
export const SPOKEN_WINDOW_MS = 8000;

export type EgressOutcome = 'sent' | 'duplicate' | 'off_record' | 'debounced' | 'unknown_session';

export type EgressLogger = {
  info(obj: object, msg: string): void;
  warn(obj: object, msg: string): void;
};

export type EgressDeps = {
  broadcaster: Broadcaster;
  offRecord: OffRecordState;
  store: Pick<Store, 'getSession'>;
  log: EgressLogger;
  now?: () => number;
  /** Called after a command reached the page; replay mode records it here. */
  onSent?: (ev: Envelope<AgentCommand>) => Promise<unknown>;
};

/**
 * Handler for `sk:agent.commands` (DESIGN §7): off-record filter, then the spoken-command
 * debounce, then the Realtime broadcast. `intervene` and `teachback` are never debounced.
 */
export function createEgress(deps: EgressDeps) {
  const now = deps.now ?? Date.now;
  const lastSpoken = new Map<string, number>();
  const handled = new RecentIds(5000);
  const replaySessions = new Map<string, boolean>();

  /** Replayed commands were already debounced when they were recorded. */
  async function isReplay(sessionId: string): Promise<boolean> {
    const cached = replaySessions.get(sessionId);
    if (cached !== undefined) return cached;
    const session = await deps.store.getSession(sessionId);
    const replay = session?.mode === 'replay';
    if (session) replaySessions.set(sessionId, replay);
    return replay;
  }

  /** Off-record state, read from the session row the first time this process sees the session. */
  async function isOffRecord(sessionId: string): Promise<boolean | null> {
    if (deps.offRecord.has(sessionId)) return deps.offRecord.isOn(sessionId);
    const session = await deps.store.getSession(sessionId);
    if (!session) return null;
    deps.offRecord.seed(sessionId, session.off_record);
    return deps.offRecord.isOn(sessionId);
  }

  async function handle(ev: Envelope<AgentCommand>): Promise<EgressOutcome> {
    const cmd = ev.data;
    const ctx = { session_id: ev.session_id, org_id: ev.org_id, event_id: ev.id, cmd: cmd.type };
    if (handled.has(ev.id)) return 'duplicate';

    if (cmd.type !== 'offrecord') {
      const off = await isOffRecord(ev.session_id);
      if (off === null) {
        deps.log.warn(ctx, 'command dropped: unknown session');
        handled.add(ev.id);
        return 'unknown_session';
      }
      if (off) {
        deps.log.info(ctx, 'command dropped: off the record');
        handled.add(ev.id);
        return 'off_record';
      }
    }

    const debounced = DEBOUNCED.has(cmd.type) && !(await isReplay(ev.session_id));
    if (debounced) {
      const last = lastSpoken.get(ev.session_id);
      const t = now();
      if (last !== undefined && t - last < SPOKEN_WINDOW_MS) {
        deps.log.info({ ...ctx, since_last_ms: t - last }, 'command dropped: spoken-command debounce');
        handled.add(ev.id);
        return 'debounced';
      }
    }

    await deps.broadcaster.send(ev.session_id, cmd);
    // Recorded only after a successful send, so a bus retry of a failed broadcast isn't debounced.
    if (debounced) lastSpoken.set(ev.session_id, now());
    handled.add(ev.id);
    deps.log.info({ ...ctx, latency_ms: Math.max(0, now() - Date.parse(ev.ts)) }, 'command broadcast');
    await deps.onSent?.(ev).catch((err) => deps.log.warn({ ...ctx, err }, 'onSent hook failed'));
    return 'sent';
  }

  return {
    handle,
    /** Drops per-session state when a session ends. */
    forget(sessionId: string) {
      lastSpoken.delete(sessionId);
      replaySessions.delete(sessionId);
    },
  };
}

export type Egress = ReturnType<typeof createEgress>;

/** Bounded set of recently handled event ids, so bus redeliveries are not broadcast twice. */
class RecentIds {
  private readonly ids = new Set<string>();
  constructor(private readonly max: number) {}
  has(id: string) {
    return this.ids.has(id);
  }
  add(id: string) {
    this.ids.add(id);
    if (this.ids.size > this.max) this.ids.delete(this.ids.values().next().value!);
  }
}
