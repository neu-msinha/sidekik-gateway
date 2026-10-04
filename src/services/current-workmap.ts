import type { Envelope, WorkMapPublished } from '../contracts/index.js';
import type { Store } from '../store/types.js';

type Log = { info(obj: object, msg: string): void; warn(obj: object, msg: string): void };

/**
 * Consumes `sk:workmap.published` and points the workflow at the newly published Work Map, so new
 * tutor sessions without an explicit `workmap_id` teach from it (sessions.ts reads
 * workflows.current_workmap_id). Never moves the pointer back to an older version, and ignores a
 * map whose workflow belongs to another org. Idempotent: redelivery finds the pointer already set.
 */
export function createCurrentWorkMapUpdater(deps: { store: Store; log: Log }) {
  return async (ev: Envelope<WorkMapPublished>): Promise<void> => {
    const { workmap_id, workflow_id, version } = ev.data;
    const ctx = { event_id: ev.id, org_id: ev.org_id, session_id: ev.session_id, workmap_id, workflow_id, version };

    const workflow = await deps.store.getWorkflow(workflow_id);
    if (!workflow || workflow.org_id !== ev.org_id) {
      deps.log.warn(ctx, 'workmap.published for an unknown workflow or another org; ignored');
      return;
    }
    if (workflow.current_workmap_id === workmap_id) return;

    if (workflow.current_workmap_id) {
      const current = await deps.store.getWorkMap(workflow.current_workmap_id);
      if (current?.version !== undefined && current.version > version) {
        deps.log.info({ ...ctx, current_version: current.version }, 'older Work Map published; current map kept');
        return;
      }
    }
    await deps.store.setCurrentWorkMap(workflow_id, workmap_id);
    deps.log.info({ ...ctx, previous: workflow.current_workmap_id }, 'workflow now teaches from the published Work Map');
  };
}
