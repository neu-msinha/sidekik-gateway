// `pnpm dev:mock`: the gateway against real Redis (and Presidio, if running) with no teammates'
// services and no Supabase. Data lives in memory; Realtime broadcasts are printed instead of sent.
// Feed it commands with `pnpm dev:replay dev/fixtures/capture-commands.jsonl`.
import { buildApp } from '../app.js';
import type { AuthUser } from '../auth.js';
import { createBus, signSessionToken } from '../contracts/index.js';
import { loadEnv } from '../env.js';
import { presidioRedactor } from '../services/redact.js';
import type { Broadcaster } from '../services/realtime.js';
import { memoryStore } from '../store/memory.js';

export const MOCK = {
  org: '00000000-0000-4000-8000-00000000a001',
  workflow: '00000000-0000-4000-8000-00000000b001',
  workmap: '00000000-0000-4000-8000-00000000c001',
  session: '00000000-0000-4000-8000-00000000d001',
  tutorSession: '00000000-0000-4000-8000-00000000d002',
  expert: '00000000-0000-4000-8000-00000000e001',
  learner: '00000000-0000-4000-8000-00000000f001',
};

// Bearer tokens accepted by the mock: `Authorization: Bearer dev-sabine`.
const USERS: Record<string, AuthUser> = {
  'dev-sabine': { id: '00000000-0000-4000-8000-0000000000a1', email: 'sabine@maschinenbau.example' },
  'dev-lena': { id: '00000000-0000-4000-8000-0000000000a2', email: 'lena@maschinenbau.example' },
  'dev-admin': { id: '00000000-0000-4000-8000-0000000000a3', email: 'admin@maschinenbau.example' },
};

const DEV_SECRET = 'dev-mock-secret-not-for-production-0000000000';
const env = loadEnv({
  REDIS_URL: 'redis://localhost:6379',
  SUPABASE_URL: 'http://localhost:54321',
  SUPABASE_SERVICE_ROLE_KEY: 'unused-in-mock',
  SK_INTERNAL_TOKEN: DEV_SECRET,
  SK_SESSION_SECRET: DEV_SECRET,
  SK_TOOL_SECRET: DEV_SECRET,
  PRESIDIO_ANALYZER_URL: 'http://localhost:5002',
  PRESIDIO_ANONYMIZER_URL: 'http://localhost:5001',
  VOICE_URL: 'http://localhost:8085',
  MEETBOT_URL: 'http://localhost:8086',
  MAPPER_URL: 'http://localhost:8083',
  TUTOR_URL: 'http://localhost:8084',
  BRAIN_URL: 'http://localhost:8082',
  INGEST_URL: 'ws://localhost:8081',
  CORS_ORIGIN: 'http://localhost:5173',
  LOG_LEVEL: 'info',
  ...process.env,
});

const now = new Date().toISOString();
const store = memoryStore({
  workflows: [{ id: MOCK.workflow, org_id: MOCK.org, name: 'Supplier invoice coding', current_workmap_id: MOCK.workmap }],
  members: [
    { org_id: MOCK.org, user_id: USERS['dev-sabine']!.id, role: 'expert' },
    { org_id: MOCK.org, user_id: USERS['dev-lena']!.id, role: 'learner' },
    { org_id: MOCK.org, user_id: USERS['dev-admin']!.id, role: 'admin' },
  ],
  experts: [{ id: MOCK.expert, org_id: MOCK.org, user_id: USERS['dev-sabine']!.id, display_name: 'Sabine' }],
  learners: [{ id: MOCK.learner, org_id: MOCK.org, user_id: USERS['dev-lena']!.id, display_name: 'Lena' }],
  workmaps: [{ id: MOCK.workmap, org_id: MOCK.org, workflow_id: MOCK.workflow, expert_id: MOCK.expert }],
  // A consented capture session, so replayed fixtures and /ws/client work without any setup.
  sessions: [
    {
      id: MOCK.session,
      org_id: MOCK.org,
      workflow_id: MOCK.workflow,
      kind: 'capture',
      mode: 'browser',
      phase: 'capture',
      expert_id: MOCK.expert,
      learner_id: null,
      workmap_id: null,
      language: 'de',
      el_agent_id: 'mock-interviewer',
      off_record: false,
      consent_at: now,
      started_at: now,
      ended_at: null,
    },
    {
      id: MOCK.tutorSession,
      org_id: MOCK.org,
      workflow_id: MOCK.workflow,
      kind: 'tutor',
      mode: 'browser',
      phase: 'tutoring',
      expert_id: null,
      learner_id: MOCK.learner,
      workmap_id: MOCK.workmap,
      language: 'en',
      el_agent_id: 'mock-tutor',
      off_record: false,
      consent_at: now,
      started_at: now,
      ended_at: null,
    },
  ],
});

