import { notFound } from '../errors.js';
import type { Role, SessionRow, Store, WorkMapRef } from '../store/types.js';

// Lookups scoped to the caller's org. Anything outside it is a 404, so ids of other orgs don't leak.

export async function sessionForUser(store: Store, id: string, userId: string): Promise<SessionRow> {
  const session = await store.getSession(id);
  if (!session || !(await store.getRole(session.org_id, userId))) throw notFound('Session not found');
  return session;
}

export async function workmapForUser(
  store: Store,
  id: string,
  userId: string,
): Promise<{ workmap: WorkMapRef; role: Role }> {
  const workmap = await store.getWorkMap(id);
  const role = workmap && (await store.getRole(workmap.org_id, userId));
  if (!workmap || !role) throw notFound('Work Map not found');
  return { workmap, role };
}
