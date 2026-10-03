import { createClient, type SupabaseClient, type SupabaseClientOptions } from '@supabase/supabase-js';
import { WebSocket } from 'ws';
import type { Env } from './env.js';
import type { HealthCheck } from './routes/health.js';

type RealtimeTransport = NonNullable<NonNullable<SupabaseClientOptions<'public'>['realtime']>['transport']>;

/** Service-role client: bypasses RLS, so only write to tables the gateway owns (ARCHITECTURE §6). */
export function createSupabase(env: Pick<Env, 'SUPABASE_URL' | 'SUPABASE_SERVICE_ROLE_KEY'>): SupabaseClient {
  return createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
    // Node 20 has no global WebSocket; realtime-js needs one to join channels. ws's typings
    // differ slightly from realtime-js's WebSocketLike, hence the cast.
    realtime: { transport: WebSocket as unknown as RealtimeTransport },
  });
}

export function supabaseHealth(supabase: SupabaseClient): HealthCheck {
  return async () => {
    const { error } = await supabase.from('orgs').select('id', { head: true }).limit(1);
    if (error) throw new Error(error.message);
  };
}
