import { buildApp, type AppDeps } from '../src/app.js';
import { loadEnv, type Env } from '../src/env.js';
import { fakeBus, fakeVoice, memoryStore } from './fakes/index.js';

export const SECRETS = {
  internal: 'i'.repeat(64),
  session: 's'.repeat(64),
  tool: 't'.repeat(64),
};

export const RAW_ENV: Record<string, string> = {
  PORT: '8080',
  LOG_LEVEL: 'silent',
  REDIS_URL: 'redis://localhost:6379',
  SUPABASE_URL: 'https://example.supabase.co',
  SUPABASE_SERVICE_ROLE_KEY: 'service-role-key',
  SK_INTERNAL_TOKEN: SECRETS.internal,
  SK_SESSION_SECRET: SECRETS.session,
  SK_TOOL_SECRET: SECRETS.tool,
  PRESIDIO_ANALYZER_URL: 'http://localhost:5002',
  PRESIDIO_ANONYMIZER_URL: 'http://localhost:5001',
  VOICE_URL: 'http://localhost:8085',
  MEETBOT_URL: 'http://localhost:8086',
  MAPPER_URL: 'http://localhost:8083',
  TUTOR_URL: 'http://localhost:8084',
  BRAIN_URL: 'http://localhost:8082',
  CORS_ORIGIN: 'https://app.sidekik.live,http://localhost:5173',
  INGEST_URL: 'wss://ingest.sidekik.live',
};

export const testEnv = (overrides: Record<string, string> = {}): Env => loadEnv({ ...RAW_ENV, ...overrides });

export const VALID_JWT = 'valid.jwt.token';
export const TEST_USER = { id: '00000000-0000-4000-8000-000000000001', email: 'sabine@example.com' };

export function buildTestApp(overrides: Partial<AppDeps> = {}) {
  return buildApp({
    env: testEnv(),
    verifyUser: async (jwt) => (jwt === VALID_JWT ? TEST_USER : null),
    healthChecks: {},
    store: memoryStore(),
    voice: fakeVoice(),
    bus: fakeBus(),
    logger: false,
    ...overrides,
  });
}
