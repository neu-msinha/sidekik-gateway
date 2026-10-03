import { createHash } from 'node:crypto';
import type { RateLimitPluginOptions } from '@fastify/rate-limit';
import type { FastifyRequest } from 'fastify';
import { HttpError } from './errors.js';

/** DESIGN §10: 20 requests per second per user on the public API. */
export const RATE_LIMIT = { max: 20, timeWindowMs: 1000 } as const;

/**
 * Keyed by the caller's access token (one per signed-in user) and checked before authentication,
 * so a flood of bad tokens never reaches Supabase Auth. Unauthenticated calls are keyed by IP.
 */
export function rateLimitKey(request: FastifyRequest): string {
  const token = request.headers.authorization?.match(/^Bearer\s+(.+)$/i)?.[1];
  if (token) return `user:${createHash('sha256').update(token).digest('hex').slice(0, 32)}`;
  return `ip:${clientIp(request)}`;
}

// The plugin builds the key before checking exemptions, and request.ip throws without a socket
// (e.g. injected WebSocket upgrades), so never let the key fail a request.
function clientIp(request: FastifyRequest): string {
  try {
    return request.ip;
  } catch {
    return 'unknown';
  }
}

/** Health checks, service-to-service calls and ElevenLabs webhook tools are not limited. */
export function isExempt(request: FastifyRequest): boolean {
  const path = request.url.split('?')[0]!;
  if (!path.startsWith('/v1/')) return true;
  return request.method === 'POST' && path.startsWith('/v1/tools/');
}

/**
 * Plugin options. `global: false` because the plugin would append its check after each route's own
 * onRequest hooks (after authentication); app.ts instead adds `app.rateLimit()` as a root
 * onRequest hook, which runs before every route's hooks.
 */
export function rateLimitOptions(overrides: Partial<RateLimitPluginOptions> = {}): RateLimitPluginOptions {
  return {
    global: false,
    max: RATE_LIMIT.max,
    timeWindow: RATE_LIMIT.timeWindowMs,
    keyGenerator: rateLimitKey,
    allowList: (request) => isExempt(request),
    errorResponseBuilder: (_request, ctx) =>
      new HttpError(429, 'rate_limited', `Rate limit of ${ctx.max} requests per second exceeded; retry in ${ctx.after}`),
    ...overrides,
  };
}
