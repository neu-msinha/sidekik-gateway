import { z } from 'zod';

// Shared secrets are generated with `openssl rand -hex 32` (64 hex chars).
const secret = z.string().min(32, 'must be at least 32 characters (openssl rand -hex 32)');
const url = z.string().url();

export const envSchema = z.object({
  PORT: z.coerce.number().int().positive().default(8080),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),

  REDIS_URL: url,
  SUPABASE_URL: url,
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1),

  SK_INTERNAL_TOKEN: secret,
  SK_SESSION_SECRET: secret,
  SK_TOOL_SECRET: secret,

  PRESIDIO_ANALYZER_URL: url,
  PRESIDIO_ANONYMIZER_URL: url,

  VOICE_URL: url,
  MEETBOT_URL: url,
  MAPPER_URL: url,
  TUTOR_URL: url,
  BRAIN_URL: url,

  // Public perception base URL returned to the page as ingest_url (wss://ingest.sidekik.live in prod).
  INGEST_URL: url,

  // Comma-separated list of allowed browser origins.
  CORS_ORIGIN: z
    .string()
    .transform((s) => s.split(',').map((o) => o.trim()).filter(Boolean))
    .pipe(z.array(url).min(1)),
});

export type Env = z.infer<typeof envSchema>;

export function loadEnv(source: Record<string, string | undefined> = process.env): Env {
  const parsed = envSchema.safeParse(source);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Invalid environment:\n${issues}`);
  }
  return parsed.data;
}
