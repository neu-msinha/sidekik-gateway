import { beforeEach, describe, expect, it } from 'vitest';
import { verifySessionToken } from '../src/contracts/index.js';
import { HttpError } from '../src/errors.js';
import type { AuthUser } from '../src/auth.js';
import { IDS, fakeBus, fakeVoice, memoryStore, type MemoryData } from './fakes/index.js';
import { SECRETS, buildTestApp } from './helpers.js';

const USERS = {
  sabine: { id: '00000000-0000-4000-8000-0000000000a1' },
  lena: { id: '00000000-0000-4000-8000-0000000000a2' },
  mayukh: { id: '00000000-0000-4000-8000-0000000000a3' },
  outsider: { id: '00000000-0000-4000-8000-0000000000a4' },
} satisfies Record<string, AuthUser>;
type UserName = keyof typeof USERS;

const seed = (): Partial<MemoryData> => ({
  workflows: [
    { id: IDS.workflow, org_id: IDS.org, name: 'Supplier invoice coding', current_workmap_id: IDS.workmap },
    { id: IDS.otherWorkflow, org_id: IDS.org, name: 'Travel expenses', current_workmap_id: null },
  ],
  members: [
    { org_id: IDS.org, user_id: USERS.sabine.id, role: 'expert' },
    { org_id: IDS.org, user_id: USERS.lena.id, role: 'learner' },
    { org_id: IDS.org, user_id: USERS.mayukh.id, role: 'admin' },
    { org_id: IDS.otherOrg, user_id: USERS.outsider.id, role: 'admin' },
  ],
  experts: [{ id: IDS.expert, org_id: IDS.org, user_id: USERS.sabine.id, display_name: 'Sabine' }],
  learners: [{ id: IDS.learner, org_id: IDS.org, user_id: USERS.lena.id, display_name: 'Lena' }],
  workmaps: [{ id: IDS.workmap, org_id: IDS.org, workflow_id: IDS.workflow, expert_id: IDS.expert }],
  memory: [
    {
      expert_id: IDS.expert,
      workflow_id: IDS.workflow,
      summary: 'Recodes equipment over €5k to 0400.',
      open_items: ['What about leasing?', 'Who approves CZ01?'],
    },
  ],
});

let store: ReturnType<typeof memoryStore>;
let voice: ReturnType<typeof fakeVoice>;
let bus: ReturnType<typeof fakeBus>;

beforeEach(() => {
  store = memoryStore(seed());
  voice = fakeVoice();
  bus = fakeBus();
});

const app = () =>
  buildTestApp({
    store,
    voice,
    bus,
    verifyUser: async (jwt) => USERS[jwt as UserName] ?? null,
  });

const as = (user: UserName) => ({ authorization: `Bearer ${user}` });

async function start(user: UserName, body: Record<string, unknown>) {
  const a = await app();
  return a.inject({ method: 'POST', url: '/v1/sessions', headers: as(user), payload: body });
}

const captureBody = { workflow_id: IDS.workflow, kind: 'capture', mode: 'browser', language: 'de' };
const tutorBody = { workflow_id: IDS.workflow, kind: 'tutor', mode: 'browser', language: 'en' };

