import { buildApp } from './app.js';
import { supabaseVerifier } from './auth.js';
import { createBus } from './contracts/index.js';
import { loadEnv } from './env.js';
import { httpVoiceClient } from './services/voice.js';
import { supabaseStore } from './store/supabase.js';
import { createSupabase, supabaseHealth } from './supabase.js';

const env = loadEnv();
const supabase = createSupabase(env);
const bus = createBus(env.REDIS_URL, 'gateway');

const pretty = process.env.NODE_ENV !== 'production' && process.stdout.isTTY;

const app = await buildApp({
  env,
  verifyUser: supabaseVerifier(supabase),
  store: supabaseStore(supabase),
  voice: httpVoiceClient({ baseUrl: env.VOICE_URL, internalToken: env.SK_INTERNAL_TOKEN }),
  bus,
  healthChecks: {
    supabase: supabaseHealth(supabase),
    redis: async () => {
      await bus.redis.ping();
    },
  },
  logger: {
    level: env.LOG_LEVEL,
    ...(pretty && { transport: { target: 'pino-pretty' } }),
  },
});
app.addHook('onClose', () => bus.close());
// ioredis reconnects on its own; log instead of crashing on an unhandled 'error' event.
bus.redis.on('error', (err) => app.log.warn({ err: err.message }, 'redis error'));

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
