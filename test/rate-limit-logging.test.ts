import { Writable } from 'node:stream';
import type { InjectOptions } from 'fastify';
import { describe, expect, it } from 'vitest';
import { signSessionToken } from '../src/contracts/index.js';
import type { SessionRow } from '../src/store/types.js';
import { VERSION } from '../src/version.js';
import { IDS, memoryStore } from './fakes/index.js';
import { SECRETS, TEST_USER, VALID_JWT, buildTestApp } from './helpers.js';

const SID = '60000000-0000-4000-8000-000000000001';

const session = (): SessionRow => ({
  id: SID,
  org_id: IDS.org,
  workflow_id: IDS.workflow,
  kind: 'capture',
  mode: 'browser',
  phase: 'capture',
  expert_id: null,
  learner_id: null,
  workmap_id: null,
  language: 'de',
  el_agent_id: null,
  off_record: false,
  consent_at: new Date().toISOString(),
  started_at: new Date().toISOString(),
  ended_at: null,
});

const user = { authorization: `Bearer ${VALID_JWT}` };

describe('rate limiting (20 req/s per user)', () => {
  async function burst(n: number, opts: InjectOptions) {
    const app = await buildTestApp();
    await app.ready();
    const res = [];
    for (let i = 0; i < n; i++) res.push(await app.inject(opts));
    return { app, statuses: res.map((r) => r.statusCode), last: res.at(-1)! };
  }

  it('returns 429 with the standard error shape on the 21st request in a second', async () => {
    const { statuses, last } = await burst(21, { method: 'GET', url: `/v1/costs/${SID}`, headers: user });
    expect(statuses.slice(0, 20).every((s) => s !== 429)).toBe(true);
    expect(statuses[20]).toBe(429);
    expect(last.json()).toEqual({ error: 'rate_limited', message: expect.stringMatching(/^Rate limit of 20 requests/) });
    expect(last.headers['retry-after']).toBeDefined();
    expect(last.headers['x-ratelimit-limit']).toBe('20');
  });

  it('counts each user (access token) separately', async () => {
    const app = await buildTestApp({ verifyUser: async (t) => ({ id: t }) });
    await app.ready();
    for (let i = 0; i < 20; i++) {
      await app.inject({ method: 'GET', url: `/v1/costs/${SID}`, headers: { authorization: 'Bearer user-a' } });
    }
    const a = await app.inject({ method: 'GET', url: `/v1/costs/${SID}`, headers: { authorization: 'Bearer user-a' } });
    const b = await app.inject({ method: 'GET', url: `/v1/costs/${SID}`, headers: { authorization: 'Bearer user-b' } });
    expect(a.statusCode).toBe(429);
    expect(b.statusCode).not.toBe(429);
  });

  it('limits before authentication, so bad tokens are throttled too', async () => {
    const { statuses } = await burst(21, { method: 'GET', url: `/v1/costs/${SID}`, headers: { authorization: 'Bearer bad' } });
    expect(statuses.slice(0, 20).every((s) => s === 401)).toBe(true);
    expect(statuses[20]).toBe(429);
  });

  it('limits unauthenticated calls by IP', async () => {
    const { statuses } = await burst(21, { method: 'POST', url: '/v1/agent-host/claim', payload: { t: 'x'.repeat(43) } });
    expect(statuses[20]).toBe(429);
  });

  it.each([
    ['health checks', { method: 'GET' as const, url: '/healthz' }],
    ['internal calls', { method: 'POST' as const, url: '/internal/redact', headers: { 'x-internal-token': SECRETS.internal }, payload: { text: 'x' } }],
    ['webhook tools', { method: 'POST' as const, url: '/v1/tools/get_step', headers: { 'x-sidekik-tool-secret': SECRETS.tool }, payload: { session_id: SID } }],
  ])('does not limit %s', async (_label, opts) => {
    const { statuses } = await burst(30, opts);
    expect(statuses).not.toContain(429);
  });
});

describe('structured request logging', () => {
  async function appWithLogs() {
    const lines: Record<string, unknown>[] = [];
    const raw: string[] = [];
    const stream = new Writable({
      write(chunk, _enc, cb) {
        for (const l of chunk.toString().split('\n').filter(Boolean)) {
          raw.push(l);
          lines.push(JSON.parse(l));
        }
        cb();
      },
    });
    const store = memoryStore({
      sessions: [session()],
      members: [{ org_id: IDS.org, user_id: TEST_USER.id, role: 'expert' }],
    });
    // Not readied here: a test may still add routes. inject() readies the app itself.
    const app = await buildTestApp({ store, logger: { level: 'info', stream } });
    return { app, lines, raw };
  }

  it('writes one line per request with session, org, user, route and latency', async () => {
    const { app, lines } = await appWithLogs();
    await app.inject({
      method: 'POST',
      url: `/v1/sessions/${SID}/consent`,
      headers: user,
      payload: { text_version: 'v1', scopes: ['audio'] },
    });
    const done = lines.find((l) => l.msg === 'request completed')!;
    expect(done).toMatchObject({
      service: 'sidekik-gateway',
      version: VERSION,
      req_id: expect.any(String),
      session_id: SID,
      org_id: IDS.org,
      user_id: TEST_USER.id,
      method: 'POST',
      route: '/v1/sessions/:id/consent',
      path: `/v1/sessions/${SID}/consent`,
      status: 200,
      latency_ms: expect.any(Number),
    });
    // Handler lines of the same request carry the same fields.
    expect(lines.find((l) => l.msg === 'consent recorded')).toMatchObject({ session_id: SID, org_id: IDS.org });
  });

  it('never logs tokens from query strings', async () => {
    const { app, raw } = await appWithLogs();
    const t = signSessionToken({ sid: SID, org: IDS.org, role: 'expert', kind: 'capture' }, SECRETS.session);
    await app.ready();
    const ws = await app.injectWS(`/ws/client/${SID}?t=${t}`);
    ws.terminate();
    await app.inject({ method: 'GET', url: `/ws/client/${SID}?t=${t}` });
    await app.inject({ method: 'POST', url: '/v1/agent-host/claim', payload: { t: 'secret-one-time-token-123' } });
    expect(raw.length).toBeGreaterThan(0);
    expect(raw.some((l) => l.includes(t))).toBe(false);
    expect(raw.some((l) => l.includes('secret-one-time-token-123'))).toBe(false);
    expect(raw.some((l) => l.includes('?t='))).toBe(false);
  });

  it('logs server errors at error level', async () => {
    const { app, lines } = await appWithLogs();
    app.get('/v1/boom', async () => {
      throw new Error('kaput');
    });
    await app.inject({ method: 'GET', url: '/v1/boom', headers: user });
    expect(lines.find((l) => l.msg === 'request failed')).toMatchObject({ level: 50, status: 500 });
  });
});

describe('x-request-id', () => {
  it('echoes a valid caller id and replaces an invalid one', async () => {
    const app = await buildTestApp();
    const given = await app.inject({ method: 'GET', url: '/healthz', headers: { 'x-request-id': 'web-7f3a9c21' } });
    expect(given.headers['x-request-id']).toBe('web-7f3a9c21');
    const bad = await app.inject({ method: 'GET', url: '/healthz', headers: { 'x-request-id': 'no spaces allowed!' } });
    expect(bad.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
    const none = await app.inject({ method: 'GET', url: '/healthz' });
    expect(none.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
  });
});
