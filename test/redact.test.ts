import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { fallbackRedact, presidioRedactor } from '../src/services/redact.js';

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

describe('presidioRedactor', () => {
  it('anonymizes findings but keeps allow-listed business identifiers', async () => {
    const text = 'Sabine booked #4471 from 4711 to 0400 for DE01, call +49 711 1234567.';
    const { calls, redactor } = await fakePresidio({
      findings: (t) => [
        span(t, 'Sabine', 'PERSON'),
        span(t, '#4471', 'PHONE_NUMBER'),
        span(t, '4711', 'PHONE_NUMBER'),
        span(t, '0400', 'US_BANK_NUMBER'),
        span(t, 'DE01', 'LOCATION'),
        span(t, '+49 711 1234567', 'PHONE_NUMBER'),
      ],
    });

    const out = await redactor.redact(text, 'de');
    expect(out).toEqual({
      text: '<PERSON> booked #4471 from 4711 to 0400 for DE01, call <PHONE_NUMBER>.',
      engine: 'presidio',
      entities: ['PERSON', 'PHONE_NUMBER'],
    });
    expect(calls[0]).toEqual({ path: '/analyze', body: { text, language: 'de' } });
    expect(calls[1]!.body.analyzer_results).toHaveLength(2);
  });

  it('skips the anonymizer when nothing is found', async () => {
    const { calls, redactor } = await fakePresidio({ findings: () => [] });
    const out = await redactor.redact('Recode it to 0400.', 'en');
    expect(out).toEqual({ text: 'Recode it to 0400.', engine: 'presidio', entities: [] });
    expect(calls.map((c) => c.path)).toEqual(['/analyze']);
  });

  it('falls back to regex patterns when the analyzer fails', async () => {
    const { redactor } = await fakePresidio({ analyzeStatus: 500 });
    const out = await redactor.redact('Mail sabine@maschinenbau.de about 4711', 'de');
    expect(out).toMatchObject({ text: 'Mail <EMAIL_ADDRESS> about 4711', engine: 'fallback', entities: ['EMAIL_ADDRESS'] });
    expect(out.error).toMatch(/returned 500/);
  });

  it('falls back when the anonymizer times out', async () => {
    const { redactor } = await fakePresidio({ findings: (t) => [span(t, 'Sabine', 'PERSON')], hangAnonymize: true });
    const out = await redactor.redact('Sabine said so', 'en');
    expect(out.engine).toBe('fallback');
    expect(out.error).toMatch(/timed out/);
  });

  it('falls back when Presidio is unreachable', async () => {
    const redactor = presidioRedactor({ analyzerUrl: 'http://127.0.0.1:9', anonymizerUrl: 'http://127.0.0.1:9' });
    expect((await redactor.redact('IBAN DE89 3704 0044 0532 0130 00', 'en')).text).toBe('IBAN <IBAN_CODE>');
  });
});

describe('fallbackRedact', () => {
  it.each([
    ['email', 'write to lena.k@example.com today', 'write to <EMAIL_ADDRESS> today'],
    ['IBAN with spaces', 'pay DE89 3704 0044 0532 0130 00 now', 'pay <IBAN_CODE> now'],
    ['IBAN compact', 'pay DE89370400440532013000 now', 'pay <IBAN_CODE> now'],
    ['German VAT id', 'USt-IdNr DE123456789', 'USt-IdNr <VAT_ID>'],
    ['Czech VAT id', 'DIČ CZ12345678', 'DIČ <VAT_ID>'],
    ['international phone', 'ring +49 711 123 4567', 'ring <PHONE_NUMBER>'],
  ])('redacts %s', (_label, input, expected) => {
    expect(fallbackRedact(input).text).toBe(expected);
  });

  it('keeps cost centers, invoice ids, company codes and amounts', () => {
    const text = 'Invoice #4510 for €7,200 on 4711 in DE01 should go to 0400, CZ01 needs approval.';
    expect(fallbackRedact(text)).toEqual({ text, engine: 'fallback', entities: [] });
  });
});
