import { describe, expect, it } from 'vitest';
import { loadEnv } from '../src/env.js';
import { RAW_ENV } from './helpers.js';

describe('loadEnv', () => {
  it('parses a complete environment', () => {
    const env = loadEnv(RAW_ENV);
    expect(env.PORT).toBe(8080);
    expect(env.CORS_ORIGIN).toEqual(['https://app.sidekik.live', 'http://localhost:5173']);
  });

  it('defaults PORT and LOG_LEVEL', () => {
    const { PORT: _p, LOG_LEVEL: _l, ...rest } = RAW_ENV;
    const env = loadEnv(rest);
    expect(env.PORT).toBe(8080);
    expect(env.LOG_LEVEL).toBe('info');
  });

  it('names every missing or invalid variable', () => {
    const { SK_INTERNAL_TOKEN: _t, ...rest } = RAW_ENV;
    expect(() => loadEnv({ ...rest, SK_TOOL_SECRET: 'short', VOICE_URL: 'not-a-url' })).toThrow(
      /SK_INTERNAL_TOKEN[\s\S]*SK_TOOL_SECRET[\s\S]*VOICE_URL/,
    );
  });

  it('rejects an invalid CORS origin', () => {
    expect(() => loadEnv({ ...RAW_ENV, CORS_ORIGIN: 'https://app.sidekik.live,nope' })).toThrow(/CORS_ORIGIN/);
  });
});
