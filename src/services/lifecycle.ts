import { makeEvent, STREAMS, type Bus, type SessionLifecycle } from '../contracts/index.js';
import type { SessionRow } from '../store/types.js';

/** Publishes a `sk:session.lifecycle` event built from the session's current row. */
export async function publishLifecycle(
  bus: Bus,
  session: SessionRow,
  event: SessionLifecycle['event'],
  now = Date.now(),
): Promise<void> {
  const data: SessionLifecycle = {
    event,
    kind: session.kind,
    phase: session.phase,
    workflow_id: session.workflow_id,
    ...(session.workmap_id && { workmap_id: session.workmap_id }),
    mode: session.mode,
    language: session.language,
  };
  await bus.publish(
    STREAMS.lifecycle,
    makeEvent({
      type: 'session.lifecycle',
      org_id: session.org_id,
      session_id: session.id,
      t_ms: Math.max(0, now - Date.parse(session.started_at)),
      producer: 'gateway',
      data,
    }),
  );
}
