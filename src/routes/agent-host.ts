import { randomBytes } from 'node:crypto';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { signSessionToken } from '../contracts/index.js';
import { HttpError, notFound, unauthorized } from '../errors.js';
import { voiceRequestFor } from '../services/voice-request.js';
import type { VoiceClient } from '../services/voice.js';
import type { Store } from '../store/types.js';

export type AgentHostOptions = {
  store: Store;
  voice: VoiceClient;
  sessionSecret: string;
};

/** How long the Recall bot has to load /agent-host/{sid}?t=… after meetbot asks for the token. */
export const AGENT_HOST_TOKEN_TTL_MS = 15 * 60 * 1000;

/**
 * Meeting mode (ARCHITECTURE §4.4): meetbot gets a one-time `t` from
 * POST /internal/agent-host-token, Recall loads the agent-host page with it, and the page
 * exchanges it at POST /v1/agent-host/claim for an sk_token and a voice token.
 */
export const agentHostRoutes: FastifyPluginAsyncZod<AgentHostOptions> = async (app, opts) => {
  const { store } = opts;

  app.post(
    '/internal/agent-host-token',
    { onRequest: app.requireInternal, schema: { body: z.object({ sid: z.string().uuid() }) } },
    async (request) => {
      const session = await store.getSession(request.body.sid);
      if (!session) throw notFound('Session not found');
      if (session.ended_at) throw new HttpError(409, 'session_ended', 'Session has ended');
      const t = randomBytes(32).toString('base64url');
      const expires_at = new Date(Date.now() + AGENT_HOST_TOKEN_TTL_MS).toISOString();
      await store.insertAgentHostToken({ session, token: t, expires_at });
      request.log.info({ session_id: session.id, org_id: session.org_id }, 'agent-host token issued');
      return { t, expires_at };
    },
  );

  // No JWT: the one-time token is the credential.
  app.post(
    '/v1/agent-host/claim',
    { schema: { body: z.object({ t: z.string().min(16).max(128) }) } },
    async (request) => {
      const sid = await store.claimAgentHostToken(request.body.t);
      if (!sid) throw unauthorized('Invalid, used or expired agent-host token');
      const session = await store.getSession(sid);
      if (!session) throw notFound('Session not found');
      if (session.ended_at) throw new HttpError(409, 'session_ended', 'Session has ended');

      const tokenReq = await voiceRequestFor(store, session);
      const el = await opts.voice.getToken(tokenReq);
      const sk_token = await signSessionToken(
        { sid: session.id, org: session.org_id, role: 'agent_host', kind: session.kind },
        opts.sessionSecret,
      );
      request.log.info({ session_id: session.id, org_id: session.org_id, phase: session.phase }, 'agent host claimed');
      return { session_id: session.id, sk_token, el: { ...el, dynamic_variables: tokenReq.dynamic_variables } };
    },
  );
};
