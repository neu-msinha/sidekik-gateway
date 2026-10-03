import { createHash, timingSafeEqual } from 'node:crypto';
import type { FastifyRequest, onRequestAsyncHookHandler } from 'fastify';
import type { SupabaseClient } from '@supabase/supabase-js';
import { unauthorized } from './errors.js';
import { annotate } from './logging.js';

export type AuthUser = { id: string; email?: string };

/** Resolves a Supabase access token to its user, or null if the token is invalid. */
export type VerifyUser = (jwt: string) => Promise<AuthUser | null>;

declare module 'fastify' {
  interface FastifyRequest {
    user?: AuthUser;
  }
  interface FastifyInstance {
    /** Supabase JWT (`Authorization: Bearer`). Sets `request.user`. */
    requireUser: onRequestAsyncHookHandler;
    /** Service-to-service calls (`X-Internal-Token`). */
    requireInternal: onRequestAsyncHookHandler;
    /** ElevenLabs webhook tools (`X-Sidekik-Tool-Secret`). */
    requireToolSecret: onRequestAsyncHookHandler;
  }
}

export function supabaseVerifier(supabase: SupabaseClient): VerifyUser {
  return async (jwt) => {
    const { data, error } = await supabase.auth.getUser(jwt);
    if (error || !data.user) return null;
    return { id: data.user.id, email: data.user.email };
  };
}

/**
 * Remembers successful verifications for up to `ttlMs` (never past the token's own `exp`), so hot
 * paths such as presave skip the network round trip to Supabase Auth. Failures are not cached.
 */
export function cachedVerifier(verify: VerifyUser, opts: { ttlMs?: number; max?: number; now?: () => number } = {}): VerifyUser {
  const ttlMs = opts.ttlMs ?? 60_000;
  const max = opts.max ?? 1000;
  const now = opts.now ?? Date.now;
  const cache = new Map<string, { user: AuthUser; until: number }>();

  return async (jwt) => {
    const hit = cache.get(jwt);
    if (hit && hit.until > now()) return hit.user;
    cache.delete(jwt);

    const user = await verify(jwt);
    if (!user) return null;
    const exp = jwtExpiryMs(jwt);
    cache.set(jwt, { user, until: Math.min(now() + ttlMs, exp ?? Infinity) });
    if (cache.size > max) cache.delete(cache.keys().next().value!);
    return user;
  };
}

/** `exp` from a JWT payload, in ms. Only read after the token has been verified. */
function jwtExpiryMs(jwt: string): number | null {
  try {
    const payload = JSON.parse(Buffer.from(jwt.split('.')[1] ?? '', 'base64url').toString()) as { exp?: unknown };
    return typeof payload.exp === 'number' ? payload.exp * 1000 : null;
  } catch {
    return null;
  }
}

export function requireUser(verify: VerifyUser): onRequestAsyncHookHandler {
  return async (request) => {
    const header = request.headers.authorization;
    const match = header?.match(/^Bearer\s+(.+)$/i);
    if (!match?.[1]) throw unauthorized('Missing bearer token');
    const user = await verify(match[1]);
    if (!user) throw unauthorized('Invalid or expired token');
    request.user = user;
    annotate(request, { user_id: user.id });
  };
}

/** Builds an onRequest hook that checks a header against a shared secret in constant time. */
export function requireSharedSecret(header: string, expected: string): onRequestAsyncHookHandler {
  const expectedDigest = digest(expected);
  return async (request: FastifyRequest) => {
    const value = request.headers[header];
    if (typeof value !== 'string' || !timingSafeEqual(digest(value), expectedDigest)) {
      throw unauthorized(`Missing or invalid ${header}`);
    }
  };
}

// Hashing first makes the comparison constant-time regardless of input length.
const digest = (s: string) => createHash('sha256').update(s).digest();
