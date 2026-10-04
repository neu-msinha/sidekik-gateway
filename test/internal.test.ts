import { describe, expect, it } from 'vitest';
import type { Redactor } from '../src/services/redact.js';
import { SECRETS, buildTestApp } from './helpers.js';

const calls: { text: string; language: string; keep?: readonly string[] }[] = [];
const redactor: Redactor = {
  async redact(text, language, keep) {
    calls.push({ text, language, ...(keep && { keep }) });
    if (text === 'presidio down') throw new Error('presidio /analyze: HTTP 503');
    return { text: text.replace('Sabine', '<PERSON>'), entities: ['PERSON'] };
  },
};

describe('POST /internal/redact', () => {
  it('requires X-Internal-Token', async () => {
    const app = await buildTestApp({ redactor });
    const res = await app.inject({ method: 'POST', url: '/internal/redact', payload: { text: 'x' } });
    expect(res.statusCode).toBe(401);
  });

  it('returns the redacted text, defaulting the language to en', async () => {
    const app = await buildTestApp({ redactor });
    const res = await app.inject({
      method: 'POST',
      url: '/internal/redact',
      headers: { 'x-internal-token': SECRETS.internal },
      payload: { text: 'Sabine approved it' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ text: '<PERSON> approved it' });
    expect(calls.at(-1)).toEqual({ text: 'Sabine approved it', language: 'en' });
  });

  it('passes the language through', async () => {
    const app = await buildTestApp({ redactor });
    await app.inject({
      method: 'POST',
      url: '/internal/redact',
      headers: { 'x-internal-token': SECRETS.internal },
      payload: { text: 'Sabine sagt nein', language: 'de' },
    });
    expect(calls.at(-1)).toEqual({ text: 'Sabine sagt nein', language: 'de' });
  });

  it("takes the platform's lang and keep fields", async () => {
    const app = await buildTestApp({ redactor });
    await app.inject({
      method: 'POST',
      url: '/internal/redact',
      headers: { 'x-internal-token': SECRETS.internal },
      payload: { text: 'Kranbau GmbH und Sabine', lang: 'de', keep: ['Kranbau GmbH'] },
    });
    expect(calls.at(-1)).toEqual({ text: 'Kranbau GmbH und Sabine', language: 'de', keep: ['Kranbau GmbH'] });
  });

  it('answers 503 instead of returning unredacted text when Presidio fails', async () => {
    const app = await buildTestApp({ redactor });
    const res = await app.inject({
      method: 'POST',
      url: '/internal/redact',
      headers: { 'x-internal-token': SECRETS.internal },
      payload: { text: 'presidio down' },
    });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ error: 'redaction_unavailable', message: 'Presidio is unavailable; the text was not redacted' });
  });
});
