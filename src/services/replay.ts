import { randomUUID } from 'node:crypto';
import { makeEvent, STREAMS, type Bus, type Envelope, type StreamKey, type StreamPayload } from '../contracts/index.js';
import { HttpError } from '../errors.js';
import type { ReplayEventRow, SessionRow, Store } from '../store/types.js';
import { stableUuid, UUID_RE } from './ids.js';
import { publishLifecycle } from './lifecycle.js';
import type { OffRecordState } from './off-record.js';

/**
 * Streams recorded straight from the bus. Agent commands are recorded by egress instead, and only
 * when they reached the page, so a replay never shows a command the original session dropped.
 * Usage and workmap.published are left out: replaying them would double-count costs and make
 * voice and tutor re-sync a Work Map.
 */
export const RECORDED_STREAMS: StreamKey[] = [
  STREAMS.lifecycle,
  STREAMS.turns,
  STREAMS.speech,
  STREAMS.dom,
  STREAMS.screen,
];
export const RECORDER_GROUP = 'gateway-recorder';

type Log = { info(obj: object, msg: string): void; error(obj: object, msg: string): void };
type Cancel = () => void;

export type ReplayDeps = {
  store: Store;
  bus: Bus;
  offRecord: OffRecordState;
  log: Log;
  /** Runs fn after ms; returns a cancel function. */
  schedule?: (fn: () => void, ms: number) => Cancel;
  /** Called when a replay has finished publishing (e.g. to release the Realtime channel). */
  onFinished?: (session: SessionRow) => Promise<void>;
};

export type ReplayStarted = {
  session: SessionRow;
  events: number;
  duration_ms: number;
};

/** Replay mode (DESIGN §8): record sessions, then re-publish a recording under a new session id. */
export function createReplay(deps: ReplayDeps) {
  const schedule =
    deps.schedule ??
    ((fn, ms) => {
      const t = setTimeout(fn, ms);
      return () => clearTimeout(t);
    });
  const modes = new Map<string, SessionRow['mode']>();
  const running = new Map<string, Cancel[]>();

  async function modeOf(sessionId: string): Promise<SessionRow['mode'] | null> {
    if (!UUID_RE.test(sessionId)) return null;
    const cached = modes.get(sessionId);
    if (cached) return cached;
    const session = await deps.store.getSession(sessionId);
    if (session) modes.set(sessionId, session.mode);
    return session?.mode ?? null;
  }

  /** Appends an event to replay_events. Skips replays, unknown sessions and off-record time. */
  async function record(stream: StreamKey, ev: Envelope<unknown>): Promise<boolean> {
    const mode = await modeOf(ev.session_id);
    if (!mode || mode === 'replay') return false;
    if (deps.offRecord.isOn(ev.session_id)) return false;
    return deps.store.insertReplayEvent({
      id: stableUuid('replay_events', `${stream}:${ev.id}`),
      org_id: ev.org_id,
      session_id: ev.session_id,
      stream,
      t_ms: ev.t_ms,
      envelope: ev,
    });
  }

  async function start(original: SessionRow, speed: number): Promise<ReplayStarted> {
    if (original.mode === 'replay') throw new HttpError(409, 'is_replay', 'Cannot replay a replay session');
    const recorded = await deps.store.listReplayEvents(original.id);
    // The replay session publishes its own `started`.
    const events = recorded.filter((e) => !(e.stream === STREAMS.lifecycle && lifecycleEvent(e) === 'started'));
    if (events.length === 0) throw new HttpError(409, 'nothing_to_replay', 'No recorded events for this session');

    const session = await deps.store.insertSession({
      id: randomUUID(),
      org_id: original.org_id,
      workflow_id: original.workflow_id,
      kind: original.kind,
      mode: 'replay',
      phase: original.kind === 'capture' ? 'capture' : 'tutoring',
      expert_id: original.expert_id,
      learner_id: original.learner_id,
      workmap_id: original.workmap_id,
      language: original.language,
      el_agent_id: null,
      replay_of: original.id,
      consent_at: original.consent_at,
    });
    modes.set(session.id, 'replay');
    await publishLifecycle(deps.bus, session, 'started');

    const ctx = { session_id: session.id, org_id: session.org_id, replay_of: original.id };
    const cancels: Cancel[] = [];
    running.set(session.id, cancels);
    // Publishes go through one chain so they reach the bus in recorded order.
    let chain = Promise.resolve();
    const enqueue = (fn: () => Promise<unknown>) => {
      chain = chain.then(fn).then(
        () => {},
        (err) => deps.log.error({ ...ctx, err }, 'replay publish failed'),
      );
    };

    for (const e of events) {
      cancels.push(
        // The bus validates each event against its stream's schema; the cast only satisfies the types.
        schedule(() => enqueue(() => deps.bus.publish(e.stream as StreamKey, rewrite(e, session.id) as Envelope<StreamPayload<StreamKey>>)), e.t_ms / speed),
      );
    }

    const duration_ms = Math.round(events.at(-1)!.t_ms / speed);
    const replayedEnded = events.some((e) => e.stream === STREAMS.lifecycle && lifecycleEvent(e) === 'ended');
    cancels.push(
      schedule(() => {
        enqueue(async () => {
          const ended = await deps.store.endSession(session.id);
          if (!replayedEnded) await publishLifecycle(deps.bus, ended, 'ended');
          running.delete(session.id);
          deps.log.info(ctx, 'replay finished');
          await deps.onFinished?.(ended);
        });
      }, duration_ms + 1),
    );

    deps.log.info({ ...ctx, events: events.length, speed, duration_ms }, 'replay started');
    return { session, events: events.length, duration_ms };
  }

  return {
    record,
    start,
    /** Cancels every scheduled publish (on shutdown). */
    stopAll() {
      for (const cancels of running.values()) for (const cancel of cancels) cancel();
      running.clear();
    },
    isRunning: (sessionId: string) => running.has(sessionId),
  };
}

export type Replay = ReturnType<typeof createReplay>;

/** A recorded envelope re-addressed to the replay session, with a fresh id and timestamp. */
function rewrite(e: ReplayEventRow, sessionId: string): Envelope<unknown> {
  const env = e.envelope;
  const data =
    e.stream === STREAMS.lifecycle
      ? { ...(env.data as object), mode: 'replay' } // so other services ignore it
      : env.data;
  return makeEvent({
    type: env.type,
    org_id: env.org_id,
    session_id: sessionId,
    t_ms: env.t_ms,
    producer: env.producer,
    data,
  });
}

const lifecycleEvent = (e: ReplayEventRow) => (e.envelope.data as { event?: string }).event;
