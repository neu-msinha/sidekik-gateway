import { describe, expect, it } from 'vitest';
import { VERSION } from '../src/version.js';
import { buildTestApp } from './helpers.js';

describe('GET /healthz', () => {
  it('returns ok with version and deps when every check passes', async () => {
    const app = await buildTestApp({ healthChecks: { supabase: async () => {} } });
    const res = await app.inject({ method: 'GET', url: '/healthz' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, version: VERSION, deps: { supabase: true } });
  });

  it('returns 503 and marks the failing dep', async () => {
    const app = await buildTestApp({
      healthChecks: {
        supabase: async () => {},
        redis: async () => {
          throw new Error('ECONNREFUSED');
        },
      },
    });
    const res = await app.inject({ method: 'GET', url: '/healthz' });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({ ok: false, deps: { supabase: true, redis: false } });
  });

  it('treats a hanging check as down', async () => {
    const app = await buildTestApp({ healthChecks: { slow: () => new Promise(() => {}) } });
    const res = await app.inject({ method: 'GET', url: '/healthz' });
    expect(res.statusCode).toBe(503);
    expect(res.json().deps).toEqual({ slow: false });
  }, 3000);
});
