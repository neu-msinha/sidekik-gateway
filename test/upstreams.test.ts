import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { cachedVerifier } from '../src/auth.js';
import { httpMapperClient, httpMeetbotClient, httpTutorClient } from '../src/services/upstreams.js';

const TOKEN = 'i'.repeat(64);
type Seen = { method: string; url: string; token?: string; body?: unknown };

let server: Server | undefined;
afterEach(() => new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve())));

/** Records each request and answers with `reply(req)`: [status, headers, body]. */
async function upstream(reply: (s: Seen) => [number, Record<string, string>, string]) {
  const seen: Seen[] = [];
  server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c)).on('end', () => {
      const s: Seen = {
        method: req.method!,
        url: req.url!,
        token: req.headers['x-internal-token'] as string | undefined,
        ...(raw && { body: JSON.parse(raw) }),
      };
      seen.push(s);
      const [status, headers, body] = reply(s);
      res.writeHead(status, headers).end(body);
    });
  });
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
  return { seen, url: `http://127.0.0.1:${(server!.address() as AddressInfo).port}` };
}

const json = (body: unknown): [number, Record<string, string>, string] => [
  200,
  { 'content-type': 'application/json' },
  JSON.stringify(body),
];

describe('httpTutorClient', () => {
  it('calls /internal/presave and the tool endpoints with the internal token', async () => {
    const { seen, url } = await upstream((s) => (s.url === '/internal/presave' ? json({ allow: true }) : json({ ok: 1 })));
    const tutor = httpTutorClient(url, TOKEN);
    expect(await tutor.presave('sid', { net_amount: 7200 })).toEqual({ allow: true });
    expect(await tutor.tool('get_step', { session_id: 'sid' })).toEqual({ ok: 1 });
    expect(seen).toEqual([
      { method: 'POST', url: '/internal/presave', token: TOKEN, body: { session_id: 'sid', state: { net_amount: 7200 } } },
      { method: 'POST', url: '/internal/tools/get_step', token: TOKEN, body: { session_id: 'sid' } },
    ]);
  });

  it('times out presave after 250 ms', async () => {
    server = createServer(() => {});
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
    const tutor = httpTutorClient(`http://127.0.0.1:${(server.address() as AddressInfo).port}`, TOKEN);
    const started = Date.now();
    await expect(tutor.presave('sid', {})).rejects.toMatchObject({ statusCode: 504 });
    expect(Date.now() - started).toBeLessThan(600);
  });
});

describe('httpMapperClient', () => {
  it('publishes, exports raw files and passes 404s through', async () => {
    const { seen, url } = await upstream((s) => {
      if (s.url.includes('missing')) return [404, {}, '{}'];
      if (s.url.includes('/export')) {
        return [200, { 'content-type': 'application/zip', 'content-disposition': 'attachment; filename="r.zip"' }, 'ZIP'];
      }
      return json({ job_id: 'j1' });
    });
    const mapper = httpMapperClient(url, TOKEN);

    expect(await mapper.publish('wm1')).toEqual({ job_id: 'j1' });
    const file = await mapper.export('wm1', 'agent');
    expect(file).toEqual({ contentType: 'application/zip', disposition: 'attachment; filename="r.zip"', body: Buffer.from('ZIP') });
    await expect(mapper.export('missing', 'agent')).rejects.toMatchObject({ statusCode: 404 });
    expect(seen.slice(0, 2).map((s) => `${s.method} ${s.url}`)).toEqual([
      'POST /internal/workmaps/wm1/publish',
      'GET /internal/workmaps/wm1/export?format=agent',
    ]);
  });
});

describe('httpMeetbotClient', () => {
  it('creates and removes bots', async () => {
    const { seen, url } = await upstream((s) => (s.method === 'POST' ? json({ bot_id: 'b1' }) : [204, {}, '']));
    const meetbot = httpMeetbotClient(url, TOKEN);
    expect(await meetbot.createBot('sid', 'https://meet.google.com/x')).toEqual({ bot_id: 'b1' });
    await meetbot.removeBot('sid');
    expect(seen).toEqual([
      {
        method: 'POST',
        url: '/internal/bots',
        token: TOKEN,
        body: { session_id: 'sid', meeting_url: 'https://meet.google.com/x', bot_name: 'Sidekik (recording)' },
      },
      { method: 'DELETE', url: '/internal/bots/sid', token: TOKEN },
    ]);
  });
});

describe('cachedVerifier', () => {
  const jwt = (exp: number) =>
    `h.${Buffer.from(JSON.stringify({ exp })).toString('base64url')}.s`;

  it('caches successful verifications, not failures', async () => {
    let calls = 0;
    let clock = 1_000_000;
    const verify = cachedVerifier(
      async (t) => {
        calls++;
        return t.startsWith('h.') ? { id: 'u1' } : null;
      },
      { ttlMs: 60_000, now: () => clock },
    );
    const good = jwt(clock / 1000 + 3600);

    expect(await verify(good)).toEqual({ id: 'u1' });
    expect(await verify(good)).toEqual({ id: 'u1' });
    expect(calls).toBe(1);

    expect(await verify('bad')).toBeNull();
    expect(await verify('bad')).toBeNull();
    expect(calls).toBe(3);

    clock += 61_000;
    await verify(good);
    expect(calls).toBe(4);
  });

  it("never caches past the token's own expiry", async () => {
    let calls = 0;
    let clock = 1_000_000;
    const verify = cachedVerifier(
      async () => {
        calls++;
        return { id: 'u1' };
      },
      { ttlMs: 60_000, now: () => clock },
    );
    const soon = jwt(clock / 1000 + 5);
    await verify(soon);
    clock += 6_000;
    await verify(soon);
    expect(calls).toBe(2);
  });
});
