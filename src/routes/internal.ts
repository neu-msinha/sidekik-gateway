import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { RedactRequestSchema } from '../contracts/index.js';
import { HttpError, notFound } from '../errors.js';
import { annotate } from '../logging.js';
import type { OffRecordController } from '../services/off-record.js';
import type { PhaseService } from '../services/phase.js';
import type { Redactor } from '../services/redact.js';
import type { Store } from '../store/types.js';
import { offRecordBody } from './off-record-body.js';

export type InternalRoutesOptions = {
  redactor: Redactor;
  store: Store;
  offRecord: OffRecordController;
  phase: PhaseService;
};

/** Service-to-service endpoints (DESIGN §6). All require X-Internal-Token. */
export const internalRoutes: FastifyPluginAsyncZod<InternalRoutesOptions> = async (app, opts) => {
  app.addHook('onRequest', app.requireInternal);

  // Used by voice for post-call webhook turns, which arrive unredacted. Fails closed: when
  // Presidio is down the caller gets 503 and must not keep or forward the text.
  app.post(
    '/internal/redact',
    {
      schema: {
        // RedactRequestSchema (sidekik-platform api.ts); `language` is the field's old name, still accepted.
        body: RedactRequestSchema.extend({
          text: z.string().max(20_000),
          keep: z.array(z.string()).max(20).optional(),
          language: z.string().min(2).max(10).optional(),
        }),
      },
    },
    async (request) => {
      const { text, lang, language, keep } = request.body;
      try {
        const result = await opts.redactor.redact(text, lang ?? language ?? 'en', keep);
        return { text: result.text };
      } catch (err) {
        request.log.error({ err: err instanceof Error ? err.message : String(err) }, 'redaction failed');
        throw new HttpError(503, 'redaction_unavailable', 'Presidio is unavailable; the text was not redacted');
      }
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
      annotate(request, { session_id: session.id, org_id: session.org_id });
      if (session.ended_at) throw new HttpError(409, 'session_ended', 'Session has ended');
      return opts.offRecord.set(session, request.body, request.log);
    },
  );

  // Mapper drives the debrief and confirms the Work Map (DESIGN §5). Budget: 1 s.
  app.post(
    '/internal/sessions/:id/phase',
    {
      schema: {
        params: z.object({ id: z.string().uuid() }),
        body: z.discriminatedUnion('phase', [
          z.object({ phase: z.literal('debrief'), dynamic_variables: z.record(z.string(), z.string()).default({}) }),
          z.object({ phase: z.literal('confirmed') }),
        ]),
      },
    },
    async (request) => {
      const session = await opts.store.getSession(request.params.id);
      if (!session) throw notFound('Session not found');
      annotate(request, { session_id: session.id, org_id: session.org_id });
      const body = request.body;
      return body.phase === 'debrief'
        ? opts.phase.debrief(session, body.dynamic_variables, request.log)
        : opts.phase.confirmed(session, request.log);
    },
  );
};
