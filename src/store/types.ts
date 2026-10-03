import type { Phase, SessionKind, SessionMode } from '../contracts/index.js';

export type Role = 'admin' | 'expert' | 'learner' | 'manager';

export type Person = { id: string; display_name: string };

export type WorkflowRow = {
  id: string;
  org_id: string;
  name: string;
  current_workmap_id: string | null;
};

export type WorkMapRef = { id: string; org_id: string; workflow_id: string; expert_id: string };

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

export type NewSession = Omit<SessionRow, 'off_record' | 'consent_at' | 'started_at' | 'ended_at'>;

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
  getRole(orgId: string, userId: string): Promise<Role | null>;
  findExpertByUser(orgId: string, userId: string): Promise<Person | null>;
  findLearnerByUser(orgId: string, userId: string): Promise<Person | null>;
  getExpert(id: string): Promise<Person | null>;
  getWorkMap(id: string): Promise<WorkMapRef | null>;
  /** The expert's running summary for this workflow plus the text of their unresolved open items. */
  getExpertMemory(expertId: string, workflowId: string): Promise<{ summary: string; open_items: string[] } | null>;

  insertSession(session: NewSession): Promise<SessionRow>;
  getSession(id: string): Promise<SessionRow | null>;
  /** Inserts a consent_records row and sets sessions.consent_at if unset. Returns the session. */
  recordConsent(input: ConsentInput): Promise<SessionRow>;
  /** Sets sessions.ended_at if unset. Returns the session. */
  endSession(id: string): Promise<SessionRow>;
}
