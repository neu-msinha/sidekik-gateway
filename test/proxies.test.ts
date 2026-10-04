import { beforeEach, describe, expect, it } from 'vitest';
import { verifySessionToken } from '../src/contracts/index.js';
import { HttpError } from '../src/errors.js';
import type { SessionRow } from '../src/store/types.js';
import { IDS, fakeMapper, fakeMeetbot, fakeTutor, fakeVoice, memoryStore } from './fakes/index.js';
import { SECRETS, TEST_USER, VALID_JWT, buildTestApp } from './helpers.js';

const CAPTURE = '60000000-0000-4000-8000-000000000001';
const TUTOR = '60000000-0000-4000-8000-000000000002';
const MEETING = '60000000-0000-4000-8000-000000000003';
const STEP = '70000000-0000-4000-8000-000000000001';
const OTHER_STEP = '70000000-0000-4000-8000-000000000002';
const OTHER_WORKMAP = '30000000-0000-4000-8000-000000000099';

const row = (id: string, over: Partial<SessionRow> = {}): SessionRow => ({
  id,
  org_id: IDS.org,
  workflow_id: IDS.workflow,
  kind: 'capture',
  mode: 'browser',
  phase: 'capture',
  expert_id: IDS.expert,
  learner_id: null,
  workmap_id: null,
  language: 'de',
  el_agent_id: null,
  off_record: false,
  consent_at: new Date().toISOString(),
  started_at: new Date().toISOString(),
  ended_at: null,
  ...over,
});

let store: ReturnType<typeof memoryStore>;
let tutor: ReturnType<typeof fakeTutor>;
let mapper: ReturnType<typeof fakeMapper>;
let meetbot: ReturnType<typeof fakeMeetbot>;
let voice: ReturnType<typeof fakeVoice>;

beforeEach(() => {
  store = memoryStore({
    sessions: [
      row(CAPTURE),
      row(TUTOR, { kind: 'tutor', phase: 'tutoring', expert_id: null, learner_id: IDS.learner, workmap_id: IDS.workmap, language: 'en' }),
      row(MEETING, { mode: 'meeting' }),
    ],
    members: [{ org_id: IDS.org, user_id: TEST_USER.id, role: 'expert' }],
    workflows: [{ id: IDS.workflow, org_id: IDS.org, name: 'Supplier invoice coding', current_workmap_id: IDS.workmap }],
    experts: [{ id: IDS.expert, org_id: IDS.org, user_id: TEST_USER.id, display_name: 'Sabine' }],
    learners: [{ id: IDS.learner, org_id: IDS.org, user_id: null, display_name: 'Lena' }],
    workmaps: [
      { id: IDS.workmap, org_id: IDS.org, workflow_id: IDS.workflow, expert_id: IDS.expert },
      { id: OTHER_WORKMAP, org_id: IDS.otherOrg, workflow_id: IDS.otherWorkflow, expert_id: IDS.expert },
    ],
    steps: [
      { id: STEP, work_map_id: IDS.workmap, org_id: IDS.org },
      { id: OTHER_STEP, work_map_id: OTHER_WORKMAP, org_id: IDS.otherOrg },
    ],
    clips: [
      { step_id: STEP, storage_path: 'captures/org/o/sessions/s/clips/old.mp4', created_at: '2026-10-03T10:00:00Z' },
      { step_id: STEP, storage_path: 'captures/org/o/sessions/s/clips/new.mp4', created_at: '2026-10-03T11:00:00Z' },
    ],
  });
  tutor = fakeTutor();
  mapper = fakeMapper();
  meetbot = fakeMeetbot();
  voice = fakeVoice();
});

const app = async () => {
  const a = await buildTestApp({ store, tutor, mapper, meetbot, voice });
  await a.ready();
  return a;
};
const user = { authorization: `Bearer ${VALID_JWT}` };
const tool = { 'x-sidekik-tool-secret': SECRETS.tool };
const internal = { 'x-internal-token': SECRETS.internal };

async function call(method: 'GET' | 'POST', url: string, headers: Record<string, string> = user, payload?: object) {
  return (await app()).inject({ method, url, headers, ...(payload && { payload }) });
}

const g1State = { invoice_id: '4510', net_amount: 7200, category: 'equipment', cost_center: '4711', supplier_known: false };

