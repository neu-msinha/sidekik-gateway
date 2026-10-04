import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { forbidden, HttpError, notFound } from '../errors.js';
import { annotate } from '../logging.js';
import { UserNotFoundError, type Store } from '../store/types.js';

/**
 * POST /v1/people: an org admin gives an existing account (by email) a role in the org. Accounts are
 * created in Supabase; there are no invites. Experts and learners also get a profile row.
 */
export const peopleRoutes: FastifyPluginAsyncZod<{ store: Store }> = async (app, { store }) => {
  app.post(
    '/v1/people',
    {
      onRequest: app.requireUser,
      schema: {
        body: z.object({
          org_id: z.string().uuid(),
          email: z.string().trim().email(),
          role: z.enum(['admin', 'manager', 'expert', 'learner']),
          display_name: z.string().trim().max(80).optional(),
          language: z.string().min(2).max(10).default('en'),
        }),
      },
    },
    async (request, reply) => {
      const user = request.user!;
      const { org_id, email, role, language } = request.body;
      annotate(request, { org_id });

      const callerRole = await store.getRole(org_id, user.id);
      if (!callerRole) throw notFound('Organisation not found');
      if (callerRole !== 'admin') throw forbidden('Only admins can assign roles');
      if (email.toLowerCase() === user.email?.toLowerCase()) {
        throw new HttpError(409, 'own_role', "You can't change your own role");
      }

      const display_name = request.body.display_name || email.split('@')[0]!;
      try {
        const assigned = await store.assignRole({ org_id, email, role, display_name, language });
        request.log.info({ role, user_id: assigned.user_id }, 'role assigned');
        return reply.code(200).send({ ...assigned, role });
      } catch (err) {
        if (err instanceof UserNotFoundError) throw notFound(err.message);
        throw err;
      }
    },
  );
};
