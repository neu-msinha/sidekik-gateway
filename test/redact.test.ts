import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { analyzeRequest } from '../src/contracts/index.js';
import { presidioRedactor } from '../src/services/redact.js';

type Finding = { entity_type: string; start: number; end: number; score: number };

let server: Server | undefined;
afterEach(() => new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve())));

/** Fake Presidio: /analyze returns `findings`, /anonymize replaces each result with <ENTITY_TYPE>. */
async function fakePresidio(opts: { findings?: (text: string) => Finding[]; analyzeStatus?: number; hangAnonymize?: boolean }) {
  const calls: { path: string; body: any }[] = [];
  server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c)).on('end', () => {
      const body = JSON.parse(raw);
      calls.push({ path: req.url!, body });
      res.setHeader('content-type', 'application/json');
      if (req.url === '/analyze') {
        res.statusCode = opts.analyzeStatus ?? 200;
        return res.end(JSON.stringify(opts.findings?.(body.text) ?? []));
      }
      if (opts.hangAnonymize) return;
      const sorted = [...body.analyzer_results].sort((a: Finding, b: Finding) => b.start - a.start);
      let text: string = body.text;
      for (const r of sorted) text = text.slice(0, r.start) + `<${r.entity_type}>` + text.slice(r.end);
      res.end(JSON.stringify({ text, items: [] }));
    });
  });
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(server!.address() as AddressInfo).port}`;
  return { calls, redactor: presidioRedactor({ analyzerUrl: url, anonymizerUrl: url, timeoutMs: 100 }) };
}

const span = (text: string, needle: string, entity_type: string): Finding => {
  const start = text.indexOf(needle);
  return { entity_type, start, end: start + needle.length, score: 0.85 };
};

describe('presidioRedactor (sidekik-platform redact())', () => {
  it("sends the platform's analyze request: mapped language, entities, allow-list with the supplier kept", async () => {
    const text = 'Präzisionswerk Ulm schickt die Rechnung, Sabine bucht sie.';
    const { calls, redactor } = await fakePresidio({ findings: (t) => [span(t, 'Sabine', 'PERSON')] });
    await redactor.redact(text, 'de-DE', ['Präzisionswerk Ulm']);
    expect(calls[0]).toEqual({ path: '/analyze', body: JSON.parse(JSON.stringify(analyzeRequest(text, 'de-DE', ['Präzisionswerk Ulm']))) });
    expect(calls[0]!.body.language).toBe('de');
    expect(calls[0]!.body.allow_list.some((p: string) => new RegExp(p).test('Präzisionswerk Ulm'))).toBe(true);
  });

  it('anonymizes what the analyzer found and names each entity once', async () => {
    const text = 'Sabine and Jürgen, call +49 711 1234567.';
    const { calls, redactor } = await fakePresidio({
      findings: (t) => [span(t, 'Sabine', 'PERSON'), span(t, 'Jürgen', 'PERSON'), span(t, '+49 711 1234567', 'PHONE_NUMBER')],
    });
    expect(await redactor.redact(text, 'en')).toEqual({
      text: '<PERSON> and <PERSON>, call <PHONE_NUMBER>.',
      entities: ['PERSON', 'PHONE_NUMBER'],
    });
    expect(calls[1]).toMatchObject({ path: '/anonymize', body: { anonymizers: { DEFAULT: { type: 'replace' } } } });
  });

  it('skips the anonymizer when nothing is found', async () => {
    const { calls, redactor } = await fakePresidio({ findings: () => [] });
    expect(await redactor.redact('Recode it to 0400.', 'en')).toEqual({ text: 'Recode it to 0400.', entities: [] });
    expect(calls.map((c) => c.path)).toEqual(['/analyze']);
  });

  it('throws when Presidio fails, so callers drop the text (fail closed)', async () => {
    const failing = await fakePresidio({ analyzeStatus: 500 });
    await expect(failing.redactor.redact('Sabine', 'de')).rejects.toThrow(/HTTP 500/);
    await new Promise<void>((resolve) => server!.close(() => resolve()));

    const hanging = await fakePresidio({ findings: (t) => [span(t, 'Sabine', 'PERSON')], hangAnonymize: true });
    await expect(hanging.redactor.redact('Sabine', 'de')).rejects.toThrow();

    const unreachable = presidioRedactor({ analyzerUrl: 'http://127.0.0.1:9', anonymizerUrl: 'http://127.0.0.1:9' });
    await expect(unreachable.redact('Sabine', 'de')).rejects.toThrow();
  });
});
