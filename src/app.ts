import Fastify, { type FastifyError, type FastifyServerOptions } from 'fastify';
import cors from '@fastify/cors';
import websocket from '@fastify/websocket';
import {
  hasZodFastifySchemaValidationErrors,
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from 'fastify-type-provider-zod';
import type { Env } from './env.js';
import { requireSharedSecret, requireUser, type VerifyUser } from './auth.js';
import { STREAMS, type AgentCommand, type Bus } from './contracts/index.js';
import { HttpError } from './errors.js';
import { healthRoutes, type HealthCheck } from './routes/health.js';
import { internalRoutes } from './routes/internal.js';
import { sessionRoutes } from './routes/sessions.js';
import { wsClientRoutes } from './routes/ws-client.js';
import { createEgress } from './services/egress.js';
import { OffRecordState } from './services/off-record.js';
import type { Broadcaster } from './services/realtime.js';
import type { Redactor } from './services/redact.js';
import type { VoiceClient } from './services/voice.js';
import type { Store } from './store/types.js';
import { VERSION } from './version.js';

export type AppDeps = {
  env: Env;
  verifyUser: VerifyUser;
  healthChecks: Record<string, HealthCheck>;
  store: Store;
  voice: VoiceClient;
  bus: Bus;
  redactor: Redactor;
  broadcaster: Broadcaster;
  offRecord?: OffRecordState;
  logger?: FastifyServerOptions['logger'];
};

export async function buildApp(deps: AppDeps) {
  const { env } = deps;
  const offRecord = deps.offRecord ?? new OffRecordState();

  const app = Fastify({
    logger: deps.logger ?? { level: env.LOG_LEVEL },
    // Cloudflare → Railway: trust X-Forwarded-* for client IPs.
    trustProxy: true,
  }).withTypeProvider<ZodTypeProvider>();

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  app.setErrorHandler<FastifyError>((err, request, reply) => {
    if (hasZodFastifySchemaValidationErrors(err)) {
      return reply.code(400).send({
        error: 'bad_request',
        message: 'Request validation failed',
        issues: err.validation.map((v) => ({ path: v.instancePath, message: v.message })),
      });
    }
    if (err instanceof HttpError) {
      return reply.code(err.statusCode).send({ error: err.code, message: err.message });
    }
    const status = err.statusCode ?? 500;
    if (status >= 500) {
      request.log.error({ err }, 'unhandled error');
      return reply.code(500).send({ error: 'internal_error', message: 'Internal Server Error' });
    }
    return reply.code(status).send({ error: err.code ?? 'error', message: err.message });
  });

  // Browsers often send `content-type: application/json` with no body (e.g. POST /end);
  // Fastify rejects that by default, so treat an empty JSON body as no body.
  app.removeContentTypeParser('application/json');
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (_request, body, done) => {
    if (body === '') return done(null, undefined);
    try {
      done(null, JSON.parse(body as string));
    } catch {
      done(new HttpError(400, 'bad_request', 'Body is not valid JSON'), undefined);
    }
  });

  app.setNotFoundHandler((request, reply) =>
    reply.code(404).send({ error: 'not_found', message: `Route ${request.method} ${request.url} not found` }),
  );

  await app.register(cors, {
    origin: env.CORS_ORIGIN,
    credentials: true,
  });

  await app.register(websocket, { options: { maxPayload: 64 * 1024 } });

  app.decorate('requireUser', requireUser(deps.verifyUser));
  app.decorate('requireInternal', requireSharedSecret('x-internal-token', env.SK_INTERNAL_TOKEN));
  app.decorate('requireToolSecret', requireSharedSecret('x-sidekik-tool-secret', env.SK_TOOL_SECRET));

  const egress = createEgress({
    broadcaster: deps.broadcaster,
    offRecord,
    store: deps.store,
    log: app.log.child({ component: 'egress' }),
  });
  let stopEgress: (() => void) | undefined;
  app.addHook('onReady', async () => {
    stopEgress = deps.bus.consume<AgentCommand>(STREAMS.commands, async (ev) => {
      await egress.handle(ev);
    });
  });
  app.addHook('onClose', async () => {
    stopEgress?.();
    await deps.broadcaster.close();
  });

  await app.register(healthRoutes, { version: VERSION, checks: deps.healthChecks });
  await app.register(sessionRoutes, {
    store: deps.store,
    voice: deps.voice,
    bus: deps.bus,
    sessionSecret: env.SK_SESSION_SECRET,
    ingestUrl: env.INGEST_URL,
    onEnded: async (sessionId) => {
      egress.forget(sessionId);
      offRecord.forget(sessionId);
      await deps.broadcaster.release(sessionId);
    },
  });
  await app.register(wsClientRoutes, {
    store: deps.store,
    bus: deps.bus,
    redactor: deps.redactor,
    offRecord,
    onConnect: (sessionId) => deps.broadcaster.warm(sessionId),
    sessionSecret: env.SK_SESSION_SECRET,
  });
  await app.register(internalRoutes, { redactor: deps.redactor });

  return app;
}

export type App = Awaited<ReturnType<typeof buildApp>>;
