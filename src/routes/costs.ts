import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { summarizeCosts } from '../services/costs.js';
import type { Store } from '../store/types.js';
import { sessionForUser } from './access.js';

/** GET /v1/costs/:sid: the session's cost ledger with the Jev-vs-LLM counterfactual (DESIGN §2). */
export const costRoutes: FastifyPluginAsyncZod<{ store: Store }> = async (app, opts) => {
  app.get(
    '/v1/costs/:sid',
    { onRequest: app.requireUser, schema: { params: z.object({ sid: z.string().uuid() }) } },
    async (request) => {
      const session = await sessionForUser(opts.store, request, request.params.sid);
      return summarizeCosts(session.id, await opts.store.listCosts(session.id));
    },
  );
};
