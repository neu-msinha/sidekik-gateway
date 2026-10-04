import { buildApp } from './app.js';
import { cachedVerifier, supabaseVerifier } from './auth.js';
import { createBus } from './contracts/index.js';
import { loadEnv } from './env.js';
import { createServiceLogger } from './logger.js';
import { redisHealth } from './redis-health.js';
import { httpHealth } from './routes/health.js';
import { supabaseBroadcaster } from './services/realtime.js';
import { presidioRedactor } from './services/redact.js';
import { httpMapperClient, httpMeetbotClient, httpTutorClient } from './services/upstreams.js';
import { httpVoiceClient } from './services/voice.js';
import { supabaseStore } from './store/supabase.js';
import { createSupabase, supabaseHealth } from './supabase.js';

const env = loadEnv();
const supabase = createSupabase(env);
const log = createServiceLogger(env.LOG_LEVEL);
const bus = createBus(env.REDIS_URL, 'gateway', { logger: log.child({ component: 'bus' }) });
const redis = redisHealth(env.REDIS_URL, log);

const app = await buildApp({
  env,
  verifyUser: cachedVerifier(supabaseVerifier(supabase)),
  store: supabaseStore(supabase),
  voice: httpVoiceClient({ baseUrl: env.VOICE_URL, internalToken: env.SK_INTERNAL_TOKEN }),
  tutor: httpTutorClient(env.TUTOR_URL, env.SK_INTERNAL_TOKEN),
  mapper: httpMapperClient(env.MAPPER_URL, env.SK_INTERNAL_TOKEN),
  meetbot: httpMeetbotClient(env.MEETBOT_URL, env.SK_INTERNAL_TOKEN),
  bus,
  broadcaster: supabaseBroadcaster(supabase),
  redactor: presidioRedactor({
    analyzerUrl: env.PRESIDIO_ANALYZER_URL,
    anonymizerUrl: env.PRESIDIO_ANONYMIZER_URL,
  }),
  healthChecks: {
    supabase: supabaseHealth(supabase),
    redis: redis.check,
    presidio_analyzer: httpHealth(new URL('/health', env.PRESIDIO_ANALYZER_URL).href),
    presidio_anonymizer: httpHealth(new URL('/health', env.PRESIDIO_ANONYMIZER_URL).href),
  },
  loggerInstance: log,
});
app.addHook('onClose', () => bus.close());
app.addHook('onClose', redis.close);

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, async () => {
    app.log.info({ signal }, 'shutting down');
    await app.close();
    process.exit(0);
  });
}

try {
  // Railway's private network is IPv6; `::` also accepts IPv4.
  await app.listen({ host: '::', port: env.PORT });
} catch (err) {
  app.log.fatal({ err }, 'failed to start');
  process.exit(1);
}
