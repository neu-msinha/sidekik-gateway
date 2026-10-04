import {
  CAPTURE_TABLES,
  type CaptureTable,
  type CostEntry,
  type ReplayEventRow,
  type OffRecordSource,
  type Person,
  type Role,
  type SessionRow,
  type Store,
  type WorkflowRow,
  type WorkMapRef,
} from './types.js';

type CaptureRow = { session_id: string; t_ms: number; storage_path?: string };

export type MemoryData = {
  workflows: WorkflowRow[];
  members: { org_id: string; user_id: string; role: Role }[];
  experts: (Person & { org_id: string; user_id: string | null })[];
  learners: (Person & { org_id: string; user_id: string | null })[];
  workmaps: WorkMapRef[];
  memory: { expert_id: string; workflow_id: string; summary: string; open_items: string[] }[];
  sessions: SessionRow[];
  consents: { session_id: string; user_id: string; text_version: string; scopes: string[] }[];
  spans: { session_id: string; start_t_ms: number; end_t_ms: number | null; source: OffRecordSource }[];
  capture: Record<CaptureTable, CaptureRow[]>;
  /** Storage paths removed by deleteCaptureSince. */
  removedObjects: string[];
  steps: { id: string; work_map_id: string; org_id: string }[];
  clips: { step_id: string; storage_path: string; created_at: string }[];
  agentHostTokens: { token: string; session_id: string; expires_at: string; used_at: string | null }[];
  costs: CostEntry[];
  replayEvents: ReplayEventRow[];
};

/** In-memory Store for tests and `pnpm dev:mock`. Not for production: nothing is persisted. */
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
    spans: [],
    capture: { transcript_turns: [], screen_events: [], keyframes: [], questions: [] },
    removedObjects: [],
    steps: [],
    clips: [],
    agentHostTokens: [],
    costs: [],
    replayEvents: [],
    ...seed,
  };
  const person = (p?: Person) => (p ? { id: p.id, display_name: p.display_name } : null);

  return {
    data,
    getWorkflow: async (id) => data.workflows.find((w) => w.id === id) ?? null,
    setCurrentWorkMap: async (workflowId, workmapId) => {
      const workflow = data.workflows.find((w) => w.id === workflowId);
      if (workflow) workflow.current_workmap_id = workmapId;
    },
    getRole: async (org, user) => data.members.find((m) => m.org_id === org && m.user_id === user)?.role ?? null,
    findExpertByUser: async (org, user) => person(data.experts.find((e) => e.org_id === org && e.user_id === user)),
    findLearnerByUser: async (org, user) => person(data.learners.find((l) => l.org_id === org && l.user_id === user)),
    getExpert: async (id) => person(data.experts.find((e) => e.id === id)),
    getLearner: async (id) => person(data.learners.find((l) => l.id === id)),
    getWorkMap: async (id) => data.workmaps.find((w) => w.id === id) ?? null,
    getExpertMemory: async (expertId, workflowId) => {
      const m = data.memory.find((x) => x.expert_id === expertId && x.workflow_id === workflowId);
      return m ? { summary: m.summary, open_items: m.open_items } : null;
    },
    insertSession: async ({ replay_of: _replayOf, ...s }) => {
      const row: SessionRow = {
        ...s,
        off_record: false,
        consent_at: s.consent_at ?? null,
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
    updatePhase: async (id, from, to) => {
      const s = data.sessions.find((x) => x.id === id);
      if (!s || !from.includes(s.phase)) return null;
      s.phase = to;
      return { ...s };
    },
    getStepOrg: async (stepId) => data.steps.find((x) => x.id === stepId)?.org_id ?? null,
    getStepClipPath: async (workmapId, stepId) => {
      if (!data.steps.some((x) => x.id === stepId && x.work_map_id === workmapId)) return null;
      const clips = data.clips.filter((c) => c.step_id === stepId).sort((a, b) => b.created_at.localeCompare(a.created_at));
      return clips[0]?.storage_path ?? null;
    },
    signStorageUrl: async (bucket, path, ttlSec) => `memory://${bucket}/${path}?ttl=${ttlSec}`,
    insertAgentHostToken: async ({ session, token, expires_at }) => {
      data.agentHostTokens.push({ token, session_id: session.id, expires_at, used_at: null });
    },
    claimAgentHostToken: async (token) => {
      const t = data.agentHostTokens.find((x) => x.token === token);
      if (!t || t.used_at || Date.parse(t.expires_at) <= Date.now()) return null;
      t.used_at = new Date().toISOString();
      return t.session_id;
    },
    insertCost: async (row) => {
      if (data.costs.some((c) => c.id === row.id)) return false;
      data.costs.push({ ...row, created_at: new Date().toISOString() });
      return true;
    },
    listCosts: async (sessionId) =>
      data.costs.filter((c) => c.session_id === sessionId).sort((a, b) => a.created_at.localeCompare(b.created_at)),
    insertReplayEvent: async (row) => {
      if (data.replayEvents.some((r) => r.id === row.id)) return false;
      data.replayEvents.push(row);
      return true;
    },
    listReplayEvents: async (sessionId) =>
      data.replayEvents.filter((r) => r.session_id === sessionId).sort((a, b) => a.t_ms - b.t_ms),
    deleteReplayEventsSince: async (sessionId, cutoffTms) => {
      const before = data.replayEvents.length;
      data.replayEvents = data.replayEvents.filter((r) => !(r.session_id === sessionId && r.t_ms >= cutoffTms));
      return before - data.replayEvents.length;
    },
    setOffRecord: async (id, on) => {
      data.sessions.find((x) => x.id === id)!.off_record = on;
    },
    openOffRecordSpan: async ({ session, start_t_ms, end_t_ms, source }) => {
      data.spans.push({ session_id: session.id, start_t_ms, end_t_ms: end_t_ms ?? null, source });
    },
    closeOffRecordSpans: async (id, endTms) => {
      const open = data.spans.filter((x) => x.session_id === id && x.end_t_ms === null);
      for (const span of open) span.end_t_ms = endTms;
      return open.length;
    },
    deleteCaptureSince: async (session, cutoffTms) => {
      const counts = {} as Record<CaptureTable, number>;
      for (const table of CAPTURE_TABLES) {
        const doomed = (r: CaptureRow) => r.session_id === session.id && r.t_ms >= cutoffTms;
        const rows = data.capture[table];
        data.removedObjects.push(...rows.filter(doomed).flatMap((r) => (r.storage_path ? [r.storage_path] : [])));
        counts[table] = rows.filter(doomed).length;
        data.capture[table] = rows.filter((r) => !doomed(r));
      }
      return counts;
    },
  };
}
