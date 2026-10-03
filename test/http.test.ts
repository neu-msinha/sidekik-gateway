import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { buildTestApp } from './helpers.js';

describe('request validation', () => {
  it('returns 400 with zod issues for an invalid body', async () => {
    const app = await buildTestApp();
    app.post(
      '/echo',
      { schema: { body: z.object({ kind: z.enum(['capture', 'tutor']), language: z.string().min(2) }) } },
      async (req) => req.body,
    );

    const bad = await app.inject({ method: 'POST', url: '/echo', payload: { kind: 'other' } });
    expect(bad.statusCode).toBe(400);
    const body = bad.json();
    expect(body.error).toBe('bad_request');
    expect(body.issues.map((i: { path: string }) => i.path)).toEqual(expect.arrayContaining(['/kind', '/language']));

    const good = await app.inject({ method: 'POST', url: '/echo', payload: { kind: 'tutor', language: 'en' } });
    expect(good.statusCode).toBe(200);
    expect(good.json()).toEqual({ kind: 'tutor', language: 'en' });
  });

  it('hides internal error details', async () => {
    const app = await buildTestApp();
    app.get('/boom', async () => {
      throw new Error('db password is hunter2');
    });
    const res = await app.inject({ method: 'GET', url: '/boom' });
    expect(res.statusCode).toBe(500);
    expect(res.json()).toEqual({ error: 'internal_error', message: 'Internal Server Error' });
  });

  it('uses the same error shape for unknown routes', async () => {
    const app = await buildTestApp();
    const res = await app.inject({ method: 'GET', url: '/nope' });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: 'not_found', message: 'Route GET /nope not found' });
  });
});

describe('JSON bodies', () => {
  async function appWithRoutes() {
    const app = await buildTestApp();
    app.post('/no-body', async (req) => ({ body: req.body ?? null }));
    app.post('/needs-body', { schema: { body: z.object({ a: z.number() }) } }, async (req) => req.body);
    return app;
  }

  it('accepts content-type: application/json with an empty body', async () => {
    const app = await appWithRoutes();
    const res = await app.inject({ method: 'POST', url: '/no-body', headers: { 'content-type': 'application/json' } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ body: null });
  });

  it('still validates routes that require a body', async () => {
    const app = await appWithRoutes();
    const res = await app.inject({ method: 'POST', url: '/needs-body', headers: { 'content-type': 'application/json' } });
    expect(res.statusCode).toBe(400);
  });

  it('rejects malformed JSON with the standard error shape', async () => {
    const app = await appWithRoutes();
    const res = await app.inject({
      method: 'POST',
      url: '/no-body',
      headers: { 'content-type': 'application/json' },
      payload: '{nope',
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: 'bad_request', message: 'Body is not valid JSON' });
  });
});

describe('CORS', () => {
  it('allows the web app origin', async () => {
    const app = await buildTestApp();
    const res = await app.inject({
      method: 'OPTIONS',
      url: '/healthz',
      headers: { origin: 'https://app.sidekik.live', 'access-control-request-method': 'POST' },
    });
    expect(res.headers['access-control-allow-origin']).toBe('https://app.sidekik.live');
  });

  it('does not allow an unknown origin', async () => {
    const app = await buildTestApp();
    const res = await app.inject({
      method: 'OPTIONS',
      url: '/healthz',
      headers: { origin: 'https://evil.example', 'access-control-request-method': 'POST' },
    });
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });
});
