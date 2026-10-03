import type { FastifyRequest } from 'fastify';
import { notFound } from '../errors.js';
import { annotate } from '../logging.js';
import type { Role, SessionRow, Store, WorkMapRef } from '../store/types.js';

// Lookups scoped to the caller's org. Anything outside it is a 404, so ids of other orgs don't leak.
// Each one adds what it found to the request's log lines.

export async function sessionForUser(store: Store, request: FastifyRequest, id: string): Promise<SessionRow> {
  const session = await store.getSession(id);
  if (!session || !(await store.getRole(session.org_id, request.user!.id))) throw notFound('Session not found');
  annotate(request, { session_id: session.id, org_id: session.org_id });
  return session;
}

export async function workmapForUser(
  store: Store,
  request: FastifyRequest,
  id: string,
): Promise<{ workmap: WorkMapRef; role: Role }> {
  const workmap = await store.getWorkMap(id);
  const role = workmap && (await store.getRole(workmap.org_id, request.user!.id));
  if (!workmap || !role) throw notFound('Work Map not found');
  annotate(request, { workmap_id: workmap.id, org_id: workmap.org_id });
  return { workmap, role };
}
