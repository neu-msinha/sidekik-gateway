import type { Bus, Envelope, StreamKey } from '../../src/contracts/index.js';
import type { VoiceClient, VoiceTokenRequest } from '../../src/services/voice.js';
import type { Person, Role, SessionRow, Store, WorkflowRow, WorkMapRef } from '../../src/store/types.js';

export const IDS = {
  org: '10000000-0000-4000-8000-000000000001',
  otherOrg: '10000000-0000-4000-8000-000000000002',
  workflow: '20000000-0000-4000-8000-000000000001',
  otherWorkflow: '20000000-0000-4000-8000-000000000002',
  workmap: '30000000-0000-4000-8000-000000000001',
  expert: '40000000-0000-4000-8000-000000000001',
  learner: '50000000-0000-4000-8000-000000000001',
};

export type MemoryData = {
  workflows: WorkflowRow[];
  members: { org_id: string; user_id: string; role: Role }[];
  experts: (Person & { org_id: string; user_id: string | null })[];
  learners: (Person & { org_id: string; user_id: string | null })[];
  workmaps: WorkMapRef[];
  memory: { expert_id: string; workflow_id: string; summary: string; open_items: string[] }[];
  sessions: SessionRow[];
  consents: { session_id: string; user_id: string; text_version: string; scopes: string[] }[];
};

export function memoryStore(seed: Partial<MemoryData> = {}): Store & { data: MemoryData } {
  const data: MemoryData = {
    workflows: [],
    members: [],
    experts: [],
    learners: [],
    workmaps: [],
    memory: [],
    sessions: [],
    consents: [],
    ...seed,
  };
  const person = (p?: Person) => (p ? { id: p.id, display_name: p.display_name } : null);

  return {
    data,
    getWorkflow: async (id) => data.workflows.find((w) => w.id === id) ?? null,
    getRole: async (org, user) => data.members.find((m) => m.org_id === org && m.user_id === user)?.role ?? null,
    findExpertByUser: async (org, user) => person(data.experts.find((e) => e.org_id === org && e.user_id === user)),
    findLearnerByUser: async (org, user) => person(data.learners.find((l) => l.org_id === org && l.user_id === user)),
    getExpert: async (id) => person(data.experts.find((e) => e.id === id)),
    getWorkMap: async (id) => data.workmaps.find((w) => w.id === id) ?? null,
    getExpertMemory: async (expertId, workflowId) => {
      const m = data.memory.find((x) => x.expert_id === expertId && x.workflow_id === workflowId);
      return m ? { summary: m.summary, open_items: m.open_items } : null;
    },
    insertSession: async (s) => {
      const row: SessionRow = {
        ...s,
        off_record: false,
        consent_at: null,
        started_at: new Date().toISOString(),
        ended_at: null,
      };
      data.sessions.push(row);
      return { ...row };
    },
    getSession: async (id) => {
      const s = data.sessions.find((x) => x.id === id);
      return s ? { ...s } : null;
    },
    recordConsent: async ({ session, user_id, text_version, scopes }) => {
      data.consents.push({ session_id: session.id, user_id, text_version, scopes });
      const s = data.sessions.find((x) => x.id === session.id)!;
      s.consent_at ??= new Date().toISOString();
      return { ...s };
    },
    endSession: async (id) => {
      const s = data.sessions.find((x) => x.id === id)!;
      s.ended_at ??= new Date().toISOString();
      return { ...s };
    },
  };
}

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

export function fakeBus(): Bus & { published: { stream: StreamKey; ev: Envelope<unknown> }[] } {
  const published: { stream: StreamKey; ev: Envelope<unknown> }[] = [];
  return {
    published,
    async publish(stream, ev) {
      published.push({ stream, ev });
      return `${published.length}-0`;
    },
    async close() {},
  };
}