describe('POST /v1/sessions/:id/presave', () => {
  it('asks tutor for a tutor session and returns its verdict', async () => {
    tutor.presaveResult = { allow: false, guardrail_id: 'G1', quote: 'Equipment over €5,000 is always capex.', step_id: 'S4', field: 'cost_center' };
    const res = await call('POST', `/v1/sessions/${TUTOR}/presave`, user, { state: g1State });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual(tutor.presaveResult);
    expect(tutor.presaves).toEqual([{ sessionId: TUTOR, state: g1State }]);
  });

  it('always allows the expert in a capture session, without calling tutor', async () => {
    const res = await call('POST', `/v1/sessions/${CAPTURE}/presave`, user, { state: g1State });
    expect(res.json()).toEqual({ allow: true });
    expect(tutor.presaves).toHaveLength(0);
  });

  it('surfaces a tutor timeout as 504', async () => {
    tutor.fail = new HttpError(504, 'upstream_timeout', '/internal/presave timed out after 250 ms');
    expect((await call('POST', `/v1/sessions/${TUTOR}/presave`, user, { state: g1State })).statusCode).toBe(504);
  });

  it('validates the invoice state and the caller', async () => {
    expect((await call('POST', `/v1/sessions/${TUTOR}/presave`, user, { state: { net_amount: '7200' } })).statusCode).toBe(400);
    expect((await call('POST', `/v1/sessions/${TUTOR}/presave`, {}, { state: g1State })).statusCode).toBe(401);
    store.data.members = [];
    expect((await call('POST', `/v1/sessions/${TUTOR}/presave`, user, { state: g1State })).statusCode).toBe(404);
  });
});

describe('POST /v1/sessions/:id/meeting-bot', () => {
  const url = 'https://meet.google.com/abc-defg-hij';

  it('asks meetbot to join for a consented meeting session', async () => {
    const res = await call('POST', `/v1/sessions/${MEETING}/meeting-bot`, user, { meeting_url: url });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toEqual({ bot_id: `bot-${MEETING}` });
    expect(meetbot.created).toEqual([{ sessionId: MEETING, meetingUrl: url }]);
  });

  it('refuses browser sessions and sessions without consent', async () => {
    expect((await call('POST', `/v1/sessions/${CAPTURE}/meeting-bot`, user, { meeting_url: url })).json().error).toBe(
      'not_meeting_session',
    );
    store.data.sessions[2]!.consent_at = null;
    expect((await call('POST', `/v1/sessions/${MEETING}/meeting-bot`, user, { meeting_url: url })).json().error).toBe(
      'consent_required',
    );
    expect(meetbot.created).toHaveLength(0);
  });

  it('rejects a malformed meeting URL', async () => {
    expect((await call('POST', `/v1/sessions/${MEETING}/meeting-bot`, user, { meeting_url: 'not a url' })).statusCode).toBe(400);
  });
});

describe('POST /v1/sessions/:id/end with a meeting bot', () => {
  it('removes the bot for a meeting session', async () => {
    await call('POST', `/v1/sessions/${MEETING}/end`);
    expect(meetbot.removed).toEqual([MEETING]);
  });

  it('does not call meetbot for a browser session', async () => {
    await call('POST', `/v1/sessions/${CAPTURE}/end`);
    expect(meetbot.removed).toHaveLength(0);
  });

  it('still ends the session when meetbot fails', async () => {
    meetbot.fail = new Error('meetbot down');
    const res = await call('POST', `/v1/sessions/${MEETING}/end`);
    expect(res.statusCode).toBe(200);
    expect(store.data.sessions[2]!.ended_at).not.toBeNull();
  });
});

describe('Work Map proxies', () => {
  it('publishes as an expert and returns the job', async () => {
    const res = await call('POST', `/v1/workmaps/${IDS.workmap}/publish`);
    expect(res.statusCode).toBe(202);
    expect(res.json()).toEqual({ job_id: `job-${IDS.workmap}` });
  });

  it('does not let a learner publish', async () => {
    store.data.members[0]!.role = 'learner';
    expect((await call('POST', `/v1/workmaps/${IDS.workmap}/publish`)).statusCode).toBe(403);
    expect(mapper.calls).toHaveLength(0);
  });

  it('hides Work Maps of other orgs', async () => {
    expect((await call('POST', `/v1/workmaps/${OTHER_WORKMAP}/publish`)).statusCode).toBe(404);
    expect((await call('GET', `/v1/workmaps/${OTHER_WORKMAP}/export`)).statusCode).toBe(404);
  });

  it('streams the agent export with its headers', async () => {
    const res = await call('GET', `/v1/workmaps/${IDS.workmap}/export?format=agent`);
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('application/zip');
    expect(res.headers['content-disposition']).toBe('attachment; filename="agent-rules.zip"');
    expect(res.rawPayload.toString()).toBe('PK-fake-zip');
    expect((await call('GET', `/v1/workmaps/${IDS.workmap}/export?format=pdf`)).statusCode).toBe(400);
  });

  it('returns a 10-minute signed URL for the newest clip of a step', async () => {
    const res = await call('GET', `/v1/workmaps/${IDS.workmap}/steps/${STEP}/clip`);
    expect(res.json()).toEqual({
      url: 'memory://captures/org/o/sessions/s/clips/new.mp4?ttl=600',
      expires_in: 600,
    });
  });

  it('returns 404 for a step of another Work Map or a step without a clip', async () => {
    expect((await call('GET', `/v1/workmaps/${IDS.workmap}/steps/${OTHER_STEP}/clip`)).statusCode).toBe(404);
    store.data.clips = [];
    expect((await call('GET', `/v1/workmaps/${IDS.workmap}/steps/${STEP}/clip`)).statusCode).toBe(404);
  });
});

