import { z } from 'zod';
import type { InvoiceState } from '../contracts/index.js';
import { internalClient } from './internal-http.js';

// Budgets from ARCHITECTURE §4.3. Presave gets 250 ms so the gateway answers inside the page's 300 ms.
export const BUDGET_MS = { presave: 250, tool: 800, mapper: 1000, export: 5000, meetbot: 3000 } as const;

export type TutorTool = 'check_guardrails' | 'get_step' | 'get_expert_moment';

const PresaveSchema = z.object({
  allow: z.boolean(),
  guardrail_id: z.string().optional(),
  quote: z.string().optional(),
  step_id: z.string().optional(),
});
export type PresaveResult = z.infer<typeof PresaveSchema>;

/** Tool responses are relayed to ElevenLabs as-is; only require a JSON object. */
const ToolResult = z.record(z.unknown());
export type ToolResult = z.infer<typeof ToolResult>;

export interface TutorClient {
  presave(sessionId: string, state: InvoiceState): Promise<PresaveResult>;
  tool(name: TutorTool, body: Record<string, unknown>): Promise<ToolResult>;
}

export type ExportFile = { contentType: string; disposition: string | null; body: Buffer };

export interface MapperClient {
  publish(workmapId: string): Promise<{ job_id: string }>;
  export(workmapId: string, format: string): Promise<ExportFile>;
  recallContext(body: Record<string, unknown>): Promise<ToolResult>;
}

export interface MeetbotClient {
  createBot(sessionId: string, meetingUrl: string): Promise<{ bot_id: string }>;
  removeBot(sessionId: string): Promise<void>;
}

export function httpTutorClient(baseUrl: string, internalToken: string): TutorClient {
  const c = internalClient(baseUrl, internalToken);
  return {
    presave: (session_id, state) => c.post('/internal/presave', { session_id, state }, PresaveSchema, BUDGET_MS.presave),
    tool: (name, body) => c.post(`/internal/tools/${name}`, body, ToolResult, BUDGET_MS.tool),
  };
}

export function httpMapperClient(baseUrl: string, internalToken: string): MapperClient {
  const c = internalClient(baseUrl, internalToken);
  return {
    publish: (id) =>
      c.post(`/internal/workmaps/${encodeURIComponent(id)}/publish`, {}, z.object({ job_id: z.string() }), BUDGET_MS.mapper),
    async export(id, format) {
      const res = await c.raw(
        'GET',
        `/internal/workmaps/${encodeURIComponent(id)}/export?format=${encodeURIComponent(format)}`,
        BUDGET_MS.export,
      );
      return {
        contentType: res.headers.get('content-type') ?? 'application/octet-stream',
        disposition: res.headers.get('content-disposition'),
        body: Buffer.from(await res.arrayBuffer()),
      };
    },
    recallContext: (body) => c.post('/internal/tools/recall_context', body, ToolResult, BUDGET_MS.mapper),
  };
}

export function httpMeetbotClient(baseUrl: string, internalToken: string): MeetbotClient {
  const c = internalClient(baseUrl, internalToken);
  return {
    createBot: (session_id, meeting_url) =>
      c.post(
        '/internal/bots',
        { session_id, meeting_url, bot_name: 'Sidekik (recording)' },
        z.object({ bot_id: z.string() }),
        BUDGET_MS.meetbot,
      ),
    async removeBot(sessionId) {
      await c.raw('DELETE', `/internal/bots/${encodeURIComponent(sessionId)}`, BUDGET_MS.meetbot);
    },
  };
}
