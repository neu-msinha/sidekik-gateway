import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { httpVoiceClient, type VoiceTokenRequest } from '../src/services/voice.js';

const TOKEN = 'i'.repeat(64);
const req: VoiceTokenRequest = {
  agent: 'interviewer',
  phase: 'capture',
  session_id: 'sid-1',
  dynamic_variables: { expert_name: 'Sabine' },
  language: 'de',
};

let server: Server | undefined;
afterEach(() => new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve())));

async function voiceServer(handler: (req: IncomingMessage, body: string, res: ServerResponse) => void) {
  server = createServer((r, res) => {
    let body = '';
    r.on('data', (c) => (body += c)).on('end', () => handler(r, body, res));
  });
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${(server!.address() as AddressInfo).port}`;
}

describe('httpVoiceClient', () => {
  it('posts the request with X-Internal-Token and returns the token', async () => {
    let seen: { url?: string; token?: string | string[]; body?: unknown } = {};
    const baseUrl = await voiceServer((r, body, res) => {
      seen = { url: r.url, token: r.headers['x-internal-token'], body: JSON.parse(body) };
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ conversation_token: 'ct', agent_id: 'ag', extra: true }));
    });

    const out = await httpVoiceClient({ baseUrl, internalToken: TOKEN }).getToken(req);
    expect(out).toEqual({ conversation_token: 'ct', agent_id: 'ag' });
    expect(seen).toEqual({ url: '/internal/token', token: TOKEN, body: req });
  });

  it('maps a slow response to 504', async () => {
    const baseUrl = await voiceServer(() => {});
    await expect(httpVoiceClient({ baseUrl, internalToken: TOKEN, timeoutMs: 50 }).getToken(req)).rejects.toMatchObject({
      statusCode: 504,
      code: 'upstream_timeout',
    });
  });

  it('maps an upstream error to 502', async () => {
    const baseUrl = await voiceServer((_r, _b, res) => {
      res.statusCode = 500;
      res.end('{}');
    });
    await expect(httpVoiceClient({ baseUrl, internalToken: TOKEN }).getToken(req)).rejects.toMatchObject({
      statusCode: 502,
      code: 'upstream_error',
    });
  });

  it('maps an unexpected body to 502', async () => {
    const baseUrl = await voiceServer((_r, _b, res) => res.end(JSON.stringify({ token: 'x' })));
    await expect(httpVoiceClient({ baseUrl, internalToken: TOKEN }).getToken(req)).rejects.toMatchObject({
      statusCode: 502,
      code: 'upstream_bad_response',
    });
  });

  it('maps a refused connection to 502', async () => {
    await expect(
      httpVoiceClient({ baseUrl: 'http://127.0.0.1:9', internalToken: TOKEN }).getToken(req),
    ).rejects.toMatchObject({ statusCode: 502, code: 'upstream_unreachable' });
  });
});
