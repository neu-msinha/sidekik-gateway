import type { Bus, Phase } from '../contracts/index.js';
import { HttpError } from '../errors.js';
import type { SessionRow, Store } from '../store/types.js';
import { KeyedQueue } from './keyed-queue.js';
import { publishLifecycle } from './lifecycle.js';
import type { Log, OffRecordState } from './off-record.js';
import type { Broadcaster } from './realtime.js';
import type { VoiceClient } from './voice.js';

export type PhaseResult = {
  session_id: string;
  phase: Phase;
  changed: boolean;
  /** For debrief: whether the `phase` command reached the page now (false while off the record). */
  delivered?: boolean;
};

export type PhaseServiceDeps = {
  store: Store;
  bus: Bus;
  voice: VoiceClient;
  broadcaster: Broadcaster;
  offRecord: OffRecordState;
};

const invalid = (session: SessionRow, wanted: Phase) =>
  new HttpError(409, 'invalid_phase', `Cannot move a ${session.kind} session from ${session.phase} to ${wanted}`);

/**
 * Capture-session phases (DESIGN §5): capture → building (UI task_done) → debrief → confirmed (mapper).
 * Each transition is checked against the current phase in the database, so retries are safe.
 */
export function createPhaseService(deps: PhaseServiceDeps) {
  const queue = new KeyedQueue();
  // Debrief variables whose phase command is waiting for the session to go back on the record.
  const held = new Map<string, Record<string, string>>();

  /** Applies from → to, or returns the current row if it's already at `to`. */
  async function transition(session: SessionRow, from: Phase[], to: Phase) {
    if (session.kind !== 'capture' || session.ended_at) throw invalid(session, to);
    if (session.phase === to) return { session, changed: false };
    if (!from.includes(session.phase)) throw invalid(session, to);
    const updated = await deps.store.updatePhase(session.id, from, to);
    if (updated) return { session: updated, changed: true };
    // Lost a race with another writer; report against the row as it is now.
    const current = (await deps.store.getSession(session.id)) ?? session;
    if (current.phase === to) return { session: current, changed: false };
    throw invalid(current, to);
  }

  async function taskDone(session: SessionRow, log: Log): Promise<PhaseResult> {
    return queue.run(session.id, async () => {
      const r = await transition(session, ['capture'], 'building');
      if (r.changed) {
        await publishLifecycle(deps.bus, r.session, 'task_done');
        log.info({ session_id: session.id, org_id: session.org_id }, 'task done; building Work Map');
      }
      return { session_id: session.id, phase: r.session.phase, changed: r.changed };
    });
  }

  async function debrief(session: SessionRow, variables: Record<string, string>, log: Log): Promise<PhaseResult> {
    return queue.run(session.id, async () => {
      if (session.kind !== 'capture' || session.ended_at || !['building', 'debrief'].includes(session.phase)) {
        throw invalid(session, 'debrief');
      }
      const dynamic_variables = await debriefVariables(session, variables);
      // Token first: if voice fails, nothing has changed and mapper can simply retry.
      const token = await deps.voice.getToken({
        agent: 'interviewer',
        phase: 'debrief',
        session_id: session.id,
        dynamic_variables,
        language: session.language,
      });

      const r = await transition(session, ['building'], 'debrief');
      if (r.changed) await publishLifecycle(deps.bus, r.session, 'phase_changed');

      const ctx = { session_id: session.id, org_id: session.org_id };
      if (deps.offRecord.isOn(session.id)) {
        held.set(session.id, dynamic_variables);
        log.info(ctx, 'debrief phase command held: off the record');
        return { session_id: session.id, phase: 'debrief', changed: r.changed, delivered: false };
      }
      await deps.broadcaster.send(session.id, { type: 'phase', phase: 'debrief', ...token, dynamic_variables });
      held.delete(session.id);
      log.info({ ...ctx, changed: r.changed }, 'debrief phase command sent');
      return { session_id: session.id, phase: 'debrief', changed: r.changed, delivered: true };
    });
  }

  async function confirmed(session: SessionRow, log: Log): Promise<PhaseResult> {
    return queue.run(session.id, async () => {
      const r = await transition(session, ['debrief'], 'confirmed');
      held.delete(session.id);
      if (r.changed) {
        await publishLifecycle(deps.bus, r.session, 'phase_changed');
        log.info({ session_id: session.id, org_id: session.org_id }, 'Work Map confirmed');
      }
      return { session_id: session.id, phase: r.session.phase, changed: r.changed };
    });
  }

  /** Delivers a held debrief command with a fresh voice token once the session is back on the record. */
  async function resumeAfterOffRecord(session: SessionRow, log: Log): Promise<void> {
    await queue.run(session.id, async () => {
      const dynamic_variables = held.get(session.id);
      if (!dynamic_variables) return;
      const current = await deps.store.getSession(session.id);
      if (current?.phase !== 'debrief' || current.ended_at) {
        held.delete(session.id);
        return;
      }
      const token = await deps.voice.getToken({
        agent: 'interviewer',
        phase: 'debrief',
        session_id: session.id,
        dynamic_variables,
        language: current.language,
      });
      await deps.broadcaster.send(session.id, { type: 'phase', phase: 'debrief', ...token, dynamic_variables });
      held.delete(session.id);
      log.info({ session_id: session.id, org_id: session.org_id }, 'held debrief phase command sent');
    });
  }

  /** The debrief prompt's {{expert_name}} and {{workflow_name}}, overridden by whatever mapper sends. */
  async function debriefVariables(session: SessionRow, fromMapper: Record<string, string>) {
    const [workflow, expert] = await Promise.all([
      deps.store.getWorkflow(session.workflow_id),
      session.expert_id ? deps.store.getExpert(session.expert_id) : Promise.resolve(null),
    ]);
    return {
      session_id: session.id,
      language: session.language,
      workflow_name: workflow?.name ?? 'the workflow',
      expert_name: expert?.display_name ?? 'the expert',
      ...fromMapper,
    };
  }

  return {
    taskDone,
    debrief,
    confirmed,
    resumeAfterOffRecord,
    forget: (sessionId: string) => held.delete(sessionId),
  };
}

export type PhaseService = ReturnType<typeof createPhaseService>;
