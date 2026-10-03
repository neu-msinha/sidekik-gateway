import { describe, expect, it } from 'vitest';
import type { Redactor } from '../src/services/redact.js';
import { SECRETS, buildTestApp } from './helpers.js';

const calls: { text: string; language: string }[] = [];
const redactor: Redactor = {
  async redact(text, language) {
    calls.push({ text, language });
    return { text: text.replace('Sabine', '<PERSON>'), engine: 'presidio', entities: ['PERSON'] };
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
});
