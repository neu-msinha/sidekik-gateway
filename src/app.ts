import Fastify, { LogController, type FastifyBaseLogger, type FastifyError, type FastifyServerOptions } from 'fastify';
import cors from '@fastify/cors';
import rateLimit, { type RateLimitPluginOptions } from '@fastify/rate-limit';
import websocket from '@fastify/websocket';
import {
  hasZodFastifySchemaValidationErrors,
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from 'fastify-type-provider-zod';
import type { Env } from './env.js';
import { requireSharedSecret, requireUser, type VerifyUser } from './auth.js';
import { STREAMS, type AgentCommand, type Bus, type UsageRecord, type WorkMapPublished } from './contracts/index.js';
import { HttpError } from './errors.js';
import { genReqId, registerRequestLogging } from './logging.js';
import { rateLimitOptions } from './rate-limit.js';
import { healthRoutes, type HealthCheck } from './routes/health.js';
import { agentHostRoutes } from './routes/agent-host.js';
import { costRoutes } from './routes/costs.js';
import { replayRoutes } from './routes/replay.js';
import { internalRoutes } from './routes/internal.js';
import { proxyRoutes, toolRoutes } from './routes/proxies.js';
import { sessionRoutes } from './routes/sessions.js';
import { wsClientRoutes } from './routes/ws-client.js';
import { createCostLedger } from './services/costs.js';
import { createCurrentWorkMapUpdater } from './services/current-workmap.js';
import { createEgress } from './services/egress.js';
import { createOffRecordController, OffRecordState } from './services/off-record.js';
import { createPhaseService } from './services/phase.js';
import { createReplay, RECORDED_STREAMS, RECORDER_GROUP } from './services/replay.js';
import { ScreenContext } from './services/screen-context.js';
import type { Broadcaster } from './services/realtime.js';
import type { Redactor } from './services/redact.js';
import type { MapperClient, MeetbotClient, TutorClient } from './services/upstreams.js';
import type { VoiceClient } from './services/voice.js';
import type { SessionRow, Store } from './store/types.js';
import { VERSION } from './version.js';

export type AppDeps = {
  env: Env;
  verifyUser: VerifyUser;
  healthChecks: Record<string, HealthCheck>;
  store: Store;
  voice: VoiceClient;
  tutor: TutorClient;
  mapper: MapperClient;
  meetbot: MeetbotClient;
  bus: Bus;
  redactor: Redactor;
  broadcaster: Broadcaster;
  offRecord?: OffRecordState;
  /** The service's shared pino logger (server, dev:mock); tests pass `logger` options instead. */
  loggerInstance?: FastifyBaseLogger;
  logger?: FastifyServerOptions['logger'];
  /** Overrides for the per-user rate limit (tests); defaults to 20 req/s. */
  rateLimit?: Partial<RateLimitPluginOptions>;
};

export async function buildApp(deps: AppDeps) {
  const { env } = deps;
  const offRecord = deps.offRecord ?? new OffRecordState();
  const screen = new ScreenContext();

  const logger = deps.logger ?? { level: env.LOG_LEVEL };
  const app = Fastify({
    ...(deps.loggerInstance
      ? { loggerInstance: deps.loggerInstance }
      : {
          // Every line names the service and version; Railway shows all services in one stream.
          logger:
            typeof logger === 'object'
              ? { ...logger, base: { service: 'sidekik-gateway', version: VERSION, pid: process.pid } }
              : logger,
        }),
    // registerRequestLogging writes one line per request instead of Fastify's two.
    logController: new LogController({ disableRequestLogging: true, requestIdLogLabel: 'req_id' }),
    genReqId,
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

  registerRequestLogging(app);
  await app.register(rateLimit, rateLimitOptions(deps.rateLimit));
  app.addHook('onRequest', app.rateLimit());
  await app.register(websocket, { options: { maxPayload: 64 * 1024 } });

  app.decorate('requireUser', requireUser(deps.verifyUser));
  app.decorate('requireInternal', requireSharedSecret('x-internal-token', env.SK_INTERNAL_TOKEN));
  app.decorate('requireToolSecret', requireSharedSecret('x-sidekik-tool-secret', env.SK_TOOL_SECRET));

  /** Releases per-session state once a session (or a replay) is over. */
  const cleanupSession = async (session: SessionRow) => {
    egress.forget(session.id);
    phase.forget(session.id);
    offRecord.forget(session.id);
    screen.forget(session.id);
    if (session.mode === 'meeting') {
      await deps.meetbot.removeBot(session.id).catch((err) =>
        app.log.warn({ err, session_id: session.id, org_id: session.org_id }, 'meeting bot removal failed'),
      );
    }
    await deps.broadcaster.release(session.id);
  };

  const replay = createReplay({
    store: deps.store,
    bus: deps.bus,
    offRecord,
    log: app.log.child({ component: 'replay' }),
    onFinished: cleanupSession,
  });
  const egress = createEgress({
    broadcaster: deps.broadcaster,
    offRecord,
    store: deps.store,
    log: app.log.child({ component: 'egress' }),
    onSent: (ev) => replay.record(STREAMS.commands, ev),
  });
  const phase = createPhaseService({
    store: deps.store,
    bus: deps.bus,
    voice: deps.voice,
    broadcaster: deps.broadcaster,
    offRecord,
  });
  const offRecordController = createOffRecordController({
    store: deps.store,
    bus: deps.bus,
    broadcaster: deps.broadcaster,
    state: offRecord,
    onBackOnRecord: (session, log) => phase.resumeAfterOffRecord(session, log),
  });
  const recordUsage = createCostLedger({ store: deps.store, log: app.log.child({ component: 'cost_ledger' }) });
  const setCurrentWorkMap = createCurrentWorkMapUpdater({ store: deps.store, log: app.log.child({ component: 'current_workmap' }) });

  // Bus consumers start once the app is ready and stop when it closes.
  const stops: (() => void)[] = [];
  app.addHook('onReady', async () => {
    stops.push(
      deps.bus.consume(STREAMS.commands, async (ev) => {
        await egress.handle(ev);
      }),
      deps.bus.consume(STREAMS.usage, recordUsage),
      deps.bus.consume(STREAMS.workmapPublished, setCurrentWorkMap),
      // Meeting mode sends no DOM events: the supplier on screen comes from perception instead.
      deps.bus.consume(STREAMS.screen, async (ev) => screen.update(ev.session_id, ev.data.state.record?.supplier)),
      ...RECORDED_STREAMS.map((stream) =>
        deps.bus.consume(
          stream,
          async (ev) => {
            await replay.record(stream, ev);
          },
          { group: RECORDER_GROUP },
        ),
      ),
    );
  });
  app.addHook('onClose', async () => {
    for (const stop of stops.splice(0)) stop();
    replay.stopAll();
    await deps.broadcaster.close();
  });

  await app.register(healthRoutes, { version: VERSION, checks: deps.healthChecks });
  await app.register(sessionRoutes, {
    store: deps.store,
    voice: deps.voice,
    bus: deps.bus,
    sessionSecret: env.SK_SESSION_SECRET,
    ingestUrl: env.INGEST_URL,
    offRecord: offRecordController,
    phase,
    onEnded: cleanupSession,
  });
  await app.register(wsClientRoutes, {
    store: deps.store,
    bus: deps.bus,
    redactor: deps.redactor,
    screen,
    offRecord,
    onConnect: (sessionId) => deps.broadcaster.warm(sessionId),
    sessionSecret: env.SK_SESSION_SECRET,
  });
  await app.register(internalRoutes, {
    redactor: deps.redactor,
    store: deps.store,
    offRecord: offRecordController,
    phase,
  });
  await app.register(proxyRoutes, { store: deps.store, tutor: deps.tutor, mapper: deps.mapper, meetbot: deps.meetbot });
  await app.register(toolRoutes, { tutor: deps.tutor, mapper: deps.mapper });
  await app.register(costRoutes, { store: deps.store });
  await app.register(replayRoutes, { store: deps.store, replay, sessionSecret: env.SK_SESSION_SECRET });
  await app.register(agentHostRoutes, { store: deps.store, voice: deps.voice, sessionSecret: env.SK_SESSION_SECRET });

  return app;
}

export type App = Awaited<ReturnType<typeof buildApp>>;
