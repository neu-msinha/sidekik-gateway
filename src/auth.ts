import { createHash, timingSafeEqual } from 'node:crypto';
import type { FastifyRequest, onRequestAsyncHookHandler } from 'fastify';
import type { SupabaseClient } from '@supabase/supabase-js';
import { unauthorized } from './errors.js';

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

export function requireUser(verify: VerifyUser): onRequestAsyncHookHandler {
  return async (request) => {
    const header = request.headers.authorization;
    const match = header?.match(/^Bearer\s+(.+)$/i);
    if (!match?.[1]) throw unauthorized('Missing bearer token');
    const user = await verify(match[1]);
    if (!user) throw unauthorized('Invalid or expired token');
    request.user = user;
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
