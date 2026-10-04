import type { PostgrestError, SupabaseClient } from '@supabase/supabase-js';
import type {
  CaptureTable,
  CostEntry,
  ReplayEventRow,
  NewSession,
  Person,
  Role,
  SessionRow,
  Store,
  WorkflowRow,
  WorkMapRef,
} from './types.js';

/** The column holding the session timeline position in each capture table (SCHEMA.md). */
const CAPTURE_T_MS: Record<CaptureTable, string> = {
  transcript_turns: 't_ms',
  screen_events: 't_ms',
  keyframes: 't_ms',
  questions: 'created_t_ms',
};
const CAPTURES_BUCKET = 'captures';

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

    async setCurrentWorkMap(workflowId, workmapId) {
      unwrap(
        await db.from('workflows').update({ current_workmap_id: workmapId }).eq('id', workflowId),
        'set current work map',
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

    async getLearner(id) {
      return unwrap(
        await db.from('learners').select('id, display_name').eq('id', id).maybeSingle<Person>(),
        'get learner',
      );
    },

    async getWorkMap(id) {
      return unwrap(
        await db
          .from('work_maps')
          .select('id, org_id, workflow_id, expert_id, version')
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

    async updatePhase(sessionId, from, to) {
      return unwrap(
        await db
          .from('sessions')
          .update({ phase: to })
          .eq('id', sessionId)
          .in('phase', from)
          .select(SESSION_COLUMNS)
          .maybeSingle<SessionRow>(),
        'update phase',
      );
    },

    async getStepOrg(stepId) {
      const row = unwrap(
        await db.from('work_map_steps').select('org_id').eq('id', stepId).maybeSingle<{ org_id: string }>(),
        'get step org',
      );
      return row?.org_id ?? null;
    },

    async getStepClipPath(workmapId, stepId) {
      const step = unwrap(
        await db.from('work_map_steps').select('id').eq('id', stepId).eq('work_map_id', workmapId).maybeSingle(),
        'get step',
      );
      if (!step) return null;
      const clip = unwrap(
        await db
          .from('clips')
          .select('storage_path')
          .eq('step_id', stepId)
          .order('created_at', { ascending: false })
          .limit(1)
          .maybeSingle<{ storage_path: string }>(),
        'get clip',
      );
      return clip?.storage_path ?? null;
    },

    async signStorageUrl(bucket, path, ttlSec) {
      const objectPath = path.replace(new RegExp(`^${bucket}/`), '');
      const { data, error } = await db.storage.from(bucket).createSignedUrl(objectPath, ttlSec);
      if (error || !data) throw new Error(`sign ${bucket}/${objectPath}: ${error?.message ?? 'no url'}`);
      return data.signedUrl;
    },

    async insertAgentHostToken({ session, token, expires_at }) {
      unwrap(
        await db
          .from('agent_host_tokens')
          .insert({ org_id: session.org_id, session_id: session.id, token, expires_at }),
        'insert agent-host token',
      );
    },

    async claimAgentHostToken(token) {
      // One conditional UPDATE, so two claims of the same token can't both succeed.
      const row = unwrap(
        await db
          .from('agent_host_tokens')
          .update({ used_at: new Date().toISOString() })
          .eq('token', token)
          .is('used_at', null)
          .gt('expires_at', new Date().toISOString())
          .select('session_id')
          .maybeSingle<{ session_id: string }>(),
        'claim agent-host token',
      );
      return row?.session_id ?? null;
    },

    async insertCost(row) {
      const { data, error } = await db
        .from('cost_ledger')
        .upsert(row, { onConflict: 'id', ignoreDuplicates: true })
        .select('id');
      if (error) throw new Error(`insert cost: ${error.message}`);
      return (data ?? []).length > 0;
    },

    async listCosts(sessionId) {
      const rows = unwrap(
        await db
          .from('cost_ledger')
          .select('id, org_id, session_id, service, vendor, units, unit, cost_usd, counterfactual_usd, created_at')
          .eq('session_id', sessionId)
          .order('created_at', { ascending: true })
          .returns<CostEntry[]>(),
        'list costs',
      );
      // numeric columns can arrive as strings; normalize.
      return (rows ?? []).map((r) => ({
        ...r,
        units: Number(r.units),
        cost_usd: Number(r.cost_usd),
        counterfactual_usd: r.counterfactual_usd === null ? null : Number(r.counterfactual_usd),
      }));
    },

    async insertReplayEvent(row) {
      const { data, error } = await db
        .from('replay_events')
        .upsert(row, { onConflict: 'id', ignoreDuplicates: true })
        .select('id');
      if (error) throw new Error(`insert replay event: ${error.message}`);
      return (data ?? []).length > 0;
    },

    async listReplayEvents(sessionId) {
      // PostgREST caps responses (1000 rows by default), so page through.
      const PAGE = 1000;
      const out: ReplayEventRow[] = [];
      for (let from = 0; ; from += PAGE) {
        const page = unwrap(
          await db
            .from('replay_events')
            .select('id, org_id, session_id, stream, t_ms, envelope')
            .eq('session_id', sessionId)
            .order('t_ms', { ascending: true })
            .order('created_at', { ascending: true })
            .range(from, from + PAGE - 1)
            .returns<ReplayEventRow[]>(),
          'list replay events',
        );
        out.push(...(page ?? []));
        if (!page || page.length < PAGE) return out;
      }
    },

    async deleteReplayEventsSince(sessionId, cutoffTms) {
      const { count, error } = await db
        .from('replay_events')
        .delete({ count: 'exact' })
        .eq('session_id', sessionId)
        .gte('t_ms', cutoffTms);
      if (error) throw new Error(`delete replay events: ${error.message}`);
      return count ?? 0;
    },

    async setOffRecord(sessionId, on) {
      unwrap(await db.from('sessions').update({ off_record: on }).eq('id', sessionId), 'set off_record');
    },

    async openOffRecordSpan({ session, start_t_ms, end_t_ms, source }) {
      unwrap(
        await db.from('off_record_spans').insert({
          org_id: session.org_id,
          session_id: session.id,
          start_t_ms,
          end_t_ms: end_t_ms ?? null,
          source,
        }),
        'open off-record span',
      );
    },

    async closeOffRecordSpans(sessionId, endTms) {
      const { count, error } = await db
        .from('off_record_spans')
        .update({ end_t_ms: endTms }, { count: 'exact' })
        .eq('session_id', sessionId)
        .is('end_t_ms', null);
      if (error) throw new Error(`close off-record spans: ${error.message}`);
      return count ?? 0;
    },

    async deleteCaptureSince(session, cutoffTms) {
      // Keyframe images first: once the rows are gone we no longer know their paths.
      const frames = unwrap(
        await db
          .from('keyframes')
          .select('storage_path')
          .eq('session_id', session.id)
          .gte('t_ms', cutoffTms)
          .returns<{ storage_path: string }[]>(),
        'list keyframes',
      );
      const paths = (frames ?? []).map((f) => f.storage_path.replace(new RegExp(`^${CAPTURES_BUCKET}/`), ''));
      if (paths.length > 0) {
        const { error } = await db.storage.from(CAPTURES_BUCKET).remove(paths);
        if (error) throw new Error(`remove keyframe images: ${error.message}`);
      }

      const counts = {} as Record<CaptureTable, number>;
      for (const [table, column] of Object.entries(CAPTURE_T_MS) as [CaptureTable, string][]) {
        const { count, error } = await db
          .from(table)
          .delete({ count: 'exact' })
          .eq('session_id', session.id)
          .gte(column, cutoffTms);
        if (error) throw new Error(`delete ${table}: ${error.message}`);
        counts[table] = count ?? 0;
      }
      return counts;
    },
  };
}
