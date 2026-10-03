import { z } from 'zod';
import type { Phase } from '../contracts/index.js';
import { postInternal } from './internal-http.js';

// sidekik-voice POST /internal/token (sidekik-voice docs/DESIGN.md §4). Budget: 500 ms.
export type VoiceTokenRequest = {
  agent: 'interviewer' | 'tutor';
  phase: Phase;
  session_id: string;
  dynamic_variables: Record<string, string>;
  language: string;
};

const VoiceTokenSchema = z.object({ conversation_token: z.string(), agent_id: z.string() });
export type VoiceToken = z.infer<typeof VoiceTokenSchema>;

export interface VoiceClient {
  getToken(req: VoiceTokenRequest): Promise<VoiceToken>;
}

export function httpVoiceClient(opts: { baseUrl: string; internalToken: string; timeoutMs?: number }): VoiceClient {
  return {
    getToken: (req) =>
      postInternal(new URL('/internal/token', opts.baseUrl).href, req, VoiceTokenSchema, {
        internalToken: opts.internalToken,
        timeoutMs: opts.timeoutMs ?? 500,
      }),
  };
}
