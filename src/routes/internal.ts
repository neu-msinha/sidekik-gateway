import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { Redactor } from '../services/redact.js';

export type InternalRoutesOptions = { redactor: Redactor };

/** Service-to-service endpoints (DESIGN §6). All require X-Internal-Token. */
export const internalRoutes: FastifyPluginAsyncZod<InternalRoutesOptions> = async (app, opts) => {
  app.addHook('onRequest', app.requireInternal);

  // Used by voice for post-call webhook turns, which arrive unredacted.
  app.post(
    '/internal/redact',
    {
      schema: {
        body: z.object({ text: z.string().max(20_000), language: z.string().min(2).max(10).default('en') }),
      },
    },
    async (request) => {
      const result = await opts.redactor.redact(request.body.text, request.body.language);
      if (result.engine === 'fallback') {
        request.log.warn({ err: result.error }, 'presidio unavailable; text redacted with fallback patterns');
      }
      return { text: result.text };
    },
  );
};
