import type { RealtimeChannel, SupabaseClient } from '@supabase/supabase-js';
import type { AgentCommand } from '../contracts/index.js';

/** The only path from backend to browser: Supabase Realtime broadcast on `session:{sid}`, event `cmd`. */
export interface Broadcaster {
  send(sessionId: string, cmd: AgentCommand): Promise<void>;
  /** Opens the session's channel ahead of the first command, so that command skips the REST path. */
  warm(sessionId: string): void;
  release(sessionId: string): Promise<void>;
  close(): Promise<void>;
}

export const channelName = (sessionId: string) => `session:${sessionId}`;

export function supabaseBroadcaster(supabase: SupabaseClient, opts: { timeoutMs?: number } = {}): Broadcaster {
  const timeoutMs = opts.timeoutMs ?? 1000;
  const channels = new Map<string, { channel: RealtimeChannel; ready: boolean }>();

  const open = (sessionId: string) => {
    let entry = channels.get(sessionId);
    if (!entry) {
      const channel = supabase.channel(channelName(sessionId), { config: { broadcast: { ack: false } } });
      const created = { channel, ready: false };
      channel.subscribe((status) => {
        created.ready = status === 'SUBSCRIBED';
      });
      channels.set(sessionId, created);
      entry = created;
    }
    return entry;
  };

  return {
    async send(sessionId, cmd) {
      const entry = open(sessionId);
      if (entry.ready) {
        const res = await entry.channel.send({ type: 'broadcast', event: 'cmd', payload: cmd });
        if (res === 'ok') return;
      }
      // Channel not joined yet (or the socket send failed): REST broadcast needs no subscription.
      const res = await entry.channel.httpSend('cmd', cmd, { timeout: timeoutMs });
      if (!res.success) throw new Error(`realtime broadcast failed: ${res.status} ${res.error}`);
    },
    warm(sessionId) {
      open(sessionId);
    },
    async release(sessionId) {
      const entry = channels.get(sessionId);
      if (!entry) return;
      channels.delete(sessionId);
      await supabase.removeChannel(entry.channel);
    },
    async close() {
      await Promise.all([...channels.keys()].map((sid) => this.release(sid)));
    },
  };
}