describe('POST /v1/sessions', () => {
  it('starts a capture session for an expert', async () => {
    const res = await start('sabine', captureBody);
    expect(res.statusCode).toBe(201);
    const body = res.json();
    const sid = body.session_id;

    expect(body.el).toEqual({
      conversation_token: 'el-token-interviewer',
      agent_id: 'agent-interviewer',
      dynamic_variables: {
        session_id: sid,
        workflow_name: 'Supplier invoice coding',
        language: 'de',
        expert_name: 'Sabine',
        prior_summary: 'Recodes equipment over €5k to 0400.',
        open_items: 'What about leasing?; Who approves CZ01?',
      },
    });
    expect(body.ingest_url).toBe(`wss://ingest.sidekik.live/ws/frames/${sid}`);
    expect(verifySessionToken(body.sk_token, SECRETS.session)).toMatchObject({
      sid,
      org: IDS.org,
      role: 'expert',
      kind: 'capture',
    });

    expect(voice.calls).toEqual([
      expect.objectContaining({ agent: 'interviewer', phase: 'capture', session_id: sid, language: 'de' }),
    ]);
    expect(store.data.sessions).toEqual([
      expect.objectContaining({
        id: sid,
        org_id: IDS.org,
        kind: 'capture',
        mode: 'browser',
        phase: 'capture',
        expert_id: IDS.expert,
        learner_id: null,
        workmap_id: null,
        el_agent_id: 'agent-interviewer',
        consent_at: null,
      }),
    ]);

    expect(bus.published).toHaveLength(1);
    const { stream, ev } = bus.published[0]!;
    expect(stream).toBe('sk:session.lifecycle');
    expect(ev).toMatchObject({
      type: 'session.lifecycle',
      v: 1,
      org_id: IDS.org,
      session_id: sid,
      producer: 'gateway',
      data: {
        event: 'started',
        kind: 'capture',
        phase: 'capture',
        workflow_id: IDS.workflow,
        mode: 'browser',
        language: 'de',
      },
    });
    expect(ev.id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(ev.t_ms).toBeLessThan(1000);
    expect(ev.data).not.toHaveProperty('workmap_id');
  });

  it('falls back to neutral variables when the caller has no expert profile or memory', async () => {
    const res = await start('mayukh', captureBody);
    expect(res.statusCode).toBe(201);
    expect(res.json().el.dynamic_variables).toMatchObject({
      expert_name: 'the expert',
      prior_summary: 'none',
      open_items: 'none',
    });
    expect(store.data.sessions[0]!.expert_id).toBeNull();
  });

  it("starts a tutor session on the workflow's current Work Map", async () => {
    const res = await start('lena', tutorBody);
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.el.agent_id).toBe('agent-tutor');
    expect(body.el.dynamic_variables).toEqual({
      session_id: body.session_id,
      workflow_name: 'Supplier invoice coding',
      language: 'en',
      learner_name: 'Lena',
      expert_name: 'Sabine',
    });
    expect(store.data.sessions[0]).toMatchObject({
      phase: 'tutoring',
      learner_id: IDS.learner,
      workmap_id: IDS.workmap,
    });
    expect(bus.published[0]!.ev.data).toMatchObject({ event: 'started', phase: 'tutoring', workmap_id: IDS.workmap });
    expect(verifySessionToken(body.sk_token, SECRETS.session)).toMatchObject({ role: 'learner', kind: 'tutor' });
  });

  it('returns 409 when the workflow has no Work Map yet', async () => {
    const res = await start('lena', { ...tutorBody, workflow_id: IDS.otherWorkflow });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('no_workmap');
  });

  it("rejects a Work Map from another workflow", async () => {
    const res = await start('lena', { ...tutorBody, workflow_id: IDS.otherWorkflow, workmap_id: IDS.workmap });
    expect(res.statusCode).toBe(404);
  });

  it('returns 404 for a workflow in another org', async () => {
    const res = await start('outsider', captureBody);
    expect(res.statusCode).toBe(404);
    expect(voice.calls).toHaveLength(0);
  });

  it('returns 403 when a learner tries to start a capture session', async () => {
    const res = await start('lena', captureBody);
    expect(res.statusCode).toBe(403);
  });

  it('does not allow replay mode', async () => {
    const res = await start('sabine', { ...captureBody, mode: 'replay' });
    expect(res.statusCode).toBe(400);
  });

  it('requires a Supabase JWT', async () => {
    const a = await app();
    const res = await a.inject({ method: 'POST', url: '/v1/sessions', payload: captureBody });
    expect(res.statusCode).toBe(401);
  });

  it('creates nothing when voice fails', async () => {
    voice.fail = new HttpError(504, 'upstream_timeout', '/internal/token timed out after 500 ms');
    const res = await start('sabine', captureBody);
    expect(res.statusCode).toBe(504);
    expect(store.data.sessions).toHaveLength(0);
    expect(bus.published).toHaveLength(0);
  });
});

