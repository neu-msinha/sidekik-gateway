import type { z } from 'zod';
import { HttpError } from '../errors.js';

export type PostJsonOptions = {
  timeoutMs: number;
  headers?: Record<string, string>;
};

/**
 * POSTs JSON with a hard timeout and validates the response body.
 * Upstream failures surface as 502, timeouts as 504.
 */
export async function postJson<S extends z.ZodTypeAny>(
  url: string,
  body: unknown,
  schema: S,
  opts: PostJsonOptions,
): Promise<z.infer<S>> {
  const path = new URL(url).pathname;
  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...opts.headers },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(opts.timeoutMs),
    });
  } catch (err) {
    if (err instanceof DOMException && err.name === 'TimeoutError') {
      throw new HttpError(504, 'upstream_timeout', `${path} timed out after ${opts.timeoutMs} ms`);
    }
    throw new HttpError(502, 'upstream_unreachable', `${path} unreachable`);
  }
  if (!res.ok) {
    throw new HttpError(502, 'upstream_error', `${path} returned ${res.status}`);
  }
  const parsed = schema.safeParse(await res.json().catch(() => undefined));
  if (!parsed.success) {
    throw new HttpError(502, 'upstream_bad_response', `${path} returned an unexpected body`);
  }
  return parsed.data;
}

/** {@link postJson} to another Sidekik service, with `X-Internal-Token`. */
export function postInternal<S extends z.ZodTypeAny>(
  url: string,
  body: unknown,
  schema: S,
  opts: { internalToken: string; timeoutMs: number },
): Promise<z.infer<S>> {
  return postJson(url, body, schema, {
    timeoutMs: opts.timeoutMs,
    headers: { 'x-internal-token': opts.internalToken },
  });
}
