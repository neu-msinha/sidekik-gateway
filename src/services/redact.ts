import { redact } from '../contracts/index.js';

export type RedactResult = {
  text: string;
  /** Entity types that were replaced, e.g. ["PERSON", "IBAN_CODE"]. */
  entities: string[];
};

export interface Redactor {
  /**
   * Redacts PII. `keep` lists business names Presidio must not tag (the supplier on screen).
   * Throws when Presidio fails: callers must not pass unredacted text on (fail closed).
   */
  redact(text: string, language: string, keep?: readonly string[]): Promise<RedactResult>;
}

/**
 * sidekik-platform's `redact()` (DESIGN §4, docs v0.3): analyzer → anonymizer with the platform's
 * entities (PERSON only for NER) and business allow-list, language mapped to de/en.
 */
export function presidioRedactor(opts: { analyzerUrl: string; anonymizerUrl: string; timeoutMs?: number }): Redactor {
  return {
    async redact(text, language, keep = []) {
      const { text: out, findings } = await redact(text, language, {
        analyzerUrl: opts.analyzerUrl,
        anonymizerUrl: opts.anonymizerUrl,
        timeoutMs: opts.timeoutMs ?? 300,
        keep,
      });
      return { text: out, entities: [...new Set(findings.map((f) => f.entity_type))] };
    },
  };
}
