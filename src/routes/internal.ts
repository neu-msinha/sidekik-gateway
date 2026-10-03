import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { HttpError, notFound } from '../errors.js';
import type { OffRecordController } from '../services/off-record.js';
import type { Redactor } from '../services/redact.js';
import type { Store } from '../store/types.js';
import { offRecordBody } from './off-record-body.js';

export type InternalRoutesOptions = { redactor: Redactor; store: Store; offRecord: OffRecordController };

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

  // Brain D7 (budget 200 ms) and meetbot's /off and /on chat commands.
  app.post(
    '/internal/sessions/:id/off-record',
    {
      schema: {
        params: z.object({ id: z.string().uuid() }),
        body: offRecordBody(['brain', 'chat'], 'brain'),
      },
    },
    async (request) => {
      const session = await opts.store.getSession(request.params.id);
      if (!session) throw notFound('Session not found');
      if (session.ended_at) throw new HttpError(409, 'session_ended', 'Session has ended');
      return opts.offRecord.set(session, request.body, request.log);
    },
  );
};
