import { randomUUID } from 'node:crypto';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { signSessionToken, type Bus } from '../contracts/index.js';
import { forbidden, HttpError, notFound } from '../errors.js';
import { publishLifecycle } from '../services/lifecycle.js';
import { offRecordBody } from './off-record-body.js';
import type { OffRecordController } from '../services/off-record.js';
import type { PhaseService } from '../services/phase.js';
import type { VoiceClient, VoiceTokenRequest } from '../services/voice.js';
import type { NewSession, Role, SessionRow, Store } from '../store/types.js';

export type SessionRoutesOptions = {
  store: Store;
  voice: VoiceClient;
  bus: Bus;
  sessionSecret: string;
  /** Public perception base URL, e.g. wss://ingest.sidekik.live */
  ingestUrl: string;
  offRecord: OffRecordController;
  phase: PhaseService;
  /** Releases per-session resources (Realtime channel, debounce and off-record state). */
  onEnded?: (sessionId: string) => Promise<void>;
};

const CAN_START: Record<'capture' | 'tutor', Role[]> = {
  capture: ['admin', 'expert'],
  tutor: ['admin', 'learner', 'manager'],
};

const SessionParams = z.object({ id: z.string().uuid() });

export const sessionRoutes: FastifyPluginAsyncZod<SessionRoutesOptions> = async (app, opts) => {
  const { store, voice, bus } = opts;

  /** Loads a session the caller's org owns; 404 otherwise so ids of other orgs don't leak. */
  async function sessionForUser(id: string, userId: string): Promise<SessionRow> {
    const session = await store.getSession(id);
    if (!session || !(await store.getRole(session.org_id, userId))) throw notFound('Session not found');
    return session;
  }

  app.post(
    '/v1/sessions',
    {
      onRequest: app.requireUser,
      schema: {
        body: z.object({
          workflow_id: z.string().uuid(),
          kind: z.enum(['capture', 'tutor']),
          // Replay sessions are created only by POST /v1/replay/:sid.
          mode: z.enum(['browser', 'meeting']),
          language: z.string().min(2).max(10),
          workmap_id: z.string().uuid().optional(),
        }),
      },
    },
    async (request, reply) => {
      const user = request.user!;
      const { workflow_id, kind, mode, language } = request.body;

      const workflow = await store.getWorkflow(workflow_id);
      const role = workflow && (await store.getRole(workflow.org_id, user.id));
      if (!workflow || !role) throw notFound('Workflow not found');
      if (!CAN_START[kind].includes(role)) throw forbidden(`Role ${role} cannot start a ${kind} session`);

      const sessionId = randomUUID();
      const base = { session_id: sessionId, workflow_name: workflow.name, language };
      const common = { id: sessionId, org_id: workflow.org_id, workflow_id, kind, mode, language, el_agent_id: null };
      let row: NewSession;
      let tokenReq: VoiceTokenRequest;

      if (kind === 'capture') {
        const expert = await store.findExpertByUser(workflow.org_id, user.id);
        const memory = expert && (await store.getExpertMemory(expert.id, workflow.id));
        tokenReq = {
          agent: 'interviewer',
          phase: 'capture',
          session_id: sessionId,
          language,
          dynamic_variables: {
            ...base,
            expert_name: expert?.display_name ?? 'the expert',
            prior_summary: memory?.summary || 'none',
            open_items: memory?.open_items.join('; ') || 'none',
          },
        };
        row = { ...common, phase: 'capture', expert_id: expert?.id ?? null, learner_id: null, workmap_id: null };
      } else {
        const workmapId = request.body.workmap_id ?? workflow.current_workmap_id;
        if (!workmapId) throw new HttpError(409, 'no_workmap', 'This workflow has no published Work Map yet');
        const workmap = await store.getWorkMap(workmapId);
        if (!workmap || workmap.workflow_id !== workflow.id) throw notFound('Work Map not found');
        const [learner, expert] = await Promise.all([
          store.findLearnerByUser(workflow.org_id, user.id),
          store.getExpert(workmap.expert_id),
        ]);
        tokenReq = {
          agent: 'tutor',
          phase: 'tutoring',
          session_id: sessionId,
          language,
          dynamic_variables: {
            ...base,
            learner_name: learner?.display_name ?? 'the learner',
            expert_name: expert?.display_name ?? 'the expert',
          },
        };
        row = { ...common, phase: 'tutoring', expert_id: null, learner_id: learner?.id ?? null, workmap_id: workmap.id };
      }

      // Get the voice token before inserting, so a voice failure leaves no orphan session row.
      const el = await voice.getToken(tokenReq);
      const session = await store.insertSession({ ...row, el_agent_id: el.agent_id });
      const sk_token = await signSessionToken(
        { sid: session.id, org: session.org_id, role, kind },
        opts.sessionSecret,
      );
      await publishLifecycle(bus, session, 'started');

      request.log.info({ session_id: session.id, org_id: session.org_id, kind, mode }, 'session started');
      return reply.code(201).send({
        session_id: session.id,
        sk_token,
        el: { ...el, dynamic_variables: tokenReq.dynamic_variables },
        ingest_url: `${opts.ingestUrl.replace(/\/$/, '')}/ws/frames/${session.id}`,
      });
    },
  );

  app.post(
    '/v1/sessions/:id/consent',
    {
      onRequest: app.requireUser,
      schema: {
        params: SessionParams,
        body: z.object({
          text_version: z.string().min(1),
          scopes: z
            .array(z.enum(['audio', 'screen', 'storage']))
            .min(1)
            .refine((s) => new Set(s).size === s.length, 'scopes must be unique'),
        }),
      },
    },
    async (request) => {
      const user = request.user!;
      const session = await sessionForUser(request.params.id, user.id);
      if (session.ended_at) throw new HttpError(409, 'session_ended', 'Session has ended');

      const updated = await store.recordConsent({ session, user_id: user.id, ...request.body });
      request.log.info(
        { session_id: session.id, org_id: session.org_id, scopes: request.body.scopes },
        'consent recorded',
      );
      return { session_id: updated.id, consent_at: updated.consent_at };
    },
  );

  app.post(
    '/v1/sessions/:id/end',
    { onRequest: app.requireUser, schema: { params: SessionParams } },
    async (request) => {
      const session = await sessionForUser(request.params.id, request.user!.id);
      if (session.ended_at) return { session_id: session.id, ended_at: session.ended_at };

      const ended = await store.endSession(session.id);
      await store.closeOffRecordSpans(ended.id, Math.max(0, Date.now() - Date.parse(ended.started_at)));
      await publishLifecycle(bus, ended, 'ended');
      await opts.onEnded?.(ended.id).catch((err) =>
        request.log.warn({ err, session_id: ended.id, org_id: ended.org_id }, 'session cleanup failed'),
      );
      // TODO(proxies): remove the meeting bot via meetbot DELETE /internal/bots/:sid when mode is "meeting".
      request.log.info({ session_id: ended.id, org_id: ended.org_id }, 'session ended');
      return { session_id: ended.id, ended_at: ended.ended_at };
    },
  );

  // UI toggle and the agent's mark_off_record client tool (DESIGN §4).
  app.post(
    '/v1/sessions/:id/off-record',
    {
      onRequest: app.requireUser,
      schema: { params: SessionParams, body: offRecordBody(['ui', 'agent', 'chat'], 'ui') },
    },
    async (request) => {
      const session = await sessionForUser(request.params.id, request.user!.id);
      if (session.ended_at) throw new HttpError(409, 'session_ended', 'Session has ended');
      return opts.offRecord.set(session, request.body, request.log);
    },
  );

  // The expert clicks "Task done": phase becomes building and mapper starts the draft (DESIGN §5).
  app.post(
    '/v1/sessions/:id/phase',
    {
      onRequest: app.requireUser,
      schema: { params: SessionParams, body: z.object({ event: z.literal('task_done') }) },
    },
    async (request) => {
      const session = await sessionForUser(request.params.id, request.user!.id);
      return opts.phase.taskDone(session, request.log);
    },
  );
};
