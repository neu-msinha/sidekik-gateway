import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';

/** Fields every log line of a request carries once known (ARCHITECTURE §10). */
export type LogContext = {
  session_id?: string;
  org_id?: string;
  user_id?: string;
  workmap_id?: string;
};

declare module 'fastify' {
  interface FastifyRequest {
    logContext: LogContext;
  }
}

/**
 * Adds fields to the request's logger, so every later line of this request (handlers, the error
 * handler, the completion line) carries them.
 */
export function annotate(request: FastifyRequest, ctx: LogContext): void {
  const fresh = Object.fromEntries(
    Object.entries(ctx).filter(([k, v]) => v !== undefined && request.logContext[k as keyof LogContext] !== v),
  );
  if (Object.keys(fresh).length === 0) return;
  Object.assign(request.logContext, fresh);
  request.log = request.log.child(fresh);
}

const REQUEST_ID = /^[\w.:-]{8,128}$/;

/** Accepts a caller's `x-request-id` if it looks sane, otherwise makes one. */
export function genReqId(req: { headers: Record<string, string | string[] | undefined> }): string {
  const given = req.headers['x-request-id'];
  return typeof given === 'string' && REQUEST_ID.test(given) ? given : randomUUID();
}

/**
 * Replaces Fastify's default request logging with one line per request. The line never includes
 * the query string: /ws/client and /v1/agent-host carry tokens there.
 */
export function registerRequestLogging(app: FastifyInstance): void {
  app.decorateRequest('logContext', null as unknown as LogContext);
  app.addHook('onRequest', async (request, reply) => {
    request.logContext = {};
    reply.header('x-request-id', request.id);
  });
  app.addHook('onResponse', async (request, reply) => {
    const status = reply.statusCode;
    const line = {
      method: request.method,
      route: request.routeOptions.url ?? null,
      path: request.url.split('?')[0],
      status,
      latency_ms: Math.round(reply.elapsedTime),
    };
    if (status >= 500) request.log.error(line, 'request failed');
    else if (status === 429) request.log.warn(line, 'request rate limited');
    else request.log.info(line, 'request completed');
  });
}
