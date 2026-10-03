// TEMPORARY: replace with @sidekik/contracts (see ./README.md).
// sk_token: HS256 with SK_SESSION_SECRET, claims {sid, org, role, kind}, 2 h TTL (ARCHITECTURE §4.4).
import { jwtVerify, SignJWT } from 'jose';
import { z } from 'zod';
import { SessionKindSchema } from './lifecycle.js';

export const SessionClaimsSchema = z.object({
  sid: z.string(),
  org: z.string(),
  role: z.string(),
  kind: SessionKindSchema,
});
export type SessionClaims = z.infer<typeof SessionClaimsSchema>;

const key = (secret: string) => new TextEncoder().encode(secret);

export async function signSessionToken(claims: SessionClaims, secret: string, ttlSec = 7200): Promise<string> {
  return new SignJWT({ ...claims })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setIssuedAt()
    .setExpirationTime(`${ttlSec}s`)
    .sign(key(secret));
}

/** Throws if the token is malformed, expired, or signed with another secret. */
export async function verifySessionToken(token: string, secret: string): Promise<SessionClaims> {
  const { payload } = await jwtVerify(token, key(secret), { algorithms: ['HS256'] });
  return SessionClaimsSchema.parse(payload);
}
