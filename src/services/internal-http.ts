import type { z } from 'zod';
import { HttpError } from '../errors.js';

export type InternalCallOptions = {
  internalToken: string;
  timeoutMs: number;
};

/**
 * POSTs JSON to another Sidekik service with `X-Internal-Token` and a hard timeout.
 * Upstream failures surface as 502, timeouts as 504.
 */
export async function postInternal<S extends z.ZodTypeAny>(
  url: string,
  body: unknown,
  schema: S,
  opts: InternalCallOptions,
): Promise<z.infer<S>> {
  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-internal-token': opts.internalToken },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(opts.timeoutMs),
    });
  } catch (err) {
    if (err instanceof DOMException && err.name === 'TimeoutError') {
      throw new HttpError(504, 'upstream_timeout', `${new URL(url).pathname} timed out after ${opts.timeoutMs} ms`);
    }
    throw new HttpError(502, 'upstream_unreachable', `${new URL(url).pathname} unreachable`);
  }
  if (!res.ok) {
    throw new HttpError(502, 'upstream_error', `${new URL(url).pathname} returned ${res.status}`);
  }
  const parsed = schema.safeParse(await res.json().catch(() => undefined));
  if (!parsed.success) {
    throw new HttpError(502, 'upstream_bad_response', `${new URL(url).pathname} returned an unexpected body`);
  }
  return parsed.data;
}
