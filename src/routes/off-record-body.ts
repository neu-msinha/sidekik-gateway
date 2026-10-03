import { z } from 'zod';

/** Body of both off-record endpoints: `{on, source?, back_s?}` (DESIGN §4). */
export function offRecordBody<const S extends readonly [string, ...string[]]>(sources: S, defaultSource: S[number]) {
  return z
    .object({
      on: z.boolean(),
      source: z.enum(sources).default(defaultSource as never),
      // Retroactive window in seconds; the spec's example is 60.
      back_s: z.number().int().min(1).max(300).optional(),
    })
    .refine((b) => b.on || b.back_s === undefined, {
      message: 'back_s is only allowed with on: true',
      path: ['back_s'],
    });
}
