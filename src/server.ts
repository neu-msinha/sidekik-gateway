import { buildApp } from './app.js';
import { supabaseVerifier } from './auth.js';
import { loadEnv } from './env.js';
import { createSupabase, supabaseHealth } from './supabase.js';

const env = loadEnv();
const supabase = createSupabase(env);

const pretty = process.env.NODE_ENV !== 'production' && process.stdout.isTTY;

const app = await buildApp({
  env,
  verifyUser: supabaseVerifier(supabase),
  healthChecks: { supabase: supabaseHealth(supabase) },
  logger: {
    level: env.LOG_LEVEL,
    ...(pretty && { transport: { target: 'pino-pretty' } }),
  },
});

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