describe('GET /v1/tools/expert_moment/:step_id (Tutor Room replay_moment)', () => {
  it('forwards to tutor for a step in the caller org', async () => {
    const res = await call('GET', `/v1/tools/expert_moment/${STEP}`);
    expect(res.statusCode).toBe(200);
    expect(tutor.tools).toEqual([{ name: 'get_expert_moment', body: { step_id: STEP } }]);
  });

  it('hides steps of other orgs', async () => {
    expect((await call('GET', `/v1/tools/expert_moment/${OTHER_STEP}`)).statusCode).toBe(404);
    expect(tutor.tools).toHaveLength(0);
  });
});

describe('ElevenLabs webhook tools', () => {
  it('require X-Sidekik-Tool-Secret', async () => {
    const body = { session_id: TUTOR };
    expect((await call('POST', '/v1/tools/check_guardrails', {}, body)).statusCode).toBe(401);
    expect((await call('POST', '/v1/tools/check_guardrails', internal, body)).statusCode).toBe(401);
    expect((await call('POST', '/v1/tools/check_guardrails', user, body)).statusCode).toBe(401);
  });

  it('forward recall_context to mapper with the default scope and extra fields', async () => {
    const res = await call('POST', '/v1/tools/recall_context', tool, { session_id: CAPTURE, query: 'capex', extra: 1 });
    expect(res.json()).toEqual({ snippets: [{ text: 'Über 5.000 immer 0400.', t_ms: 192000, source: 'turn' }] });
    expect(mapper.calls).toHaveLength(1);
    expect(JSON.parse(mapper.calls[0]!.replace(/^recall:/, ''))).toEqual({
      session_id: CAPTURE,
      query: 'capex',
      extra: 1,
      scope: 'session',
    });
  });

  it('forward the tutor tools', async () => {
    await call('POST', '/v1/tools/check_guardrails', tool, { session_id: TUTOR, state: g1State });
    await call('POST', '/v1/tools/get_step', tool, { session_id: TUTOR });
    await call('POST', '/v1/tools/get_expert_moment', tool, { step_id: 'S4' });
    expect(tutor.tools).toEqual([
      { name: 'check_guardrails', body: { session_id: TUTOR, state: g1State } },
      { name: 'get_step', body: { session_id: TUTOR } },
      { name: 'get_expert_moment', body: { step_id: 'S4' } },
    ]);
  });

  it('validate the session id', async () => {
    expect((await call('POST', '/v1/tools/get_step', tool, { session_id: 'nope' })).statusCode).toBe(400);
  });
});

describe('agent host (meeting mode)', () => {
  async function issue(sid = MEETING) {
    return call('POST', '/internal/agent-host-token', internal, { sid });
  }
  async function claim(t: string) {
    return call('POST', '/v1/agent-host/claim', {}, { t });
  }

  it('issues a one-time token to meetbot', async () => {
    const res = await issue();
    expect(res.statusCode).toBe(200);
    expect(res.json().t).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(Date.parse(res.json().expires_at)).toBeGreaterThan(Date.now() + 14 * 60_000);
    expect((await call('POST', '/internal/agent-host-token', {}, { sid: MEETING })).statusCode).toBe(401);
    expect((await issue('60000000-0000-4000-8000-0000000000ff')).statusCode).toBe(404);
  });

  it('exchanges the token once for an sk_token and a voice token', async () => {
    const { t } = (await issue()).json();
    const res = await claim(t);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.session_id).toBe(MEETING);
    // The page acts for the capture's expert (the platform's SessionRole has no agent-host role).
    expect(verifySessionToken(body.sk_token, SECRETS.session)).toMatchObject({
      sid: MEETING,
      org: IDS.org,
      role: 'expert',
      kind: 'capture',
    });
    expect(body.el).toMatchObject({
      conversation_token: 'el-token-interviewer',
      dynamic_variables: { session_id: MEETING, expert_name: 'Sabine', workflow_name: 'Supplier invoice coding' },
    });
    expect(voice.calls[0]).toMatchObject({ agent: 'interviewer', phase: 'capture' });

    expect((await claim(t)).statusCode).toBe(401);
  });

  it('uses the debrief agent setup when the session is in debrief', async () => {
    store.data.sessions[2]!.phase = 'debrief';
    const { t } = (await issue()).json();
    await claim(t);
    expect(voice.calls[0]).toMatchObject({ agent: 'interviewer', phase: 'debrief' });
  });

  it('rejects expired and unknown tokens', async () => {
    const { t } = (await issue()).json();
    store.data.agentHostTokens[0]!.expires_at = new Date(Date.now() - 1000).toISOString();
    expect((await claim(t)).statusCode).toBe(401);
    expect((await claim('x'.repeat(43))).statusCode).toBe(401);
    expect((await claim('short')).statusCode).toBe(400);
  });
});
