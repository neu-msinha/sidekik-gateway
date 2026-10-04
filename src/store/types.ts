import type { Envelope, Phase, SessionKind, SessionMode } from '../contracts/index.js';

export type Role = 'admin' | 'expert' | 'learner' | 'manager';

export type Person = { id: string; display_name: string };

export type RoleAssignment = {
  org_id: string;
  email: string;
  role: Role;
  /** Used only when an expert/learner profile has to be created. */
  display_name: string;
  language: string;
};

/** `person_id` is the experts/learners row; null for admins and managers, who have none. */
export type AssignedRole = { user_id: string; person_id: string | null };

export type WorkflowRow = {
  id: string;
  org_id: string;
  name: string;
  current_workmap_id: string | null;
};

/** `version` is read where it matters (which map is current); seeds may leave it out. */
export type WorkMapRef = { id: string; org_id: string; workflow_id: string; expert_id: string; version?: number };

export type SessionRow = {
  id: string;
  org_id: string;
  workflow_id: string;
  kind: SessionKind;
  mode: SessionMode;
  phase: Phase;
  expert_id: string | null;
  learner_id: string | null;
  workmap_id: string | null;
  language: string;
  el_agent_id: string | null;
  off_record: boolean;
  consent_at: string | null;
  started_at: string;
  ended_at: string | null;
};

export type NewSession = Omit<SessionRow, 'off_record' | 'consent_at' | 'started_at' | 'ended_at'> & {
  /** For mode "replay": the recorded session being replayed. */
  replay_of?: string;
  consent_at?: string | null;
};

export type ReplayEventRow = {
  /** Derived from the bus event id, so a redelivered event is recorded once. */
  id: string;
  org_id: string;
  session_id: string;
  stream: string;
  t_ms: number;
  envelope: Envelope<unknown>;
};

export type OffRecordSource = 'ui' | 'agent' | 'chat' | 'brain' | 'retroactive';

export type OffRecordSpanInput = {
  session: SessionRow;
  start_t_ms: number;
  end_t_ms?: number;
  source: OffRecordSource;
};

/** Tables purged by a retroactive off-record request (DESIGN §4). Owned by voice, perception, brain. */
export const CAPTURE_TABLES = ['transcript_turns', 'screen_events', 'keyframes', 'questions'] as const;
export type CaptureTable = (typeof CAPTURE_TABLES)[number];

export type CostRow = {
  /** Derived from the bus event id, so a redelivered usage event maps to the same row. */
  id: string;
  org_id: string;
  session_id: string | null;
  service: string;
  vendor: 'elevenlabs' | 'typesafe' | 'anthropic' | 'recall';
  units: number;
  unit: string;
  cost_usd: number;
  counterfactual_usd: number | null;
};
export type CostEntry = CostRow & { created_at: string };

export type ConsentInput = {
  session: SessionRow;
  user_id: string;
  text_version: string;
  scopes: string[];
};

/**
 * Data access for the gateway. Writes go only to gateway-owned tables (ARCHITECTURE §6);
 * reads may touch any table (work_maps, expert_memory and open_items belong to mapper).
 */
export interface Store {
  getWorkflow(id: string): Promise<WorkflowRow | null>;
  /** Points the workflow at the Work Map new tutor sessions use (workflows.current_workmap_id). */
  setCurrentWorkMap(workflowId: string, workmapId: string): Promise<void>;
  getRole(orgId: string, userId: string): Promise<Role | null>;
  findExpertByUser(orgId: string, userId: string): Promise<Person | null>;
  findLearnerByUser(orgId: string, userId: string): Promise<Person | null>;
  /**
   * Gives an existing account a role in the org (upserts org_members) and, for experts and learners,
   * makes sure they have a profile row. Throws `UserNotFoundError` when no account has that email.
   */
  assignRole(input: RoleAssignment): Promise<AssignedRole>;
  getExpert(id: string): Promise<Person | null>;
  getLearner(id: string): Promise<Person | null>;
  getWorkMap(id: string): Promise<WorkMapRef | null>;
  /** The expert's running summary for this workflow plus the text of their unresolved open items. */
  getExpertMemory(expertId: string, workflowId: string): Promise<{ summary: string; open_items: string[] } | null>;

  insertSession(session: NewSession): Promise<SessionRow>;
  getSession(id: string): Promise<SessionRow | null>;
  /** Inserts a consent_records row and sets sessions.consent_at if unset. Returns the session. */
  recordConsent(input: ConsentInput): Promise<SessionRow>;
  /** Sets sessions.ended_at if unset. Returns the session. */
  endSession(id: string): Promise<SessionRow>;

  /** Moves the session to `to` only if its phase is one of `from`. Returns the row, or null if it wasn't. */
  updatePhase(sessionId: string, from: Phase[], to: Phase): Promise<SessionRow | null>;

  /** The org that owns a Work Map step (work_map_steps.org_id), or null. */
  getStepOrg(stepId: string): Promise<string | null>;
  /** The newest clip for a step of this Work Map (clips belong to perception), or null. */
  getStepClipPath(workmapId: string, stepId: string): Promise<string | null>;
  /** A signed Storage URL; every bucket is private (ARCHITECTURE §6). */
  signStorageUrl(bucket: string, path: string, ttlSec: number): Promise<string>;

  insertAgentHostToken(input: { session: SessionRow; token: string; expires_at: string }): Promise<void>;
  /** Marks an unused, unexpired token as used and returns its session id; null otherwise. Atomic. */
  claimAgentHostToken(token: string): Promise<string | null>;

  /** Inserts a cost_ledger row unless one with the same id exists. Returns whether it was new. */
  insertCost(row: CostRow): Promise<boolean>;
  listCosts(sessionId: string): Promise<CostEntry[]>;

  /** Inserts a replay_events row unless one with the same id exists. Returns whether it was new. */
  insertReplayEvent(row: ReplayEventRow): Promise<boolean>;
  /** Every recorded event of a session, ordered by t_ms. */
  listReplayEvents(sessionId: string): Promise<ReplayEventRow[]>;
  deleteReplayEventsSince(sessionId: string, cutoffTms: number): Promise<number>;

  setOffRecord(sessionId: string, on: boolean): Promise<void>;
  openOffRecordSpan(span: OffRecordSpanInput): Promise<void>;
  /** Sets end_t_ms on the session's open spans. Returns how many were closed. */
  closeOffRecordSpans(sessionId: string, endTms: number): Promise<number>;
  /**
   * DOCUMENTED EXCEPTION to "write only your own tables": deletes the session's rows at or after
   * `cutoffTms` from voice, perception and brain tables (plus keyframe images in Storage), because
   * none of those services exposes a delete endpoint. One statement per table. Returns rows deleted.
   */
  deleteCaptureSince(session: SessionRow, cutoffTms: number): Promise<Record<CaptureTable, number>>;
}

export class UserNotFoundError extends Error {
  constructor(email: string) {
    super(`No account with ${email}. Create it in Supabase (Authentication > Users) first.`);
    this.name = 'UserNotFoundError';
  }
}
