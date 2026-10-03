import { z } from 'zod';
import { postJson } from './internal-http.js';

export type RedactResult = {
  text: string;
  /** `fallback` means Presidio failed and only the regex patterns below were applied. */
  engine: 'presidio' | 'fallback';
  /** Entity types that were replaced, e.g. ["PERSON", "IBAN_CODE"]. */
  entities: string[];
  /** Why Presidio was skipped, when engine is `fallback`. */
  error?: string;
};

export interface Redactor {
  redact(text: string, language: string): Promise<RedactResult>;
}

/**
 * Business identifiers the demo depends on. Presidio can flag them as phone or ID numbers,
 * so any finding whose matched text is one of these is kept as-is.
 */
export const ALLOW_LIST: RegExp[] = [
  /^\d{4}$/, // cost centers: 4711, 0400
  /^#?\d{4,5}$/, // invoice ids: #4471
  /^[A-Z]{2}\d{2}$/, // company codes: DE01, CZ01
];

const AnalyzerResults = z.array(
  z.object({ entity_type: z.string(), start: z.number(), end: z.number(), score: z.number() }).passthrough(),
);
const AnonymizerResponse = z.object({ text: z.string() });

export function presidioRedactor(opts: { analyzerUrl: string; anonymizerUrl: string; timeoutMs?: number }): Redactor {
  const timeoutMs = opts.timeoutMs ?? 300;
  return {
    async redact(text, language) {
      if (!text.trim()) return { text, engine: 'presidio', entities: [] };
      try {
        const findings = await postJson(
          new URL('/analyze', opts.analyzerUrl).href,
          { text, language },
          AnalyzerResults,
          { timeoutMs },
        );
        const kept = findings.filter((f) => !isAllowed(text.slice(f.start, f.end)));
        if (kept.length === 0) return { text, engine: 'presidio', entities: [] };

        // No `anonymizers` given: Presidio's default replaces each finding with <ENTITY_TYPE>.
        const out = await postJson(
          new URL('/anonymize', opts.anonymizerUrl).href,
          { text, analyzer_results: kept },
          AnonymizerResponse,
          { timeoutMs },
        );
        return { text: out.text, engine: 'presidio', entities: unique(kept.map((f) => f.entity_type)) };
      } catch (err) {
        return { ...fallbackRedact(text), error: err instanceof Error ? err.message : String(err) };
      }
    },
  };
}

const isAllowed = (s: string) => ALLOW_LIST.some((re) => re.test(s.trim()));
const unique = (xs: string[]) => [...new Set(xs)];

// Order matters: IBANs before phone numbers, which would otherwise eat their digits.
const FALLBACK_PATTERNS: [entity: string, re: RegExp][] = [
  ['EMAIL_ADDRESS', /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g],
  ['IBAN_CODE', /\b[A-Z]{2}\d{2}(?: ?[A-Z0-9]{4}){2,7}(?: ?[A-Z0-9]{1,4})?\b/g],
  ['VAT_ID', /\b(?:DE\d{9}|CZ\d{8,10})\b/g],
  ['PHONE_NUMBER', /(?:\+|\b00)\d[\d \/-]{7,}\d\b/g],
];

/**
 * Used only when Presidio is unreachable, so a turn is never published unredacted.
 * Catches structured identifiers; it cannot catch names.
 */
export function fallbackRedact(text: string): RedactResult {
  const entities: string[] = [];
  let out = text;
  for (const [entity, re] of FALLBACK_PATTERNS) {
    out = out.replace(re, (match) => {
      if (isAllowed(match)) return match;
      entities.push(entity);
      return `<${entity}>`;
    });
  }
  return { text: out, engine: 'fallback', entities: unique(entities) };
}
