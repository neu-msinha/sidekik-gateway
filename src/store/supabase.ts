import type { PostgrestError, SupabaseClient } from '@supabase/supabase-js';
import type { NewSession, Person, Role, SessionRow, Store, WorkflowRow, WorkMapRef } from './types.js';

const SESSION_COLUMNS =
  'id, org_id, workflow_id, kind, mode, phase, expert_id, learner_id, workmap_id, language, ' +
  'el_agent_id, off_record, consent_at, started_at, ended_at';

function unwrap<T>({ data, error }: { data: T; error: PostgrestError | null }, what: string): T {
  if (error) throw new Error(`${what}: ${error.message}`);
  return data;
}

export function supabaseStore(db: SupabaseClient): Store {
  const getSession = async (id: string) =>
    unwrap(
      await db.from('sessions').select(SESSION_COLUMNS).eq('id', id).maybeSingle<SessionRow>(),
      'get session',
    );

  return {
    async getWorkflow(id) {
      return unwrap(
        await db
          .from('workflows')
          .select('id, org_id, name, current_workmap_id')
          .eq('id', id)
          .maybeSingle<WorkflowRow>(),
        'get workflow',
      );
    },

    async getRole(orgId, userId) {
      const row = unwrap(
        await db
          .from('org_members')
          .select('role')
          .eq('org_id', orgId)
          .eq('user_id', userId)
          .maybeSingle<{ role: Role }>(),
        'get role',
      );
      return row?.role ?? null;
    },

    async findExpertByUser(orgId, userId) {
      return unwrap(
        await db
          .from('experts')
          .select('id, display_name')
          .eq('org_id', orgId)
          .eq('user_id', userId)
          .limit(1)
          .maybeSingle<Person>(),
        'find expert',
      );
    },

    async findLearnerByUser(orgId, userId) {
      return unwrap(
        await db
          .from('learners')
          .select('id, display_name')
          .eq('org_id', orgId)
          .eq('user_id', userId)
          .limit(1)
          .maybeSingle<Person>(),
        'find learner',
      );
    },

    async getExpert(id) {
      return unwrap(
        await db.from('experts').select('id, display_name').eq('id', id).maybeSingle<Person>(),
        'get expert',
      );
    },

    async getWorkMap(id) {
      return unwrap(
        await db
          .from('work_maps')
          .select('id, org_id, workflow_id, expert_id')
          .eq('id', id)
          .maybeSingle<WorkMapRef>(),
        'get work map',
      );
    },

    async getExpertMemory(expertId, workflowId) {
      const memory = unwrap(
        await db
          .from('expert_memory')
          .select('summary, open_item_ids')
          .eq('expert_id', expertId)
          .eq('workflow_id', workflowId)
          .maybeSingle<{ summary: string; open_item_ids: string[] }>(),
        'get expert memory',
      );
      if (!memory) return null;
      if (memory.open_item_ids.length === 0) return { summary: memory.summary, open_items: [] };
      const items = unwrap(
        await db
          .from('open_items')
          .select('text')
          .in('id', memory.open_item_ids)
          .neq('status', 'resolved')
          .returns<{ text: string }[]>(),
        'get open items',
      );
      return { summary: memory.summary, open_items: (items ?? []).map((i) => i.text) };
    },

    async insertSession(session: NewSession) {
      const row = unwrap(
        await db.from('sessions').insert(session).select(SESSION_COLUMNS).single<SessionRow>(),
        'insert session',
      );
      if (!row) throw new Error('insert session: no row returned');
      return row;
    },

    getSession,

    async recordConsent({ session, user_id, text_version, scopes }) {
      unwrap(
        await db
          .from('consent_records')
          .insert({ org_id: session.org_id, session_id: session.id, user_id, text_version, scopes }),
        'insert consent record',
      );
      unwrap(
        await db
          .from('sessions')
          .update({ consent_at: new Date().toISOString() })
          .eq('id', session.id)
          .is('consent_at', null),
        'set consent_at',
      );
      const updated = await getSession(session.id);
      if (!updated) throw new Error(`session ${session.id} disappeared`);
      return updated;
    },

    async endSession(id) {
      unwrap(
        await db.from('sessions').update({ ended_at: new Date().toISOString() }).eq('id', id).is('ended_at', null),
        'end session',
      );
      const updated = await getSession(id);
      if (!updated) throw new Error(`session ${id} disappeared`);
      return updated;
    },
  };
}
