import { createHash } from 'node:crypto';

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * A stable UUID (version 5 layout) for `key` within `namespace`. Used as the row id of tables that
 * record bus events but have no event-id column, so a redelivered event maps to the same row.
 */
export function stableUuid(namespace: string, key: string): string {
  const h = createHash('sha1').update(`sidekik:${namespace}:${key}`).digest();
  h[6] = (h[6]! & 0x0f) | 0x50;
  h[8] = (h[8]! & 0x3f) | 0x80;
  const x = h.subarray(0, 16).toString('hex');
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20)}`;
}
