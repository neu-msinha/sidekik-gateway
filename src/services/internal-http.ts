import type { z } from 'zod';
import { HttpError } from '../errors.js';

export type RequestOptions = {
  timeoutMs: number;
  headers?: Record<string, string>;
};

/**
 * Sends a request with a hard timeout and returns the raw response.
 * Unreachable upstreams surface as 502, timeouts as 504, non-2xx statuses as 502.
 */
export async function request(
  method: 'GET' | 'POST' | 'DELETE',
  url: string,
  body: unknown,
  opts: RequestOptions,
): Promise<Response> {
  const path = new URL(url).pathname;
  let res: Response;
  try {
    res = await fetch(url, {
      method,
      headers: { ...(body !== undefined && { 'content-type': 'application/json' }), ...opts.headers },
      ...(body !== undefined && { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(opts.timeoutMs),
    });
  } catch (err) {
    if (err instanceof DOMException && err.name === 'TimeoutError') {
      throw new HttpError(504, 'upstream_timeout', `${path} timed out after ${opts.timeoutMs} ms`);
    }
    throw new HttpError(502, 'upstream_unreachable', `${path} unreachable`);
  }
  if (!res.ok) {
    // Pass 404s through so a missing Work Map or step reads as one to the caller.
    if (res.status === 404) throw new HttpError(404, 'not_found', `${path} returned 404`);
    throw new HttpError(502, 'upstream_error', `${path} returned ${res.status}`);
  }
  return res;
}

async function parse<S extends z.ZodTypeAny>(res: Response, schema: S, url: string): Promise<z.infer<S>> {
  const parsed = schema.safeParse(await res.json().catch(() => undefined));
  if (!parsed.success) {
    throw new HttpError(502, 'upstream_bad_response', `${new URL(url).pathname} returned an unexpected body`);
  }
  return parsed.data;
}

/** POSTs JSON and validates the response body. */
export async function postJson<S extends z.ZodTypeAny>(
  url: string,
  body: unknown,
  schema: S,
  opts: RequestOptions,
): Promise<z.infer<S>> {
  return parse(await request('POST', url, body, opts), schema, url);
}

/** Client for another Sidekik service: every call carries `X-Internal-Token`. */
export function internalClient(baseUrl: string, internalToken: string) {
  const headers = { 'x-internal-token': internalToken };
  const url = (path: string) => new URL(path, baseUrl).href;
  return {
    post: <S extends z.ZodTypeAny>(path: string, body: unknown, schema: S, timeoutMs: number) =>
      postJson(url(path), body, schema, { timeoutMs, headers }),
    get: async <S extends z.ZodTypeAny>(path: string, schema: S, timeoutMs: number) =>
      parse(await request('GET', url(path), undefined, { timeoutMs, headers }), schema, url(path)),
    raw: (method: 'GET' | 'POST' | 'DELETE', path: string, timeoutMs: number, body?: unknown) =>
      request(method, url(path), body, { timeoutMs, headers }),
  };
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
