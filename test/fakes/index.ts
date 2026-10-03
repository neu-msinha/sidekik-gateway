import type { AgentCommand, Bus, Envelope, StreamKey } from '../../src/contracts/index.js';
import type { Broadcaster } from '../../src/services/realtime.js';
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

/** Records publishes; `deliver` feeds an event to the consumer registered for a stream. */
export function fakeBus() {
  const published: { stream: StreamKey; ev: Envelope<unknown> }[] = [];
  const handlers = new Map<StreamKey, Handler>();
  const bus: Bus & {
    published: typeof published;
    deliver(stream: StreamKey, ev: Envelope<unknown>): Promise<void>;
    consuming(stream: StreamKey): boolean;
  } = {
    published,
    async publish(stream, ev) {
      published.push({ stream, ev });
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