describe('POST /v1/sessions/:id/consent', () => {
  async function startedSession() {
    const res = await start('sabine', captureBody);
    return res.json().session_id as string;
  }

  const consent = async (user: UserName, sid: string, payload: object) =>
    (await app()).inject({ method: 'POST', url: `/v1/sessions/${sid}/consent`, headers: as(user), payload });

  const valid = { text_version: 'v1', scopes: ['audio', 'screen', 'storage'] };

  it('records consent and sets consent_at once', async () => {
    const sid = await startedSession();
    const first = await consent('sabine', sid, valid);
    expect(first.statusCode).toBe(200);
    const consentAt = first.json().consent_at;
    expect(consentAt).toEqual(expect.any(String));
    expect(store.data.consents).toEqual([
      { session_id: sid, user_id: USERS.sabine.id, text_version: 'v1', scopes: ['audio', 'screen', 'storage'] },
    ]);

    const second = await consent('sabine', sid, { text_version: 'v1', scopes: ['audio'] });
    expect(second.json().consent_at).toBe(consentAt);
    expect(store.data.consents).toHaveLength(2);
  });

  it.each([
    ['empty scopes', { text_version: 'v1', scopes: [] }],
    ['unknown scope', { text_version: 'v1', scopes: ['camera'] }],
    ['duplicate scopes', { text_version: 'v1', scopes: ['audio', 'audio'] }],
    ['missing text_version', { scopes: ['audio'] }],
  ])('rejects %s', async (_label, payload) => {
    const sid = await startedSession();
    expect((await consent('sabine', sid, payload)).statusCode).toBe(400);
  });

  it('returns 400 for a non-uuid id', async () => {
    expect((await consent('sabine', 'not-a-uuid', valid)).statusCode).toBe(400);
  });

  it('returns 404 for a session in another org', async () => {
    const sid = await startedSession();
    expect((await consent('outsider', sid, valid)).statusCode).toBe(404);
    expect(store.data.consents).toHaveLength(0);
  });

  it('returns 409 after the session has ended', async () => {
    const sid = await startedSession();
    await (await app()).inject({ method: 'POST', url: `/v1/sessions/${sid}/end`, headers: as('sabine') });
    expect((await consent('sabine', sid, valid)).statusCode).toBe(409);
  });
});

describe('POST /v1/sessions/:id/end', () => {
  it('ends the session and publishes lifecycle ended exactly once', async () => {
    const sid = (await start('sabine', captureBody)).json().session_id;
    const end = async () =>
      (await app()).inject({ method: 'POST', url: `/v1/sessions/${sid}/end`, headers: as('sabine') });

    const first = await end();
    expect(first.statusCode).toBe(200);
    expect(first.json()).toEqual({ session_id: sid, ended_at: expect.any(String) });

    const second = await end();
    expect(second.json().ended_at).toBe(first.json().ended_at);

    const events = bus.published.map((p) => (p.ev.data as { event: string }).event);
    expect(events).toEqual(['started', 'ended']);
  });

  it('returns 404 for a session in another org', async () => {
    const sid = (await start('sabine', captureBody)).json().session_id;
    const res = await (await app()).inject({
      method: 'POST',
      url: `/v1/sessions/${sid}/end`,
      headers: as('outsider'),
    });
    expect(res.statusCode).toBe(404);
  });
});

describe('auth runs before validation', () => {
  it('returns 401, not 400, for an unauthenticated invalid body', async () => {
    const res = await (await app()).inject({ method: 'POST', url: '/v1/sessions', payload: {} });
    expect(res.statusCode).toBe(401);
  });
});
