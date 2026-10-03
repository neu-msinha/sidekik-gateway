import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { InvoiceStateSchema } from '../contracts/index.js';
import { forbidden, HttpError, notFound } from '../errors.js';
import { annotate } from '../logging.js';
import type { MapperClient, MeetbotClient, TutorClient } from '../services/upstreams.js';
import type { Role, Store } from '../store/types.js';
import { sessionForUser, workmapForUser } from './access.js';

export type ProxyRoutesOptions = {
  store: Store;
  tutor: TutorClient;
  mapper: MapperClient;
  meetbot: MeetbotClient;
};

const CLIP_TTL_S = 600; // signed URLs live 10 minutes (ARCHITECTURE §6)
const CAN_PUBLISH: Role[] = ['admin', 'expert'];

const Uuid = z.string().uuid();

/** Public endpoints that forward to tutor, mapper and meetbot (DESIGN §2). */
export const proxyRoutes: FastifyPluginAsyncZod<ProxyRoutesOptions> = async (app, opts) => {
  const { store, tutor, mapper, meetbot } = opts;

  // MiniERP pre-save check: the page waits at most 300 ms, so tutor gets 250 ms.
  app.post(
    '/v1/sessions/:id/presave',
    {
      onRequest: app.requireUser,
      schema: { params: z.object({ id: Uuid }), body: z.object({ state: InvoiceStateSchema }) },
    },
    async (request) => {
      const session = await sessionForUser(store, request, request.params.id);
      if (session.ended_at) throw new HttpError(409, 'session_ended', 'Session has ended');
      // Guardrails apply to learners; the expert's own saves in a capture session are never blocked.
      if (session.kind !== 'tutor') return { allow: true };
      const result = await tutor.presave(session.id, request.body.state);
      request.log.info(
        { allow: result.allow, guardrail_id: result.guardrail_id },
        'presave checked',
      );
      return result;
    },
  );

  app.post(
    '/v1/sessions/:id/meeting-bot',
    {
      onRequest: app.requireUser,
      schema: { params: z.object({ id: Uuid }), body: z.object({ meeting_url: z.string().url() }) },
    },
    async (request, reply) => {
      const session = await sessionForUser(store, request, request.params.id);
      if (session.ended_at) throw new HttpError(409, 'session_ended', 'Session has ended');
      if (session.mode !== 'meeting') throw new HttpError(409, 'not_meeting_session', 'Session was not started in meeting mode');
      if (!session.consent_at) throw new HttpError(409, 'consent_required', 'Consent has not been recorded');
      const bot = await meetbot.createBot(session.id, request.body.meeting_url);
      request.log.info({ bot_id: bot.bot_id }, 'meeting bot requested');
      return reply.code(201).send(bot);
    },
  );

  app.post(
    '/v1/workmaps/:id/publish',
    { onRequest: app.requireUser, schema: { params: z.object({ id: Uuid }) } },
    async (request, reply) => {
      const { workmap, role } = await workmapForUser(store, request, request.params.id);
      if (!CAN_PUBLISH.includes(role)) throw forbidden(`Role ${role} cannot publish a Work Map`);
      const job = await mapper.publish(workmap.id);
      request.log.info({ job_id: job.job_id }, 'publish requested');
      return reply.code(202).send(job);
    },
  );

  app.get(
    '/v1/workmaps/:id/export',
    {
      onRequest: app.requireUser,
      schema: { params: z.object({ id: Uuid }), querystring: z.object({ format: z.enum(['agent']).default('agent') }) },
    },
    async (request, reply) => {
      const { workmap } = await workmapForUser(store, request, request.params.id);
      const file = await mapper.export(workmap.id, request.query.format);
      reply.header('content-type', file.contentType);
      if (file.disposition) reply.header('content-disposition', file.disposition);
      return reply.send(file.body);
    },
  );

  app.get(
    '/v1/workmaps/:id/steps/:step/clip',
    { onRequest: app.requireUser, schema: { params: z.object({ id: Uuid, step: Uuid }) } },
    async (request) => {
      const { workmap } = await workmapForUser(store, request, request.params.id);
      const path = await store.getStepClipPath(workmap.id, request.params.step);
      if (!path) throw notFound('No clip for this step');
      return { url: await store.signStorageUrl('captures', path, CLIP_TTL_S), expires_in: CLIP_TTL_S };
    },
  );

  // The Tutor Room's replay_moment client tool (sidekik-web DESIGN §5). Uses the user's JWT,
  // because the page can't hold the tool secret.
  app.get(
    '/v1/tools/expert_moment/:step_id',
    { onRequest: app.requireUser, schema: { params: z.object({ step_id: Uuid }) } },
    async (request) => {
      const org = await store.getStepOrg(request.params.step_id);
      if (!org || !(await store.getRole(org, request.user!.id))) throw notFound('Step not found');
      return tutor.tool('get_expert_moment', { step_id: request.params.step_id });
    },
  );
};

/**
 * ElevenLabs webhook tools (sidekik-voice DESIGN §3). Authenticated by `X-Sidekik-Tool-Secret`;
 * `session_id` comes from the agent's `{{session_id}}` dynamic variable. Extra fields pass through.
 */
export const toolRoutes: FastifyPluginAsyncZod<Pick<ProxyRoutesOptions, 'tutor' | 'mapper'>> = async (app, opts) => {
  app.addHook('onRequest', app.requireToolSecret);
  app.addHook('preHandler', async (request) => {
    const sessionId = (request.body as { session_id?: string } | undefined)?.session_id;
    if (sessionId) annotate(request, { session_id: sessionId });
  });

  app.post(
    '/v1/tools/recall_context',
    {
      schema: {
        body: z
          .object({ session_id: Uuid, query: z.string().min(1), scope: z.enum(['session', 'workflow']).default('session') })
          .passthrough(),
      },
    },
    async (request) => opts.mapper.recallContext(request.body),
  );

  app.post(
    '/v1/tools/check_guardrails',
    { schema: { body: z.object({ session_id: Uuid, state: InvoiceStateSchema.optional() }).passthrough() } },
    async (request) => opts.tutor.tool('check_guardrails', request.body),
  );

  app.post(
    '/v1/tools/get_step',
    { schema: { body: z.object({ session_id: Uuid, step_id: z.string().optional() }).passthrough() } },
    async (request) => opts.tutor.tool('get_step', request.body),
  );

  app.post(
    '/v1/tools/get_expert_moment',
    { schema: { body: z.object({ step_id: z.string().min(1), session_id: Uuid.optional() }).passthrough() } },
    async (request) => opts.tutor.tool('get_expert_moment', request.body),
  );
};