let app: Awaited<ReturnType<typeof buildApp>>;

const printBroadcaster: Broadcaster = {
  async send(sessionId, cmd) {
    app.log.info({ session_id: sessionId, channel: `session:${sessionId}`, payload: cmd }, `realtime cmd → ${cmd.type}`);
  },
  warm() {},
  async release() {},
  async close() {},
};

const bus = createBus(env.REDIS_URL, 'gateway', {
  warn: (obj, msg) => app.log.warn(obj, msg),
  error: (obj, msg) => app.log.error(obj, msg),
});

app = await buildApp({
  env,
  verifyUser: async (jwt) => USERS[jwt] ?? null,
  store,
  voice: {
    async getToken(req) {
      return { conversation_token: `mock-conversation-token-${req.session_id}`, agent_id: `mock-${req.agent}` };
    },
  },
  // Teammates' services, stubbed. Presave applies demo guardrail G1 so the H18 catch can be tried here.
  tutor: {
    async presave(sessionId, state) {
      const g1 = (state.net_amount ?? 0) > 5000 && state.category === 'equipment' && state.cost_center !== '0400';
      app.log.info({ session_id: sessionId, state, allow: !g1 }, 'mock tutor presave');
      return g1
        ? { allow: false, guardrail_id: 'G1', quote: 'Equipment over €5,000 is always capex.', step_id: 'S4' }
        : { allow: true };
    },
    async tool(name, body) {
      app.log.info({ tool: name, body }, 'mock tutor tool');
      return { mock: true, tool: name };
    },
  },
  mapper: {
    async publish(id) {
      return { job_id: `mock-job-${id}` };
    },
    async export(id) {
      return {
        contentType: 'text/markdown',
        disposition: `attachment; filename="AGENT_RULES-${id}.md"`,
        body: Buffer.from('# Agent rules (mock)\n- G1: Equipment over €5,000 is always capex.\n'),
      };
    },
    async recallContext() {
      return { snippets: [{ text: 'Über 5.000 immer 0400.', t_ms: 192000, source: 'turn' }] };
    },
  },
  meetbot: {
    async createBot(sessionId) {
      return { bot_id: `mock-bot-${sessionId}` };
    },
    async removeBot() {},
  },
  bus,
  broadcaster: printBroadcaster,
  redactor: presidioRedactor({ analyzerUrl: env.PRESIDIO_ANALYZER_URL, anonymizerUrl: env.PRESIDIO_ANONYMIZER_URL }),
  healthChecks: { redis: async () => void (await bus.redis.ping()) },
  logger: { level: env.LOG_LEVEL, transport: { target: 'pino-pretty' } },
});
app.addHook('onClose', () => bus.close());
bus.redis.on('error', (err) => app.log.warn({ err: err.message }, 'redis error'));

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, async () => {
    await app.close();
    process.exit(0);
  });
}

await app.listen({ host: '::', port: env.PORT });

const skToken = await signSessionToken(
  { sid: MOCK.session, org: MOCK.org, role: 'expert', kind: 'capture' },
  env.SK_SESSION_SECRET,
);
app.log.info(
  {
    session_id: MOCK.session,
    tutor_session_id: MOCK.tutorSession,
    ws_client: `ws://localhost:${env.PORT}/ws/client/${MOCK.session}?t=${skToken}`,
    bearer_tokens: Object.keys(USERS),
    internal_token: env.SK_INTERNAL_TOKEN,
  },
  'mock gateway ready',
);
