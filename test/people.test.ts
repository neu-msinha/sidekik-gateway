import { beforeEach, describe, expect, it } from 'vitest';
import type { AuthUser } from '../src/auth.js';
import { IDS, memoryStore, type MemoryData } from './fakes/index.js';
import { buildTestApp } from './helpers.js';

const USERS = {
  mayukh: { id: '00000000-0000-4000-8000-0000000000a3', email: 'mayukh@example.com' },
  sabine: { id: '00000000-0000-4000-8000-0000000000a1', email: 'sabine@example.com' },
  outsider: { id: '00000000-0000-4000-8000-0000000000a4', email: 'outsider@example.com' },
  newbie: { id: '00000000-0000-4000-8000-0000000000a5', email: 'newbie@example.com' },
} satisfies Record<string, AuthUser>;
type UserName = keyof typeof USERS;

const seed = (): Partial<MemoryData> => ({
  users: Object.values(USERS),
  members: [
    { org_id: IDS.org, user_id: USERS.mayukh.id, role: 'admin' },
    { org_id: IDS.org, user_id: USERS.sabine.id, role: 'expert' },
    { org_id: IDS.otherOrg, user_id: USERS.outsider.id, role: 'admin' },
  ],
  experts: [{ id: IDS.expert, org_id: IDS.org, user_id: USERS.sabine.id, display_name: 'Sabine' }],
});

let store: ReturnType<typeof memoryStore>;
beforeEach(() => {
  store = memoryStore(seed());
});

async function assign(as: UserName, body: Record<string, unknown>) {
  const app = await buildTestApp({ store, verifyUser: async (jwt) => USERS[jwt as UserName] ?? null });
  return app.inject({
    method: 'POST',
    url: '/v1/people',
    headers: { authorization: `Bearer ${as}` },
    payload: { org_id: IDS.org, ...body },
  });
}

describe('POST /v1/people', () => {
  it('gives an existing account a role and a learner profile', async () => {
    const res = await assign('mayukh', { email: 'Newbie@Example.com', role: 'learner', display_name: 'Nina' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toMatchObject({ user_id: USERS.newbie.id, role: 'learner' });
    expect(store.data.members).toContainEqual({ org_id: IDS.org, user_id: USERS.newbie.id, role: 'learner' });
    expect(store.data.learners).toContainEqual(
      expect.objectContaining({ id: body.person_id, user_id: USERS.newbie.id, display_name: 'Nina' }),
    );
  });

  it('changes an existing role and reuses the profile row', async () => {
    const res = await assign('mayukh', { email: USERS.sabine.email, role: 'expert' });
    expect(res.json()).toMatchObject({ person_id: IDS.expert });
    expect(store.data.experts).toHaveLength(1);

    await assign('mayukh', { email: USERS.sabine.email, role: 'manager' });
    expect(store.data.members.find((m) => m.user_id === USERS.sabine.id)?.role).toBe('manager');
  });

  it('defaults the profile name to the email local part', async () => {
    await assign('mayukh', { email: USERS.newbie.email, role: 'expert' });
    expect(store.data.experts.find((e) => e.user_id === USERS.newbie.id)?.display_name).toBe('newbie');
  });

  it('gives admins and managers no profile row', async () => {
    const res = await assign('mayukh', { email: USERS.newbie.email, role: 'admin' });
    expect(res.json()).toMatchObject({ person_id: null, role: 'admin' });
    expect(store.data.experts).toHaveLength(1);
    expect(store.data.learners).toHaveLength(0);
  });

  it('answers 404 when no account has the email', async () => {
    const res = await assign('mayukh', { email: 'nobody@example.com', role: 'learner' });
    expect(res.statusCode).toBe(404);
    expect(res.json().message).toContain('No account with nobody@example.com');
  });

  it('only lets admins of that org assign roles', async () => {
    expect((await assign('sabine', { email: USERS.newbie.email, role: 'learner' })).statusCode).toBe(403);
    expect((await assign('outsider', { email: USERS.newbie.email, role: 'admin' })).statusCode).toBe(404);
    expect(store.data.members.some((m) => m.user_id === USERS.newbie.id)).toBe(false);
  });

  it("refuses to change the caller's own role", async () => {
    const res = await assign('mayukh', { email: USERS.mayukh.email, role: 'learner' });
    expect(res.statusCode).toBe(409);
    expect(store.data.members.find((m) => m.user_id === USERS.mayukh.id)?.role).toBe('admin');
  });

  it('rejects an unknown role and a missing token', async () => {
    expect((await assign('mayukh', { email: USERS.newbie.email, role: 'owner' })).statusCode).toBe(400);
    const app = await buildTestApp({ store });
    const res = await app.inject({ method: 'POST', url: '/v1/people', payload: { org_id: IDS.org } });
    expect(res.statusCode).toBe(401);
  });
});
