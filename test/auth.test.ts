import { describe, expect, it } from 'vitest';
import { SECRETS, TEST_USER, VALID_JWT, buildTestApp } from './helpers.js';

async function appWithProtectedRoutes() {
  const app = await buildTestApp();
  app.get('/user-only', { preHandler: app.requireUser }, async (req) => ({ user: req.user }));
  app.post('/internal/ping', { preHandler: app.requireInternal }, async () => ({ ok: true }));
  app.post('/v1/tools/ping', { preHandler: app.requireToolSecret }, async () => ({ ok: true }));
  return app;
}

describe('requireUser (Supabase JWT)', () => {
  it('rejects a request without a bearer token', async () => {
    const app = await appWithProtectedRoutes();
    const res = await app.inject({ method: 'GET', url: '/user-only' });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: 'unauthorized', message: 'Missing bearer token' });
  });

  it('rejects an invalid token', async () => {
    const app = await appWithProtectedRoutes();
    const res = await app.inject({
      method: 'GET',
      url: '/user-only',
      headers: { authorization: 'Bearer nope' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('attaches the user for a valid token', async () => {
    const app = await appWithProtectedRoutes();
    const res = await app.inject({
      method: 'GET',
      url: '/user-only',
      headers: { authorization: `Bearer ${VALID_JWT}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ user: TEST_USER });
  });
});

describe('requireInternal (X-Internal-Token)', () => {
  it.each([
    ['missing', {}],
    ['wrong', { 'x-internal-token': 'wrong' }],
    ['tool secret instead', { 'x-internal-token': SECRETS.tool }],
  ])('rejects a %s token', async (_label, headers) => {
    const app = await appWithProtectedRoutes();
    const res = await app.inject({ method: 'POST', url: '/internal/ping', headers });
    expect(res.statusCode).toBe(401);
  });

  it('accepts the shared token', async () => {
    const app = await appWithProtectedRoutes();
    const res = await app.inject({
      method: 'POST',
      url: '/internal/ping',
      headers: { 'x-internal-token': SECRETS.internal },
    });
    expect(res.statusCode).toBe(200);
  });
});

describe('requireToolSecret (X-Sidekik-Tool-Secret)', () => {
  it('rejects the internal token', async () => {
    const app = await appWithProtectedRoutes();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/tools/ping',
      headers: { 'x-sidekik-tool-secret': SECRETS.internal },
    });
    expect(res.statusCode).toBe(401);
  });

  it('accepts the tool secret', async () => {
    const app = await appWithProtectedRoutes();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/tools/ping',
      headers: { 'x-sidekik-tool-secret': SECRETS.tool },
    });
    expect(res.statusCode).toBe(200);
  });
});
