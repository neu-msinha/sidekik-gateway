import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { signSessionToken } from '../contracts/index.js';
import { forbidden } from '../errors.js';
import type { Replay } from '../services/replay.js';
import type { Role, Store } from '../store/types.js';
import { sessionForUser } from './access.js';

export type ReplayRoutesOptions = { store: Store; replay: Replay; sessionSecret: string };

const CAN_REPLAY: Role[] = ['admin', 'expert', 'manager'];

/** POST /v1/replay/:sid {speed}: re-publish a recorded session under a new replay session (DESIGN §8). */
export const replayRoutes: FastifyPluginAsyncZod<ReplayRoutesOptions> = async (app, opts) => {
  app.post(
    '/v1/replay/:sid',
    {
      onRequest: app.requireUser,
      schema: {
        params: z.object({ sid: z.string().uuid() }),
        body: z.object({ speed: z.number().min(0.25).max(10).default(1) }).default({}),
      },
    },
    async (request, reply) => {
      const original = await sessionForUser(opts.store, request.params.sid, request.user!.id);
      const role = (await opts.store.getRole(original.org_id, request.user!.id))!;
      if (!CAN_REPLAY.includes(role)) throw forbidden(`Role ${role} cannot start a replay`);

      const { speed } = request.body;
      const started = await opts.replay.start(original, speed);
      const sk_token = await signSessionToken(
        { sid: started.session.id, org: started.session.org_id, role, kind: started.session.kind },
        opts.sessionSecret,
      );
      return reply.code(202).send({
        session_id: started.session.id,
        replay_of: original.id,
        sk_token,
        speed,
        events: started.events,
        duration_ms: started.duration_ms,
      });
    },
  );
};
