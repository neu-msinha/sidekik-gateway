import { SignJWT } from 'jose';
import { describe, expect, it } from 'vitest';
import { makeEvent, signSessionToken, verifySessionToken } from '../src/contracts/index.js';

const SECRET = 's'.repeat(64);
const claims = { sid: 'sid-1', org: 'org-1', role: 'expert', kind: 'capture' } as const;

describe('sk_token', () => {
  it('round-trips the claims with a 2 h expiry', async () => {
    const token = await signSessionToken(claims, SECRET);
    expect(await verifySessionToken(token, SECRET)).toEqual(claims);

    const payload = JSON.parse(Buffer.from(token.split('.')[1]!, 'base64url').toString());
    expect(payload.exp - payload.iat).toBe(7200);
    const header = JSON.parse(Buffer.from(token.split('.')[0]!, 'base64url').toString());
    expect(header.alg).toBe('HS256');
  });

  it('rejects a token signed with another secret', async () => {
    const token = await signSessionToken(claims, 'x'.repeat(64));
    await expect(verifySessionToken(token, SECRET)).rejects.toThrow();
  });

  it('rejects an expired token', async () => {
    const token = await signSessionToken(claims, SECRET, -10);
    await expect(verifySessionToken(token, SECRET)).rejects.toThrow();
  });

  it('rejects a token with missing claims', async () => {
    const token = await new SignJWT({ sid: 'sid-1' })
      .setProtectedHeader({ alg: 'HS256' })
      .setExpirationTime('1h')
      .sign(new TextEncoder().encode(SECRET));
    await expect(verifySessionToken(token, SECRET)).rejects.toThrow();
  });
});

describe('makeEvent', () => {
  it('fills id, v and ts', () => {
    const ev = makeEvent({ type: 't', org_id: 'o', session_id: 's', t_ms: 5, producer: 'gateway', data: { a: 1 } });
    expect(ev).toMatchObject({ type: 't', v: 1, org_id: 'o', session_id: 's', t_ms: 5, producer: 'gateway', data: { a: 1 } });
    expect(ev.id).toHaveLength(26);
    expect(Date.parse(ev.ts)).not.toBeNaN();
  });
});
