import type { AgentCommand, Bus, Envelope, StreamKey } from '../../src/contracts/index.js';
import type { Broadcaster } from '../../src/services/realtime.js';
import type { MapperClient, MeetbotClient, PresaveResult, TutorClient, TutorTool } from '../../src/services/upstreams.js';
import type { VoiceClient, VoiceTokenRequest } from '../../src/services/voice.js';
export { memoryStore, type MemoryData } from '../../src/store/memory.js';

export const IDS = {
  org: '10000000-0000-4000-8000-000000000001',
  otherOrg: '10000000-0000-4000-8000-000000000002',
  workflow: '20000000-0000-4000-8000-000000000001',
  otherWorkflow: '20000000-0000-4000-8000-000000000002',
  workmap: '30000000-0000-4000-8000-000000000001',
  expert: '40000000-0000-4000-8000-000000000001',
  learner: '50000000-0000-4000-8000-000000000001',
};

export function fakeVoice(): VoiceClient & { calls: VoiceTokenRequest[]; fail?: Error } {
  const voice: VoiceClient & { calls: VoiceTokenRequest[]; fail?: Error } = {
    calls: [],
    async getToken(req) {
      voice.calls.push(req);
      if (voice.fail) throw voice.fail;
      return { conversation_token: `el-token-${req.agent}`, agent_id: `agent-${req.agent}` };
    },
  };
  return voice;
}

type Handler = (ev: Envelope<any>) => Promise<void>;

/**
 * Records publishes; `deliver` feeds an event to the consumer registered for a stream.
 * With `loopback` on, published events are also delivered to that consumer, like Redis would.
 */
export function fakeBus() {
  const published: { stream: StreamKey; ev: Envelope<unknown> }[] = [];
  const handlers = new Map<StreamKey, Handler>();
  const bus: Bus & {
    published: typeof published;
    loopback: boolean;
    deliver(stream: StreamKey, ev: Envelope<unknown>): Promise<void>;
    consuming(stream: StreamKey): boolean;
  } = {
    published,
    loopback: false,
    async publish(stream, ev) {
      published.push({ stream, ev });
      const handler = handlers.get(stream);
      if (bus.loopback && handler) await handler(ev);
      return `${published.length}-0`;
    },
    consume(stream, handler) {
      handlers.set(stream, handler as Handler);
      return () => handlers.delete(stream);
    },
    async deliver(stream, ev) {
      const handler = handlers.get(stream);
      if (!handler) throw new Error(`no consumer for ${stream}`);
      await handler(ev);
    },
    consuming: (stream) => handlers.has(stream),
    async close() {},
  };
  return bus;
}

/** Records broadcasts per session; set `fail` to make the next sends throw. */
export function fakeBroadcaster() {
  const b: Broadcaster & {
    sent: { sessionId: string; cmd: AgentCommand }[];
    warmed: string[];
    released: string[];
    fail?: Error;
  } = {
    sent: [],
    warmed: [],
    released: [],
    async send(sessionId, cmd) {
      if (b.fail) throw b.fail;
      b.sent.push({ sessionId, cmd });
    },
    warm(sessionId) {
      b.warmed.push(sessionId);
    },
    async release(sessionId) {
      b.released.push(sessionId);
    },
    async close() {},
  };
  return b;
}

/** Records calls; set `fail` to make every call throw, or `presaveResult` to change the verdict. */
export function fakeTutor() {
  const t: TutorClient & {
    presaves: { sessionId: string; state: unknown }[];
    tools: { name: TutorTool; body: Record<string, unknown> }[];
    presaveResult: PresaveResult;
    fail?: Error;
  } = {
    presaves: [],
    tools: [],
    presaveResult: { allow: true },
    async presave(sessionId, state) {
      if (t.fail) throw t.fail;
      t.presaves.push({ sessionId, state });
      return t.presaveResult;
    },
    async tool(name, body) {
      if (t.fail) throw t.fail;
      t.tools.push({ name, body });
      return { tool: name, ok: true };
    },
  };
  return t;
}

export function fakeMapper() {
  const m: MapperClient & { calls: string[]; fail?: Error } = {
    calls: [],
    async publish(id) {
      if (m.fail) throw m.fail;
      m.calls.push(`publish:${id}`);
      return { job_id: `job-${id}` };
    },
    async export(id, format) {
      if (m.fail) throw m.fail;
      m.calls.push(`export:${id}:${format}`);
      return {
        contentType: 'application/zip',
        disposition: 'attachment; filename="agent-rules.zip"',
        body: Buffer.from('PK-fake-zip'),
      };
    },
    async recallContext(body) {
      if (m.fail) throw m.fail;
      m.calls.push(`recall:${JSON.stringify(body)}`);
      return { snippets: [{ text: 'Über 5.000 immer 0400.', t_ms: 192000, source: 'turn' }] };
    },
  };
  return m;
}

export function fakeMeetbot() {
  const m: MeetbotClient & { created: { sessionId: string; meetingUrl: string }[]; removed: string[]; fail?: Error } = {
    created: [],
    removed: [],
    async createBot(sessionId, meetingUrl) {
      if (m.fail) throw m.fail;
      m.created.push({ sessionId, meetingUrl });
      return { bot_id: `bot-${sessionId}` };
    },
    async removeBot(sessionId) {
      if (m.fail) throw m.fail;
      m.removed.push(sessionId);
    },
  };
  return m;
}
